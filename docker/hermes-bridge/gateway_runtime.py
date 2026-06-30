"""
gateway_runtime.py — supervise `hermes gateway run` subprocess.

The Hermes channel runtime (Telegram polling, WhatsApp Baileys, Discord
WS, Slack socket, etc.) lives in a SEPARATE process from the TUI gateway
that `hermes_client.py` already supervises:

  - `python -m tui_gateway.entry`  — JSON-RPC dispatcher for chat/sessions
                                     (one bridge-spawned subprocess)
  - `hermes gateway run`           — long-running channel connector pool
                                     (THIS module supervises it)

Both must be running concurrently for a fully functional AgentBuff
container: the TUI gateway serves `/app` browser chat; the gateway
runtime serves Telegram/WA/Discord/Slack inbound messages.

Lifecycle:
  - Started by `agentbuff_bridge.py` at boot (after config.yaml seeded)
  - Inherits container env (HERMES_HOME, model API keys, etc.)
  - Auto-respawn with exponential backoff (channels need uptime)
  - Stderr forwarded to bridge log (for "[telegram] Inbound message ..." lines)
  - Reads channel config from config.yaml via SIGHUP / RFC-7396 patches
    that the bridge's config_handler writes there
  - Graceful stop on bridge shutdown (SIGTERM → drain → kill if no exit
    in 5s)

Design notes:
  - Independent of HermesClient (channel runtime doesn't speak JSON-RPC
    over stdio — it talks to platform APIs directly). No request/response
    correlation needed.
  - Stays alive even if the TUI gateway dies; channel messages still
    enqueue and persist. When TUI gateway recovers, bridge replays.
  - Disabled by env `HERMES_GATEWAY_RUNTIME_DISABLED=1` for dev (when
    you only want to test chat without firing up real Telegram/WA).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


log = logging.getLogger("bridge.gateway_runtime")


RESPAWN_BACKOFF_INITIAL_S = 2.0
RESPAWN_BACKOFF_MAX_S = 60.0
GRACEFUL_STOP_TIMEOUT_S = 5.0


@dataclass
class GatewayRuntimeConfig:
    """Configuration for spawning + supervising the Hermes gateway runtime."""

    # Command to spawn. Default = `hermes gateway run` (foreground mode —
    # bridge supervises, no systemd needed).
    command: list[str] = field(
        default_factory=lambda: ["hermes", "gateway", "run"],
    )

    # Working directory for the subprocess. Defaults to HERMES_HOME so the
    # runtime finds config.yaml + credentials in the same place the bridge
    # uses.
    cwd: Optional[Path] = None

    # Extra env vars to add/override
    extra_env: dict[str, str] = field(default_factory=dict)


class GatewayRuntimeError(Exception):
    """Raised when the gateway runtime subprocess fails fatally."""


class GatewayRuntime:
    """Long-running supervisor for `hermes gateway run`.

    Usage:
        runtime = GatewayRuntime(config)
        await runtime.start()        # spawns subprocess + supervisor task
        ...
        await runtime.stop()         # graceful shutdown

    Properties:
        is_alive: True iff subprocess is up
        restarts: count of how many times we've respawned (debug/observability)
    """

    def __init__(self, config: Optional[GatewayRuntimeConfig] = None) -> None:
        self._config = config or GatewayRuntimeConfig()
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._supervisor_task: Optional[asyncio.Task] = None
        self._stopping: bool = False
        self._spawn_lock: asyncio.Lock = asyncio.Lock()
        self.restarts: int = 0

    @property
    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        """Spawn the subprocess and start the supervisor loop. Idempotent."""
        if self._proc and self._proc.returncode is None:
            return

        async with self._spawn_lock:
            if self._proc and self._proc.returncode is None:
                return
            await self._spawn_once()

        if self._supervisor_task is None or self._supervisor_task.done():
            self._supervisor_task = asyncio.create_task(
                self._supervise(),
                name="gateway-runtime-supervisor",
            )

    async def restart(self) -> None:
        """Kill the subprocess and respawn immediately (no backoff).

        Used after a config.yaml mutation so the channel runtime picks up
        the new tokens straight away. Supervisor loop is preserved — only
        the subprocess churns.
        """
        if self._proc and self._proc.returncode is None:
            log.info("gateway_runtime: restart requested")
            try:
                self._proc.terminate()
                try:
                    await asyncio.wait_for(
                        self._proc.wait(), timeout=GRACEFUL_STOP_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    log.warning(
                        "gateway_runtime: terminate timed out, killing",
                    )
                    self._proc.kill()
                    await self._proc.wait()
            except ProcessLookupError:
                pass
        # The supervisor task will notice the exit and respawn (initial
        # backoff = 2s). For an explicit user-initiated restart, that's
        # acceptable — channels were already down during the stop window.

    async def stop(self, timeout: float = GRACEFUL_STOP_TIMEOUT_S) -> None:
        """Stop the subprocess gracefully (SIGTERM → wait → SIGKILL)."""
        self._stopping = True

        if self._supervisor_task and not self._supervisor_task.done():
            self._supervisor_task.cancel()
            try:
                await self._supervisor_task
            except asyncio.CancelledError:
                pass

        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    log.warning(
                        "gateway_runtime: subprocess didn't exit after %.1fs, killing",
                        timeout,
                    )
                    self._proc.kill()
                    await self._proc.wait()
            except ProcessLookupError:
                pass

        log.info("gateway_runtime: stopped")

    async def _spawn_once(self) -> None:
        """Spawn the channel runtime subprocess. Caller holds _spawn_lock."""
        cmd = list(self._config.command)
        if cmd and not Path(cmd[0]).is_absolute():
            resolved = shutil.which(cmd[0])
            if resolved:
                cmd[0] = resolved

        cwd = self._config.cwd
        if cwd is None:
            hermes_home = os.environ.get("HERMES_HOME")
            cwd = Path(hermes_home) if hermes_home else Path.home() / ".hermes"
        cwd.mkdir(parents=True, exist_ok=True)

        env = dict(os.environ)
        env.update(self._config.extra_env)
        env["PYTHONUNBUFFERED"] = "1"
        # `hermes gateway run` writes ANSI-coloured status to stderr.
        # Disable so the bridge log stays readable when forwarded.
        env.setdefault("NO_COLOR", "1")

        log.info(
            "gateway_runtime: spawning %r (cwd=%s)",
            " ".join(cmd),
            cwd,
        )

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
                env=env,
            )
        except FileNotFoundError as e:
            raise GatewayRuntimeError(
                f"failed to spawn gateway runtime: command not found "
                f"({cmd[0]!r}). Is hermes-agent installed?",
            ) from e
        except Exception as e:
            raise GatewayRuntimeError(
                f"failed to spawn gateway runtime: {e}",
            ) from e

        log.info("gateway_runtime: spawned pid=%s", self._proc.pid)

        # Forward stdout + stderr to bridge log
        asyncio.create_task(
            self._stream_logger(self._proc.stdout, "stdout"),
            name="gateway-runtime-stdout",
        )
        asyncio.create_task(
            self._stream_logger(self._proc.stderr, "stderr"),
            name="gateway-runtime-stderr",
        )

    async def _stream_logger(
        self,
        stream: Optional[asyncio.StreamReader],
        label: str,
    ) -> None:
        """Forward subprocess stdout/stderr lines into the bridge logger."""
        if stream is None:
            return
        try:
            while True:
                line = await stream.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace").rstrip()
                if not text:
                    continue
                # Tag every line so it's clear they're from the channel runtime
                # (the bridge's tui_gateway subprocess emits stderr lines too).
                log.info("[hermes-gateway] %s", text)
                # Capture raw provider failures from the CHANNEL runtime too, so
                # outbound channel error replies can be localized accurately.
                if label == "stderr":
                    try:
                        import provider_errors
                        provider_errors.record(text)
                    except Exception:
                        pass
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("gateway_runtime: stream logger crashed (%s)", label)

    async def _supervise(self) -> None:
        """Watch subprocess exit and respawn with exponential backoff."""
        backoff = RESPAWN_BACKOFF_INITIAL_S
        while not self._stopping:
            try:
                if self._proc is None:
                    await asyncio.sleep(0.5)
                    continue

                returncode = await self._proc.wait()
                if self._stopping:
                    return

                log.warning(
                    "gateway_runtime: subprocess exited code=%s, respawning in %.1fs",
                    returncode,
                    backoff,
                )
                self.restarts += 1
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RESPAWN_BACKOFF_MAX_S)

                if self._stopping:
                    return

                async with self._spawn_lock:
                    await self._spawn_once()

                # On successful respawn, reset backoff
                backoff = RESPAWN_BACKOFF_INITIAL_S

            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("gateway_runtime: supervisor crashed; retrying")
                await asyncio.sleep(backoff)
