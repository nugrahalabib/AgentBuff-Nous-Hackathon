"""
interactive_bridge.py — Make Hermes emit wire events for `clarify_tool`
(and similar interactive primitives) so the /app web UI can render
button cards just like Telegram/Discord channels do.

Why this exists:
  Hermes' `tui_gateway/server.py:1944` registers a notify callback for
  `tools.approval.register_gateway_notify` so approval requests get
  emitted on the wire as `approval.request` events. The bridge already
  translates these for /app.

  But for `clarify_tool`, `tui_gateway` registers NO such callback —
  clarify is routed through the platform adapter's `send_clarify`
  method (Telegram/Discord/Slack each implement their own). For
  operator-mode sessions (which is what the bridge uses), no platform
  adapter is registered → `clarify_tool` silently returns "" → /app
  never sees the prompt.

  This module monkey-patches `tools.clarify_gateway.register` to
  ALSO call `register_notify` with a callback that imports
  `tui_gateway.server._emit` lazily (the module is loaded by the time
  any agent runs) and emits a `clarify.request` event on the wire.

  Bridge's `event_translator.py::_translate_clarify_request` already
  exists and forwards the event to /app as a `clarify_request` block.
  /app's `ClarifyRow` renders the interactive UI and calls
  `clarify.respond` RPC on user click — which `tui_gateway/server.py`
  already routes via `tools.clarify_gateway.resolve_gateway_clarify`.

Design notes:
  - Patches `tools.clarify_gateway.register`, NOT `tui_gateway.server`
    (latter is hot-loaded after plugin init, harder to reach).
  - Defensive: any failure inside the wrapped callback is caught + logged.
  - Idempotent via `_PATCHED_SENTINEL` flag.
  - Same wire shape as Telegram/Discord adapters' clarify payload.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Callable

logger = logging.getLogger("agentbuff-multimodal.interactive_bridge")

_PATCHED_SENTINEL = "_agentbuff_interactive_patched"


def _get_emit_fn() -> Callable[..., Any] | None:
    """Lazy-resolve `tui_gateway.server._emit` since this module loads
    BEFORE tui_gateway is imported via the bootstrap wrapper."""
    try:
        from tui_gateway import server as tui_server  # type: ignore
        return getattr(tui_server, "_emit", None)
    except Exception:
        return None


def _resolve_sid_from_session_key(session_key: str) -> str | None:
    """Reverse-lookup the in-memory SID (8-hex) for a canonical
    session_key in `tui_gateway.server._sessions`. tui_gateway's _emit
    uses SID as the routing identifier."""
    try:
        from tui_gateway import server as tui_server  # type: ignore
        sessions = getattr(tui_server, "_sessions", {}) or {}
        for sid, entry in sessions.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("session_key") == session_key:
                return sid
    except Exception:
        pass
    # Fallback: if session_key itself looks like an 8-hex SID, return it
    if isinstance(session_key, str) and len(session_key) == 8:
        return session_key
    return None


def _clarify_entry_to_payload(entry: Any, session_key: str) -> dict:
    """Build the wire payload from a `_ClarifyEntry` dataclass.
    Matches what the bridge's `_translate_clarify_request` expects."""
    return {
        "request_id": getattr(entry, "clarify_id", "") or "",
        "session_key": session_key,
        "question": getattr(entry, "question", "") or "",
        "choices": list(getattr(entry, "choices", None) or []),
    }


def _make_clarify_notify_cb(session_key: str) -> Callable[[Any], None]:
    """Build the per-session clarify notify callback. Defensive — any
    exception is logged but doesn't propagate (would block the agent)."""

    def _cb(entry: Any) -> None:
        try:
            emit = _get_emit_fn()
            if emit is None:
                logger.warning(
                    "interactive_bridge: tui_gateway._emit unavailable — "
                    "clarify wire event NOT emitted (session_key=%s)",
                    session_key,
                )
                return
            sid = _resolve_sid_from_session_key(session_key)
            if not sid:
                logger.warning(
                    "interactive_bridge: cannot resolve SID for session_key=%s "
                    "— clarify wire event NOT emitted",
                    session_key,
                )
                return
            payload = _clarify_entry_to_payload(entry, session_key)
            emit("clarify.request", sid, payload)
            logger.info(
                "interactive_bridge: emitted clarify.request "
                "sid=%s clarify_id=%s choices=%d",
                sid,
                payload["request_id"],
                len(payload.get("choices") or []),
            )
        except Exception:
            logger.exception(
                "interactive_bridge: clarify notify callback crashed",
            )

    return _cb


def install_interactive_patches() -> None:
    """Install the clarify-emit patch on `tools.clarify_gateway.register`.
    Idempotent — re-runs are no-ops."""
    try:
        from tools import clarify_gateway as _cg  # type: ignore
    except ImportError as exc:
        logger.warning(
            "interactive_bridge: tools.clarify_gateway not importable (%s) — "
            "clarify wire emission skipped",
            exc,
        )
        return

    original_register = getattr(_cg, "register", None)
    if not callable(original_register):
        logger.warning(
            "interactive_bridge: tools.clarify_gateway has no callable "
            "`register` function — skipping patch",
        )
        return
    if getattr(original_register, _PATCHED_SENTINEL, False):
        logger.debug("interactive_bridge: register() already patched")
        return

    def patched_register(*args, **kwargs):
        entry = original_register(*args, **kwargs)
        try:
            session_key = (
                kwargs.get("session_key")
                or (args[1] if len(args) > 1 else "")
                or getattr(entry, "session_key", "")
            )
            if session_key:
                # Register a notify callback that emits the wire event.
                # If a previous callback was registered (e.g. for the
                # text-fallback flow), `register_notify` overwrites it —
                # for operator-mode sessions there's nothing to overwrite
                # so this is a clean install.
                cb = _make_clarify_notify_cb(session_key)
                _cg.register_notify(session_key, cb)
                # Fire ONCE immediately for the current entry — Hermes
                # calls register() THEN expects the platform adapter to
                # have been notified separately. Since we register the
                # callback AFTER register() runs, we must manually
                # trigger it for THIS entry.
                cb(entry)
        except Exception:
            logger.exception(
                "interactive_bridge: post-register notify-registration crashed",
            )
        return entry

    setattr(patched_register, _PATCHED_SENTINEL, True)
    _cg.register = patched_register

    # Rebind top-level importers — modules that did
    # `from tools.clarify_gateway import register` see the new function.
    rebind_count = 0
    for mod_name, mod in list(sys.modules.items()):
        if mod is None or mod is _cg:
            continue
        try:
            if getattr(mod, "register", None) is original_register:
                setattr(mod, "register", patched_register)
                rebind_count += 1
        except Exception:
            continue

    logger.info(
        "interactive_bridge: patched tools.clarify_gateway.register "
        "(rebound %d top-level importer(s)); wire-emit ready",
        rebind_count,
    )
