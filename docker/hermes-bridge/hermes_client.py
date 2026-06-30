"""
hermes_client.py — JSON-RPC 2.0 client to Hermes TUI Gateway subprocess.

Hermes' tui_gateway/server.py speaks JSON-RPC 2.0 over stdin/stdout with
newline-delimited JSON (NDJSON). This client:

  1. Spawns `python -m tui_gateway.server` as an asyncio subprocess
  2. Pipes stdin (we write requests) and stdout (we read responses + events)
  3. Maintains a request ID counter + pending response map
  4. Exposes async `call(method, params)` that resolves when the response arrives
  5. Exposes `on_event(handler)` for unsolicited notifications (streaming deltas)
  6. Supervises the subprocess (auto-respawn with exponential backoff)
  7. Graceful shutdown that drains pending requests with timeout

Design rationale:
  - asyncio (not threading) so single event loop owns everything cleanly
  - Per-request Future correlation (no callback hell)
  - Bounded queues to prevent runaway memory on event flood
  - Subprocess supervision because Hermes can crash (and we want bridge
    to survive without killing all open WS clients)

OpenClaw G2 equivalence (streaming deltas are unsolicited events):
  - Hermes emits `prompt.streamed` notifications between request/response
  - Client passes those to on_event handler; main bridge translates them
  - DO NOT correlate notifications to requests (no id field) — broadcast
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional


log = logging.getLogger("bridge.hermes_client")


# How long to wait for Hermes to respond to a single RPC.
# Long handlers (session.compress, slash.exec, browser.manage, cli.exec,
# session.resume, session.branch, shell.exec, skills.manage) get longer.
DEFAULT_TIMEOUT_S = 30.0
LONG_HANDLER_METHODS = frozenset({
    "session.compress",
    "slash.exec",
    "cli.exec",
    "browser.manage",
    "session.resume",
    "session.branch",
    "shell.exec",
    "skills.manage",
    "skills.reload",
})
LONG_TIMEOUT_S = 300.0  # 5 minutes for the heaviest jobs

# Max pending requests before we refuse new ones (backpressure).
MAX_PENDING_REQUESTS = 256

# Max event queue depth before we drop oldest events to prevent OOM.
# Streaming a long reply can produce hundreds of `prompt.streamed` notifications.
MAX_EVENT_QUEUE = 1024

# StreamReader line-buffer limit for the gateway's stdout (NDJSON). The asyncio
# default is 64 KB; Hermes 0.15.x can emit single NDJSON lines larger than that
# (big tool catalogs, agent-build events, live-activity frames). When a line
# exceeds the limit, `readline()` raises LimitOverrunError and the read loop
# dies — silently wedging EVERY in-flight RPC (e.g. tools.catalog, cron.list
# time out at 30 s while chat still works). 64 MB is far above any real line.
STDOUT_BUFFER_LIMIT = 64 * 1024 * 1024

# Subprocess respawn backoff
RESPAWN_BACKOFF_INITIAL_S = 1.0
RESPAWN_BACKOFF_MAX_S = 60.0


@dataclass
class HermesClientConfig:
    """Configuration for spawning + connecting to Hermes subprocess.

    The entry point is `tui_gateway.entry` (NOT `tui_gateway.server`).
    `entry.py` wraps `server.py` with signal handlers, sidecar publisher,
    MCP tool discovery, and emits the initial `gateway.ready` event.
    Invoking `server` directly skips startup hooks and exits immediately
    on empty stdin.

    `HERMES_PYTHON_SRC_ROOT` must point to the directory containing the
    `hermes_cli` package (site-packages in the container). `entry.py`
    inserts it into sys.path so transitive imports like `tools.mcp_tool`
    resolve correctly.
    """

    # Command to spawn. We use a thin wrapper `bootstrap_tui_gateway` that
    # force-loads Hermes plugins (so the agentbuff-multimodal patches —
    # STT chain, vision chain, gTTS monkey-patch — take effect) BEFORE
    # handing off to the real `tui_gateway.entry`. The default lazy plugin
    # discovery in tui_gateway misses standalone (no-toolset) plugins,
    # which leaves text_to_speech routed at the broken edge-tts code path.
    # See `bootstrap_tui_gateway.py` for the full rationale.
    command: list[str] = field(
        default_factory=lambda: [
            "python", "-u", "-m", "bootstrap_tui_gateway",
        ],
    )

    # Working directory for the subprocess. Defaults to HERMES_HOME.
    # Subprocess inherits env, so HERMES_HOME etc propagate automatically.
    cwd: Optional[Path] = None

    # Extra env vars to add/override
    extra_env: dict[str, str] = field(default_factory=dict)


class HermesProcessError(Exception):
    """Raised when Hermes subprocess fails (spawn failed, crashed, etc)."""


class HermesRpcError(Exception):
    """Raised when Hermes returns a JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"Hermes RPC error {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class HermesClient:
    """Manages a running Hermes TUI Gateway subprocess + RPC client.

    Lifecycle:
        client = HermesClient(config)
        await client.start()           # spawn subprocess, start workers
        result = await client.call("session.list", {})
        client.on_event(handler)       # register event listener
        await client.stop()            # graceful shutdown
    """

    def __init__(self, config: Optional[HermesClientConfig] = None) -> None:
        self._config = config or HermesClientConfig()
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._supervisor_task: Optional[asyncio.Task] = None
        self._next_id: int = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._event_handlers: list[Callable[[dict], Awaitable[None]]] = []
        self._stopping: bool = False
        self._started: asyncio.Event = asyncio.Event()
        # Lock for write to stdin (multiple coros may want to send concurrently)
        self._write_lock: asyncio.Lock = asyncio.Lock()
        # Lock for spawning (supervisor + start() can't race)
        self._spawn_lock: asyncio.Lock = asyncio.Lock()

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------

    async def start(self) -> None:
        """Spawn Hermes subprocess and start workers. Idempotent."""
        if self._proc and self._proc.returncode is None:
            return  # already running

        async with self._spawn_lock:
            if self._proc and self._proc.returncode is None:
                return

            await self._spawn_once()

        # Start supervisor (auto-respawn on crash)
        if self._supervisor_task is None or self._supervisor_task.done():
            self._supervisor_task = asyncio.create_task(
                self._supervise_subprocess(),
                name="hermes-supervisor",
            )

        # Wait for first successful spawn signal
        await self._started.wait()
        log.info("hermes_client: started successfully")

    async def stop(self, timeout: float = 10.0) -> None:
        """Graceful shutdown. Cancels pending requests, kills subprocess."""
        self._stopping = True

        # Cancel supervisor first so it doesn't respawn during shutdown
        if self._supervisor_task and not self._supervisor_task.done():
            self._supervisor_task.cancel()
            try:
                await self._supervisor_task
            except (asyncio.CancelledError, Exception):
                pass

        # Cancel reader
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass

        # Fail all pending requests
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(HermesProcessError("bridge shutting down"))
        self._pending.clear()

        # Terminate subprocess
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    log.warning("hermes_client: subprocess didn't exit, killing")
                    self._proc.kill()
                    await self._proc.wait()
            except ProcessLookupError:
                pass

        log.info("hermes_client: stopped")

    async def call(
        self,
        method: str,
        params: Optional[dict] = None,
        *,
        timeout: Optional[float] = None,
    ) -> Any:
        """Send JSON-RPC request and await response.

        Returns the `result` field of the response.
        Raises HermesRpcError if Hermes returns an error response.
        Raises HermesProcessError if subprocess died.
        Raises asyncio.TimeoutError if no response within timeout.
        """
        if self._stopping:
            raise HermesProcessError("bridge is shutting down")
        if self._proc is None or self._proc.returncode is not None:
            raise HermesProcessError("Hermes subprocess not running")

        # Backpressure: if too many requests pending, refuse new ones
        if len(self._pending) >= MAX_PENDING_REQUESTS:
            raise HermesProcessError(
                f"too many pending requests ({len(self._pending)}); "
                "Hermes may be wedged",
            )

        # Resolve timeout
        if timeout is None:
            timeout = (
                LONG_TIMEOUT_S
                if method in LONG_HANDLER_METHODS
                else DEFAULT_TIMEOUT_S
            )

        # Allocate request id + future
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut

        # Build JSON-RPC 2.0 envelope
        envelope = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params is not None:
            envelope["params"] = params

        # Send
        try:
            await self._send_line(envelope)
        except Exception:
            self._pending.pop(req_id, None)
            raise

        # Await response
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            log.error(
                "hermes_client: timeout after %.1fs on method=%s id=%s",
                timeout, method, req_id,
            )
            raise

    def on_event(
        self,
        handler: Callable[[dict], Awaitable[None]],
    ) -> Callable[[], None]:
        """Register handler for unsolicited Hermes notifications.

        Handler receives the full JSON-RPC notification dict:
            {"jsonrpc": "2.0", "method": "prompt.streamed", "params": {...}}

        Returns an unsubscribe function.

        Per OpenClaw G2: this is the PERMANENT listener for streaming
        events. The bridge subscribes once at startup and never
        unsubscribes during normal operation. Per-request scoped handlers
        would lose deltas that arrive after the response.
        """
        self._event_handlers.append(handler)

        def _unsubscribe() -> None:
            try:
                self._event_handlers.remove(handler)
            except ValueError:
                pass

        return _unsubscribe

    @property
    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    # -----------------------------------------------------------------
    # Internal
    # -----------------------------------------------------------------

    async def _spawn_once(self) -> None:
        """Spawn the subprocess. Caller holds _spawn_lock."""
        # Resolve command — first arg might be "python" but we want full path
        cmd = list(self._config.command)
        if cmd and not Path(cmd[0]).is_absolute():
            resolved = shutil.which(cmd[0])
            if resolved:
                cmd[0] = resolved

        # Resolve cwd
        cwd = self._config.cwd
        if cwd is None:
            hermes_home = os.environ.get("HERMES_HOME")
            cwd = Path(hermes_home) if hermes_home else Path.home() / ".hermes"
        cwd.mkdir(parents=True, exist_ok=True)

        # Build env (inherit + overlay)
        env = dict(os.environ)
        env.update(self._config.extra_env)
        # Force unbuffered Python stdio (-u already in command, but also via env)
        env["PYTHONUNBUFFERED"] = "1"

        log.info(
            "hermes_client: spawning %r (cwd=%s)",
            " ".join(cmd), cwd,
        )

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
                env=env,
                # Raise the NDJSON line-buffer well above asyncio's 64 KB default
                # so a large gateway stdout line can't crash the read loop.
                limit=STDOUT_BUFFER_LIMIT,
            )
        except FileNotFoundError as e:
            raise HermesProcessError(
                f"failed to spawn Hermes subprocess: command not found "
                f"({cmd[0]!r}). Is hermes-agent installed?",
            ) from e
        except Exception as e:
            raise HermesProcessError(
                f"failed to spawn Hermes subprocess: {e}",
            ) from e

        log.info("hermes_client: spawned pid=%s", self._proc.pid)

        # Start reader task
        self._reader_task = asyncio.create_task(
            self._read_loop(),
            name="hermes-reader",
        )

        # Start stderr logger (Hermes may log warnings/errors there)
        asyncio.create_task(
            self._stderr_logger(),
            name="hermes-stderr",
        )

        self._started.set()

    async def _supervise_subprocess(self) -> None:
        """Watch for subprocess exit and respawn with exponential backoff."""
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
                    "hermes_client: subprocess exited code=%s, respawning in %.1fs",
                    returncode, backoff,
                )

                # Fail all pending so callers don't hang
                for fut in list(self._pending.values()):
                    if not fut.done():
                        fut.set_exception(
                            HermesProcessError(
                                f"Hermes subprocess crashed (exit {returncode})",
                            ),
                        )
                self._pending.clear()

                self._started.clear()
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
                log.exception("hermes_client: supervisor crashed; retrying")
                await asyncio.sleep(backoff)

    async def _read_loop(self) -> None:
        """Read NDJSON lines from Hermes stdout and dispatch."""
        assert self._proc is not None
        stdout = self._proc.stdout
        if stdout is None:
            return

        try:
            while True:
                try:
                    line = await stdout.readline()
                except (asyncio.LimitOverrunError, ValueError) as e:
                    # A single NDJSON line exceeded STDOUT_BUFFER_LIMIT. Do NOT
                    # let this kill the read loop (that wedges every in-flight
                    # RPC). Drain the offending line to the next newline so the
                    # stream resyncs, then keep going.
                    log.warning(
                        "hermes_client: oversized stdout line, draining + skipping (%s)",
                        e,
                    )
                    await self._drain_oversized_line(stdout)
                    continue
                if not line:
                    # EOF — subprocess closed stdout
                    log.warning("hermes_client: stdout EOF")
                    return

                try:
                    msg = json.loads(line.decode("utf-8").strip())
                except json.JSONDecodeError as e:
                    # Hermes may print non-JSON to stdout (banners, etc).
                    # Log + skip rather than crash.
                    log.warning(
                        "hermes_client: non-JSON stdout line: %r (%s)",
                        line[:200], e,
                    )
                    continue

                await self._dispatch_message(msg)

        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("hermes_client: read_loop crashed")

    @staticmethod
    async def _drain_oversized_line(stream: asyncio.StreamReader) -> None:
        """Discard bytes up to (and including) the next newline.

        Called after readline() raised LimitOverrunError so the next readline()
        starts cleanly on a fresh line instead of re-raising forever. Best-effort:
        reads buffer-sized chunks until a newline is consumed or EOF.
        """
        while True:
            try:
                await stream.readuntil(b"\n")
                return
            except asyncio.IncompleteReadError:
                return  # EOF before newline
            except (asyncio.LimitOverrunError, ValueError):
                # Still no newline within the limit — drop a buffer's worth and retry.
                try:
                    chunk = await stream.read(STDOUT_BUFFER_LIMIT)
                except Exception:
                    return
                if not chunk:
                    return

    async def _dispatch_message(self, msg: dict) -> None:
        """Route a parsed JSON-RPC message to response future or event handlers."""
        if not isinstance(msg, dict):
            log.warning("hermes_client: discarding non-dict message: %r", msg)
            return

        msg_id = msg.get("id")
        if msg_id is not None:
            # Response (success or error)
            fut = self._pending.pop(msg_id, None)
            if fut is None:
                log.warning(
                    "hermes_client: response for unknown id=%s (timed out?)",
                    msg_id,
                )
                return

            if fut.done():
                return  # cancelled or already resolved

            if "error" in msg:
                err = msg["error"] or {}
                fut.set_exception(
                    HermesRpcError(
                        code=err.get("code", -32000),
                        message=err.get("message", "unknown Hermes error"),
                        data=err.get("data"),
                    ),
                )
            else:
                fut.set_result(msg.get("result"))
            return

        # Notification (no id)
        method = msg.get("method")
        if not method:
            log.warning("hermes_client: discarding message without id or method: %r", msg)
            return

        # Fan out to all handlers (gather so one slow handler doesn't block others)
        # Per OpenClaw G5: bridge layer accumulates deltas; handlers should be fast.
        if not self._event_handlers:
            return

        for handler in list(self._event_handlers):
            try:
                # Schedule rather than await — handlers run concurrently and
                # bridge translator decides ordering at the WS broadcast layer
                asyncio.create_task(handler(msg), name=f"hermes-event:{method}")
            except Exception:
                log.exception("hermes_client: event handler raised")

    async def _stderr_logger(self) -> None:
        """Forward Hermes stderr to bridge log (for debugging)."""
        assert self._proc is not None
        stderr = self._proc.stderr
        if stderr is None:
            return

        try:
            while True:
                line = await stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    log.info("[hermes-stderr] %s", text)
                    # Capture raw provider failures (credit/quota/auth/rate/
                    # overload) so the translator can turn them into a clear
                    # layperson Bahasa message instead of the engine's coarse
                    # "rate-limiting" template. Best-effort, never fatal.
                    try:
                        import provider_errors
                        provider_errors.record(text)
                    except Exception:
                        pass
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("hermes_client: stderr_logger crashed")

    async def _send_line(self, envelope: dict) -> None:
        """Serialize + send one NDJSON line to Hermes stdin."""
        assert self._proc is not None
        stdin = self._proc.stdin
        if stdin is None or stdin.is_closing():
            raise HermesProcessError("Hermes stdin closed")

        # JSON encode + newline
        try:
            data = (json.dumps(envelope, separators=(",", ":")) + "\n").encode("utf-8")
        except (TypeError, ValueError) as e:
            raise HermesProcessError(f"failed to JSON-encode envelope: {e}") from e

        async with self._write_lock:
            try:
                stdin.write(data)
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as e:
                raise HermesProcessError(f"Hermes stdin write failed: {e}") from e
