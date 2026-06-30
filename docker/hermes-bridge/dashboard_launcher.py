"""
dashboard_launcher.py — wrapper that pins `_SESSION_TOKEN` before starting
the Hermes dashboard server.

Problem this solves:
  Hermes' `hermes dashboard` CLI generates a fresh random `_SESSION_TOKEN`
  at every subprocess start (see `hermes_cli/web_server.py:86`). Whenever
  the dashboard subprocess respawns — which happens on container restart,
  on channels.pair (we restart gateway runtime, which may indirectly
  bounce the dashboard), or on image upgrade — the token rotates. Any
  browser tab the operator already opened keeps the OLD token cached
  inside `window.__HERMES_SESSION_TOKEN__`, so:
    - /api/ws (model sidebar) sees an invalid token, WS closes with 4401 →
      pill goes from "LIVE" to "CLOSED"
    - /api/events refuses with 4401 → "events feed disconnected" banner
    - /api/model/options returns 401 → ModelPickerDialog shows
      "401 DETAIL UNAUTHORIZED"

  None of this is real auth failure; it's just stale ephemeral state.

Fix:
  We inject a stable token at process start by monkey-patching
  `web_server._SESSION_TOKEN` BEFORE uvicorn binds. The token source is
  the container's `BRIDGE_TOKEN` env var, which:
    1. Is deterministic per container (DB-backed, written by portal's
       provisionContainer at provision time).
    2. Survives subprocess restart (env var is set by entrypoint.sh).
    3. Survives container restart (DB row holds the same token).
    4. Is sufficiently random (32+ bytes urlsafe per Postgres column
       generation).

  After this patch, the dashboard tab survives any restart short of
  container destroy + re-provision (which rotates BRIDGE_TOKEN).

Security:
  - Loopback-only port publish (`-p 127.0.0.1:<port>:9119`) is still
    the actual isolation boundary. Dashboard token rotation was never
    the primary defense; it was a defense-in-depth layer that came at
    the cost of UX. We're trading that for sane UX, which is fine
    because (a) loopback is unreachable from outside the host, (b)
    ICC=off bridge isolates containers from each other, (c) the same
    BRIDGE_TOKEN authenticates the portal's WS proxy, so re-using
    it doesn't expand the attack surface.
  - Different containers still have different tokens (provisioner
    rotates per-user), so cross-tenant access is impossible.

  If you ever expose the dashboard publicly (don't!), revert this and
  fall back to ephemeral tokens + frontend auto-refresh on 401.
"""

from __future__ import annotations

import inspect
import logging
import os
import sys


def _resolve_token() -> str:
    """Pick the stable token. Prefer BRIDGE_TOKEN (container-scoped).

    Falls back to a fresh random token if BRIDGE_TOKEN is missing for
    some reason — equivalent to vanilla Hermes behavior so we never
    break startup.
    """
    tok = os.environ.get("HERMES_DASHBOARD_TOKEN") or os.environ.get("BRIDGE_TOKEN")
    if tok and len(tok) >= 16:
        return tok
    import secrets
    fresh = secrets.token_urlsafe(32)
    logging.getLogger("dashboard_launcher").warning(
        "BRIDGE_TOKEN not available; falling back to ephemeral token "
        "(dashboard tab will need refresh on subprocess restart).",
    )
    return fresh


def _patch_session_token() -> None:
    """Replace `web_server._SESSION_TOKEN` with our stable value."""
    log = logging.getLogger("dashboard_launcher")
    try:
        from hermes_cli import web_server  # noqa: F401  (side-effect: registers module)
    except Exception:
        log.exception("failed to import hermes_cli.web_server")
        raise

    stable = _resolve_token()
    web_server._SESSION_TOKEN = stable  # type: ignore[attr-defined]
    log.info(
        "dashboard session token pinned (length=%d, prefix=%s...)",
        len(stable), stable[:8],
    )


def _load_hermes_env() -> None:
    """Load ~/.hermes/.env into os.environ BEFORE web_server import.

    `hermes dashboard` CLI command does this via hermes_cli/main.py's
    setup() function. Since we bypass the CLI entry point and import
    web_server directly, we must mirror that behavior. Without it,
    `gateway.config.load_gateway_config()` sees no TELEGRAM_BOT_TOKEN
    in environ → reports `connected_platforms: []` → dashboard's
    /api/status shows `platforms: {}` even though the gateway runtime
    is actively polling Telegram in another subprocess.

    Uses Hermes' own loader (`hermes_cli.env_loader.load_hermes_dotenv`)
    so our env-precedence matches the rest of Hermes exactly — same
    precedence rules (existing env wins), same parser, same .env path
    resolution. `tui_gateway/server.py:32` does the equivalent call.
    """
    from pathlib import Path
    log = logging.getLogger("dashboard_launcher")
    try:
        from hermes_cli.env_loader import load_hermes_dotenv
    except Exception:
        log.exception("hermes_cli.env_loader unavailable; skipping .env load")
        return
    hermes_home = Path(
        os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    )
    try:
        load_hermes_dotenv(hermes_home=hermes_home)
        log.info(
            "dashboard_launcher: loaded .env from %s",
            hermes_home / ".env",
        )
    except Exception:
        log.exception("load_hermes_dotenv failed")


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)-7s %(name)-30s %(message)s",
    )

    _load_hermes_env()
    _patch_session_token()

    # Reproduce `hermes dashboard --skip-build --no-open --host 0.0.0.0
    # --port 9119 --insecure --tui` directly via start_server() — the
    # CLI parser path goes through hermes_cli/cli.py and re-imports
    # web_server in the same process anyway, so calling start_server()
    # ourselves is equivalent.
    from hermes_cli.web_server import start_server

    host = os.environ.get("HERMES_DASHBOARD_HOST", "0.0.0.0")
    port = int(os.environ.get("HERMES_DASHBOARD_PORT_INSIDE", "9119"))
    embedded_chat = os.environ.get("HERMES_DASHBOARD_TUI", "1") in {"1", "true", "yes"}

    kwargs = {
        "host": host,
        "port": port,
        "open_browser": False,
        "allow_public": True,  # equivalent to --insecure; required for 0.0.0.0 bind
    }
    # `embedded_chat` was a start_server() kwarg on Hermes <=0.15.2; it was
    # removed in 0.16.0 (embedded chat is no longer toggled here). Pass it only
    # when the installed engine still accepts it, so the launcher works across
    # the version bump without crash-looping on TypeError.
    try:
        if "embedded_chat" in inspect.signature(start_server).parameters:
            kwargs["embedded_chat"] = embedded_chat
    except (ValueError, TypeError):
        pass

    start_server(**kwargs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
