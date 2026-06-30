"""
dashboard_runtime.py — supervise `hermes dashboard` subprocess.

Hermes ships a native admin web UI ("Hermes dashboard") on port 9119
that the operator can use to:
  - View / edit ~/.hermes/config.yaml + ~/.hermes/.env
  - Manage skills, plugins, MCP servers
  - Browse sessions / cron jobs / memory
  - (Optional) embedded chat tab via PTY (HERMES_DASHBOARD_TUI=1 → `--tui`)

The portal's /app surface covers the consumer-facing UX (Chat, Saluran,
Agen, Skill, Konfigurasi, ...). This dashboard is the raw Hermes panel
chief uses to inspect engine state directly + compare /app feature
coverage. /loby redirects to it when a container is running, mirroring
the way /loby used to redirect to OpenClaw's per-port Lit UI.

Auth model:
  - Dashboard generates an ephemeral `_SESSION_TOKEN` at startup (random
    32-byte urlsafe). Index HTML serves the token inline as
    `window.__HERMES_SESSION_TOKEN__`, so the browser auths transparently
    on first visit — no login page.
  - Token rotates whenever the subprocess respawns. Existing browser tabs
    silently re-fetch index on next navigation.

Why `--insecure`:
  - Dashboard refuses non-loopback bind by default. We need 0.0.0.0 INSIDE
    the container so Docker can publish the port to host loopback (which
    is the actual external boundary). The flag bypasses the in-process
    check; Docker's `-p 127.0.0.1:<port>:9119` is what really enforces
    isolation.

Disabled via env: HERMES_DASHBOARD_DISABLED=1
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


log = logging.getLogger("bridge.dashboard_runtime")


RESPAWN_BACKOFF_INITIAL_S = 2.0
RESPAWN_BACKOFF_MAX_S = 60.0
GRACEFUL_STOP_TIMEOUT_S = 5.0


@dataclass
class DashboardRuntimeConfig:
    """Configuration for spawning + supervising `hermes dashboard`."""

    # Command to spawn. We run our own `dashboard_launcher.py` instead of
    # `hermes dashboard` directly so we can pin `_SESSION_TOKEN` to the
    # container's stable BRIDGE_TOKEN BEFORE uvicorn binds. The launcher
    # imports hermes_cli.web_server, monkey-patches the token, then calls
    # start_server() — net behaviour is identical to `hermes dashboard
    # --skip-build --no-open --host 0.0.0.0 --port 9119 --insecure --tui`
    # except the token survives subprocess restart, so browser tabs the
    # operator already opened don't get bricked on every redeploy.
    # See dashboard_launcher.py docstring for full rationale.
    command: list[str] = field(
        default_factory=lambda: [
            "python", "-u", "/app/bridge/dashboard_launcher.py",
        ],
    )

    # Working directory. Default = HERMES_HOME so dashboard finds
    # config.yaml + .env + agents/ via the standard lookup.
    cwd: Optional[Path] = None

    extra_env: dict[str, str] = field(default_factory=dict)


class DashboardRuntimeError(Exception):
    """Raised when the dashboard subprocess fails fatally."""


class DashboardRuntime:
    """Long-running supervisor for `hermes dashboard`.

    Lifecycle mirrors gateway_runtime.GatewayRuntime — both wrap a
    long-running channel adapter / web server that needs auto-respawn
    on crash but otherwise stays alive for the container lifetime.
    """

    def __init__(self, config: Optional[DashboardRuntimeConfig] = None) -> None:
        self._config = config or DashboardRuntimeConfig()
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._supervisor_task: Optional[asyncio.Task] = None
        self._stopping: bool = False
        self._spawn_lock: asyncio.Lock = asyncio.Lock()
        self.restarts: int = 0

    @property
    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        """Spawn + start supervisor. Idempotent."""
        if self._proc and self._proc.returncode is None:
            return

        async with self._spawn_lock:
            if self._proc and self._proc.returncode is None:
                return
            await self._spawn_once()

        if self._supervisor_task is None or self._supervisor_task.done():
            self._supervisor_task = asyncio.create_task(
                self._supervise(),
                name="dashboard-runtime-supervisor",
            )

    async def stop(self, timeout: float = GRACEFUL_STOP_TIMEOUT_S) -> None:
        """SIGTERM → wait → SIGKILL."""
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
                        "dashboard_runtime: subprocess didn't exit after %.1fs, killing",
                        timeout,
                    )
                    self._proc.kill()
                    await self._proc.wait()
            except ProcessLookupError:
                pass

        log.info("dashboard_runtime: stopped")

    async def _spawn_once(self) -> None:
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
        env.setdefault("NO_COLOR", "1")
        # Enable the embedded chat tab by default. Chief uses the
        # dashboard primarily to compare with /app — embedded chat
        # makes that comparison apples-to-apples.
        env.setdefault("HERMES_DASHBOARD_TUI", "1")

        log.info(
            "dashboard_runtime: spawning %r (cwd=%s)",
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
            raise DashboardRuntimeError(
                f"failed to spawn hermes dashboard: command not found "
                f"({cmd[0]!r}). Is hermes-agent[web] installed?",
            ) from e
        except Exception as e:
            raise DashboardRuntimeError(
                f"failed to spawn hermes dashboard: {e}",
            ) from e

        log.info("dashboard_runtime: spawned pid=%s", self._proc.pid)

        asyncio.create_task(
            self._stream_logger(self._proc.stdout, "stdout"),
            name="dashboard-runtime-stdout",
        )
        asyncio.create_task(
            self._stream_logger(self._proc.stderr, "stderr"),
            name="dashboard-runtime-stderr",
        )

    async def _stream_logger(
        self,
        stream: Optional[asyncio.StreamReader],
        label: str,
    ) -> None:
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
                log.info("[hermes-dashboard] %s", text)
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("dashboard_runtime: stream logger crashed (%s)", label)

    async def _supervise(self) -> None:
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
                    "dashboard_runtime: subprocess exited code=%s, respawning in %.1fs",
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

                backoff = RESPAWN_BACKOFF_INITIAL_S

            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("dashboard_runtime: supervisor crashed; retrying")
                await asyncio.sleep(backoff)
