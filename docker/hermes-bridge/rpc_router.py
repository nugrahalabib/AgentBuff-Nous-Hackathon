"""
rpc_router.py — Central dispatch for incoming portal RPC requests.

Responsibilities:
  1. Reject requests outside the connect-frame allowlist for unauth clients
  2. Energy-gate the energy-burning methods (chat.send etc) BEFORE Hermes
  3. Route to custom handlers (channels, agents, config) when Hermes doesn't have a native equivalent
  4. Translate method names + params for the methods that DO have direct equivalents
  5. Translate Hermes response back to portal format
  6. Wrap all errors as portal-style error responses

Adding a new method:
  1. Add entry to METHOD_HANDLERS below
  2. If handler is "forward to Hermes with translation":
       use HermesForward(hermes_method=..., translate_params=..., translate_result=...)
  3. If handler is "custom Python":
       write an async function with signature (params, ctx) -> any
       and assign to METHOD_HANDLERS["foo.bar"]
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Union

from auth import AuthContext
from agents_handler import AgentsHandler, AgentsError
from channels_handler import ChannelsHandler, ChannelsError
from wa_pairing import WaPairingError
from config_handler import ConfigHandler, ConfigError
from energy_gate import EnergyGate, EnergyError
from tier_limits import TierLimitGate, LimitError
from event_translator import canonicalize_session_key, decanonicalize_session_key
from hermes_client import HermesClient, HermesRpcError, HermesProcessError
import providers_handler


log = logging.getLogger("bridge.rpc_router")


# Hermes maintains TWO IDs per session:
#   - in-memory `sid` (uuid.hex[:8]) from session.create — used by event
#     emit / prompt.submit / session.history
#   - DB `session_key` (timestamp `YYYYMMDD_HHMMSS_xxxxxx`) from
#     `_new_session_key()` — used by sessions.list / session.resume
#
# These DIVERGE for freshly-created sessions: events route under sid,
# the archive (`sessions.list`) returns dbkey. Without a reconciliation
# layer the portal sees two distinct keys for the same chat — events
# pool under sid, sidebar row shows dbkey, click-to-load fails.
#
# CHOSEN RECONCILIATION STRATEGY: bridge always presents `sid` as the
# canonical public id when available. sessions.list rewrites each row's
# `id` from dbkey → sid via the reverse map. Events naturally use sid.
# Old archived sessions (no sid alias) keep dbkey until clicked → resume
# materialises a sid → alias registered → next refresh returns sid.
#
# Maps are populated by:
#   - session.create response (we wait for first prompt.submit then
#     resolve via session.list newest row)
#   - session.resume response (Hermes echoes both `session_id` (new sid)
#     and `resumed` (dbkey))
_SID_TO_DBKEY: dict[str, str] = {}
_DBKEY_TO_SID: dict[str, str] = {}
# sid → bound agentId (from sessions.create). Lets the event translator
# canonicalize chat events with the RIGHT agent prefix (agent:<id>:<sid>)
# instead of always defaulting to "main" → the UI showing a non-default agent's
# session as Buff.
_SID_TO_AGENT: dict[str, str] = {}

# Sessions just-created via session.create but not yet flushed to DB (no
# prompt.submit yet). Hermes only writes a DB row on first prompt.submit,
# so sessions.list returns nothing for these. Bridge surfaces them as
# synthetic rows so the sidebar tab the portal optimistically added stays
# present until the first turn flushes the real DB row (at which point
# we register the alias and drop the pending entry).
import time as _time
_PENDING_SIDS: dict[str, dict] = {}


def _pending_session_row(sid: str, info: dict) -> dict:
    """Synthesize a sessions.list-compatible row for a pending sid."""
    now = _time.time()
    return {
        "id": sid,
        "title": info.get("title") or "Thread baru",
        "preview": "",
        "started_at": info.get("created_at", now),
        "updated_at": info.get("created_at", now),
        "message_count": 0,
        "source": "tui",
    }


def register_pending_sid(sid: str, info: Optional[dict] = None) -> None:
    if not sid:
        return
    _PENDING_SIDS[sid] = {
        "title": (info or {}).get("title"),
        "created_at": _time.time(),
    }


def clear_pending_sid(sid: str) -> None:
    if sid in _PENDING_SIDS:
        _PENDING_SIDS.pop(sid, None)


# Recently-deleted sids — short-lived tombstone so a racing sessions.list (the
# engine still holding an active row in memory and re-flushing it, or fs flush
# lag on a profile state.db right after a delete) can't blink a just-deleted
# session back into the sidebar for a refresh cycle or two. TTL-bounded; a
# recreated session always gets a NEW sid, so this can never mask a legitimate
# future row. Belt-and-suspenders on top of the authoritative profile-aware
# delete in handle_sessions_delete. (2026-06-09)
_DELETED_SIDS: dict[str, float] = {}
_DELETED_SID_TTL_S = 12.0


def _tombstone_deleted_sid(sid: str) -> None:
    if sid:
        _DELETED_SIDS[sid] = _time.time() + _DELETED_SID_TTL_S


def _is_sid_tombstoned(sid: str) -> bool:
    """True if `sid` was deleted within the TTL window. Prunes expired on call."""
    if not _DELETED_SIDS:
        return False
    now = _time.time()
    expired = [k for k, exp in _DELETED_SIDS.items() if exp <= now]
    for k in expired:
        _DELETED_SIDS.pop(k, None)
    return sid in _DELETED_SIDS


def get_dbkey_for_sid(sid: str) -> Optional[str]:
    """Lookup used by event_translator's canonicalize step."""
    if not sid:
        return None
    return _SID_TO_DBKEY.get(sid)


def _agent_binding_path():
    import os as _os
    from pathlib import Path as _Path
    home = _os.environ.get("HERMES_HOME") or _os.path.expanduser("~/.hermes")
    return _Path(home) / ".agentbuff_session_agents.json"


def _persist_agent_bindings() -> None:
    """Persist sid/dbkey → agent so a session keeps its agent across bridge
    restarts (the in-memory map is otherwise lost → /app would relabel the
    session as Buff). The dbkey entries are the durable ones (sids are
    ephemeral); both are written, harmless."""
    try:
        import json as _json
        path = _agent_binding_path()
        path.write_text(_json.dumps(_SID_TO_AGENT, ensure_ascii=False), encoding="utf-8")
    except Exception:
        log.debug("persist agent bindings failed", exc_info=True)


def _load_agent_bindings() -> None:
    try:
        import json as _json
        path = _agent_binding_path()
        if path.exists():
            data = _json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(k, str) and isinstance(v, str):
                        _SID_TO_AGENT[k] = v
    except Exception:
        log.debug("load agent bindings failed", exc_info=True)


def register_sid_agent(sid: str, agent_id: Optional[str]) -> None:
    """Remember which agent a freshly-created session is bound to, so chat
    events for that sid canonicalize to agent:<id>:<sid> (not agent:main:…)
    AND sessions.list reports the right owning agent. Persisted across restarts."""
    if not sid or not agent_id:
        return
    aid = agent_id.strip().lower()
    if aid and aid not in ("main", "default") and _SID_TO_AGENT.get(sid) != aid:
        _SID_TO_AGENT[sid] = aid
        _persist_agent_bindings()


def get_agent_for_sid(sid: str) -> Optional[str]:
    """Agent a sid is bound to (None for default/unknown). Used by the event
    translator's canonicalize step + sessions.list's agentId + the dbkey alias
    propagation."""
    if not sid:
        return None
    return _SID_TO_AGENT.get(sid)


_load_agent_bindings()


def get_sid_for_dbkey(dbkey: str) -> Optional[str]:
    """Reverse lookup used by handle_sessions_list to substitute dbkey
    rows with their sid alias so portal events naturally match the
    sidebar row id."""
    if not dbkey:
        return None
    return _DBKEY_TO_SID.get(dbkey)


def register_sid_dbkey(sid: str, dbkey: str) -> None:
    """Record a known sid↔dbkey alias. Idempotent. Populates both maps
    AND clears the pending-sid synthetic row (DB row now exists, sessions
    .list will return it natively rewritten to sid via _DBKEY_TO_SID)."""
    if not sid or not dbkey or sid == dbkey:
        return
    _SID_TO_DBKEY[sid] = dbkey
    _DBKEY_TO_SID[dbkey] = sid
    # Propagate the agent binding from the ephemeral sid to the durable dbkey
    # so sessions.list (keyed by dbkey) reports the right agent after restart.
    bound = _SID_TO_AGENT.get(sid)
    if bound and _SID_TO_AGENT.get(dbkey) != bound:
        _SID_TO_AGENT[dbkey] = bound
        _persist_agent_bindings()
    clear_pending_sid(sid)


async def _lookup_dbkey_for_sid(
    ctx_hermes: HermesClient, sid: str
) -> Optional[str]:
    """Resolve a sid to its DB key DETERMINISTICALLY via session.status.

    Hermes' `session.status` reads from `_sessions[sid]["session_key"]`
    directly — which is the dbkey set at session.create time. Parses the
    "Session ID: <key>" line from the text response. Always correct for
    the requested sid (no race with sessions.list ordering).

    Returns None if sid isn't in _sessions (deleted / never existed).
    """
    if sid in _SID_TO_DBKEY:
        return _SID_TO_DBKEY[sid]
    try:
        resp = await ctx_hermes.call(
            "session.status", {"session_id": sid}
        )
    except Exception:
        return None
    output = (
        resp.get("output") if isinstance(resp, dict) else None
    ) or ""
    if not isinstance(output, str):
        return None
    for line in output.splitlines():
        s = line.strip()
        if s.startswith("Session ID:"):
            dbkey = s.split(":", 1)[1].strip()
            if dbkey:
                register_sid_dbkey(sid, dbkey)
                return dbkey
    return None


# -------------------------------------------------------------------------
# Dispatch context — passed to every handler
# -------------------------------------------------------------------------


@dataclass
class DispatchContext:
    """All the stuff a handler may need. Single object so signatures stay small."""

    hermes: HermesClient
    config: ConfigHandler
    agents: AgentsHandler
    channels: ChannelsHandler
    energy: Optional[EnergyGate]
    # Per-tier entitlement gate (D7). None when AGENTBUFF_TIER_LIMITS_ENABLED is off.
    tier_limits: Optional[TierLimitGate]
    auth: AuthContext
    # Optional reference to the bridge app for broadcasting events to all
    # connected /app WS clients (used by messages.edit/delete + reactions
    # for live updates without refresh). May be None in tests / unit
    # contexts — handlers should guard with `if ctx.bridge_app is not None`.
    bridge_app: Optional[Any] = None


# Hermes updater is a global singleton (registered via register_updater at boot)
# rather than a per-call ctx field, because it's a process-wide resource and
# adding to ctx would require threading it through hundreds of call sites.
_UPDATER_REGISTRY: dict = {"updater": None}


def register_updater(updater) -> None:
    """Called once at bridge boot to make the Hermes updater accessible."""
    _UPDATER_REGISTRY["updater"] = updater


# WhatsApp pairing manager — process-wide singleton (like the updater). Set at
# bridge boot via register_wa_pairing(); consumed by web.login.start/wait.
_WA_PAIRING_REGISTRY: dict = {"mgr": None}


def register_wa_pairing(mgr) -> None:
    """Called once at bridge boot to expose the WhatsApp pairing manager."""
    _WA_PAIRING_REGISTRY["mgr"] = mgr


# -------------------------------------------------------------------------
# Handler protocols — two kinds of handlers
# -------------------------------------------------------------------------


HandlerFn = Callable[[dict, DispatchContext], Awaitable[Any]]


@dataclass
class HermesForward:
    """Forward to Hermes with optional param/result translation."""

    hermes_method: str
    translate_params: Optional[Callable[[dict, DispatchContext], Awaitable[dict]]] = None
    translate_result: Optional[Callable[[Any, DispatchContext], Awaitable[Any]]] = None
    energy_gated: bool = False
    long_timeout: bool = False


Handler = Union[HandlerFn, HermesForward]


# -------------------------------------------------------------------------
# Method handlers
# -------------------------------------------------------------------------
#
# Naming convention: keys are PORTAL-side method names (OpenClaw-style).
# Values are either:
#   - a function (custom logic), or
#   - HermesForward(hermes_method=...)
#
# Methods NOT in this map → error "METHOD_NOT_FOUND"
# Methods marked energy_gated → balance check before forward


METHOD_HANDLERS: dict[str, Handler] = {}


# -----------------------------------------------------------------
# Chat methods — energy-gated + agent profile injection
# -----------------------------------------------------------------

# ── P0#2: per-agent /app web chat (chief's design 2026-05-30) ─────────────
# The /app dashboard chat uses Hermes' TUI gateway, which builds ONE agent from
# GLOBAL config and IGNORES the model/system_prompt_override/enabled_toolsets
# params the bridge sends on prompt.submit (engine reads only session_id+text).
# To make each /app session actually use its BOUND agent's persona + model
# (one agent per session, chosen at thread creation), we apply them PER-SESSION
# via the engine's own per-session levers AFTER the session's agent is built:
#   SOUL  → register as config.yaml::agent.personalities.<id> (read fresh by the
#           engine's _available_personalities, no gateway reload) + /personality
#   model → /model <model>
# Both mutate ONLY this session's cached agent object → per-session isolated, no
# global active-prompt change, no engine source mod, no gateway restart. The
# default agent ("main"/"default") is skipped — it already uses the global SOUL.
_DEFAULT_AGENT_IDS = {"", "main", "default"}
_persona_synced: set[str] = set()  # agent_ids whose personality is registered this process


def _register_agent_personality(agent_id: str, soul: str) -> bool:
    """Idempotently write config.yaml::agent.personalities.<id> = soul so the
    /personality slash can resolve it. One file write per agent per process
    (guarded by _persona_synced). Direct file write — the engine reads
    personalities fresh per call, so NO config.patch/SIGUSR1 reload is triggered
    (avoids disrupting live channel adapters). Returns True if available."""
    name = (agent_id or "").lower().strip()
    soul = soul or ""
    if not name or not soul.strip():
        return False
    if name in _persona_synced:
        return True
    try:
        import os
        import yaml

        home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        cfg_path = os.path.join(home, "config.yaml")
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except FileNotFoundError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        agent_cfg = data.get("agent")
        if not isinstance(agent_cfg, dict):
            agent_cfg = {}
            data["agent"] = agent_cfg
        personalities = agent_cfg.get("personalities")
        if not isinstance(personalities, dict):
            personalities = {}
            agent_cfg["personalities"] = personalities
        if personalities.get(name) != soul:
            personalities[name] = soul
            tmp = cfg_path + ".p0_2.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
            os.replace(tmp, cfg_path)
            log.info("p0#2: registered personality for agent %s", name)
        _persona_synced.add(name)
        return True
    except Exception:
        log.exception("p0#2: register personality failed for %s", agent_id)
        return False


async def _await_session_agent_ready(
    ctx: "DispatchContext", sid: str, timeout: float = 12.0
) -> str:
    """Poll session.status until the session's agent is built.

    Returns one of: "ready" | "not_found" | "timeout".
    session.create kicks off a deferred (~0.05s) background build that takes
    ~1-3s (tool discovery); session.status reports Model '(unknown)' until the
    agent exists. Bails IMMEDIATELY with "not_found" when the session isn't in
    memory (so the pre-submit persona hook doesn't waste 12s on a fresh key
    that will fall through to the auto-create tier instead)."""
    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        try:
            st = await ctx.hermes.call(
                "session.status", {"session_id": sid}, timeout=10.0
            )
            out = st.get("output", "") if isinstance(st, dict) else ""
            if out and "(unknown)" not in out:
                return "ready"
        except HermesRpcError as e:
            m = (e.message or "").lower()
            if e.code in (4001, 4006, 4007, -32602) or "not found" in m:
                return "not_found"
        except Exception:
            pass
        await asyncio.sleep(0.3)
    return "timeout"


async def _apply_session_persona(
    ctx: "DispatchContext",
    sid: str,
    agent_id: str,
    agent_profile: dict,
    soul_content: str,
) -> None:
    """DISABLED 2026-05-30 — this approach pollutes GLOBAL config.

    ROOT CAUSE: the only per-session levers the Hermes TUI gateway exposes
    (`/personality`, `/model` via slash.exec) route through the slash WORKER,
    which WRITES CONFIG GLOBALLY (server.py:5601-5612, "The worker writes
    config"). So `/personality <agent>` overwrites the GLOBAL
    `agent.system_prompt` and `/model <m>` overwrites the GLOBAL `model.default`
    — NOT per-session. Every pick contaminated chief's default agent + every
    other surface. The TUI gateway has NO clean per-session persona override
    (prompt.submit reads only session_id+text; there is no
    `_session_model_overrides` like the channel gateway has).

    Per-agent chat in /app is therefore NOT cleanly feasible on the current
    engine without an engine change or a per-profile gateway process. Per-agent
    persona/model DOES work on CHANNELS (each agent = own synthetic platform via
    the run.py routing hook — proven with kiwi's WhatsApp). Left here, disabled,
    pending a real decision with chief on the path forward."""
    return
    try:  # noqa: unreachable — disabled above
        aid = (agent_id or "").lower().strip()
        if aid in _DEFAULT_AGENT_IDS:
            return  # default agent already uses the global SOUL + model
        model = ((agent_profile.get("model") or {}).get("primary") or "").strip()
        soul = (soul_content or "").strip()
        if not soul and not model:
            return
        ready = await _await_session_agent_ready(ctx, sid)
        if ready != "ready":
            log.warning(
                "p0#2: agent %s (sid=%s agent=%s) — persona not applied",
                ready, sid, aid,
            )
            return
        if soul and _register_agent_personality(aid, soul):
            try:
                await ctx.hermes.call(
                    "slash.exec",
                    {"session_id": sid, "command": f"/personality {aid}"},
                    timeout=20.0,
                )
            except Exception:
                log.exception("p0#2: /personality apply failed sid=%s", sid)
        if model:
            try:
                await ctx.hermes.call(
                    "slash.exec",
                    {"session_id": sid, "command": f"/model {model}"},
                    timeout=20.0,
                )
            except Exception:
                log.exception("p0#2: /model apply failed sid=%s", sid)
        log.info(
            "p0#2: applied persona+model sid=%s agent=%s model=%s",
            sid, aid, model or "(profile default)",
        )
    except Exception:
        log.exception("p0#2: apply_session_persona crashed (non-fatal) sid=%s", sid)


def _app_message_time_prefix(client_tz: Optional[str] = None) -> str:
    """Leading `[Dow YYYY-MM-DD HH:MM UTC+07:00] ` timestamp for /app messages.

    Channels get per-message time via the multichannel routing hook
    (channel_prompt). /app's prompt.submit only accepts {session_id, text}, so
    we prepend the receive time to the text here. The agent reads it as the
    message's real-time; /app's strip-inbound-meta (LEADING_TIMESTAMP_PREFIX_RE)
    removes this exact format from the rendered user bubble, so chief never sees
    it.

    `client_tz`: the browser's IANA timezone (device location). Web runs on the
    user's device, so we honor it → the agent gets the USER's LOCAL time, not the
    container's. We format the accurate (NTP) server clock in that zone, so a
    wrong device clock can't poison the time. Falls back to the engine's
    configured timezone (config.yaml) when absent/invalid."""
    from datetime import datetime as _dt_mod
    n = None
    if client_tz:
        try:
            from zoneinfo import ZoneInfo
            n = _dt_mod.now(ZoneInfo(client_tz))
        except Exception:
            n = None  # invalid/unknown tz → fall back below
    if n is None:
        try:
            from hermes_time import now as _hn  # reads config.yaml timezone
            n = _hn()
        except Exception:
            try:
                from zoneinfo import ZoneInfo
                import os as _os
                n = _dt_mod.now(
                    ZoneInfo(_os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
                )
            except Exception:
                log.debug("app message time prefix failed", exc_info=True)
                return ""
    try:
        off = n.strftime("%z") or "+0000"
        off_fmt = f"UTC{off[:3]}:{off[3:]}"
        return f"[{n.strftime('%a %Y-%m-%d %H:%M')} {off_fmt}] "
    except Exception:
        log.debug("app message time prefix format failed", exc_info=True)
        return ""


async def handle_chat_send(params: dict, ctx: DispatchContext) -> dict:
    """chat.send — energy-gated, with agent profile injection.

    Portal sends:
        {sessionKey: "agent:cs:foo", message: "halo", attachments: [...]}

    We:
      1. Pre-flight energy check
      2. Resolve agent from sessionKey prefix
      3. Build Hermes prompt.submit params with overrides
      4. Forward and translate result
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "chat.send params must be a dict")

    session_key_raw = params.get("sessionKey") or params.get("session_key") or "main"
    session_key = canonicalize_session_key(session_key_raw)
    # Hermes' prompt.submit needs the FLAT session_id, not the portal's
    # `agent:<id>:<key>` canonical form. Strip back to flat id.
    agent_id_from_key, flat_session_id = decanonicalize_session_key(session_key)
    message = params.get("message")
    attachments = params.get("attachments") or []

    # Empty user text is allowed IFF attachments are present — the bridge
    # synthesizes a helpful placeholder text below so prompt.submit's
    # text-non-empty guard passes. Matches the channel-side behavior where
    # a Telegram user can send a photo with no caption.
    if not isinstance(message, str):
        raise RpcError("INVALID_REQUEST", "chat.send message must be a string")
    has_attachments = bool(attachments)
    if not message.strip() and not has_attachments:
        raise RpcError("INVALID_REQUEST", "chat.send message must be a non-empty string when no attachments are provided")

    # Energy pre-flight (gate is None when bridge not connected to portal yet)
    if ctx.energy is not None:
        try:
            await ctx.energy.check()
        except EnergyError as e:
            raise RpcError(e.code, e.message)

    # Resolve agent overrides
    try:
        agent_profile = await ctx.agents.resolve_agent_for_session(session_key)
        agent_id = agent_profile.get("id", "main")
        soul_content = await ctx.agents.get_soul_content(agent_id)
    except AgentsError as e:
        raise RpcError(e.code, e.message)

    # Bind this session's sid -> agent so BOTH the streaming chat events AND
    # the echoed sessionKey canonicalize to agent:<id>:<sid> (not agent:main).
    # Critical for RESUMED per-agent sessions: the TIER-2 resume path below does
    # NOT go through session.create's persona wrap (which is what normally
    # records this binding), so without it the reply streams back keyed to
    # agent:main -> /app renders it on the WRONG (default) thread + flips the
    # responder identity to Buff. The agent is known right here from the
    # client's canonical key, so record it unconditionally for a real
    # non-default agent. Idempotent + persisted across restarts.
    _agent_lc = str(agent_id or "").lower()
    if _agent_lc and _agent_lc not in ("", "main", "default"):
        try:
            register_sid_agent(flat_session_id, agent_id)
        except Exception:
            log.debug("register_sid_agent(flat) failed", exc_info=True)

    # ──────────────────────────────────────────────────────────────────
    # Multimodal attachment preprocessing
    # ──────────────────────────────────────────────────────────────────
    # Hermes' prompt.submit RPC only accepts {session_id, text}; it does
    # NOT honor an `attachments` array (tui_gateway/server.py:3021-3052).
    # Multimodal support on the channel side (Telegram/WhatsApp/Discord)
    # works because the channel adapter caches the binary to a Hermes
    # cache directory and the engine's gateway/run.py enriches the
    # message text BEFORE forwarding to the agent.
    #
    # The bridge mirrors that flow here: cache + enrich + image.attach,
    # then send the enriched text via prompt.submit. See
    # `attachment_preprocessor.py` for the per-kind handling rules.
    enriched_text = message
    image_paths_to_attach: list[str] = []
    attachment_errors: list[str] = []
    user_attachment_urls: list[dict] = []
    if has_attachments:
        try:
            from attachment_preprocessor import process_attachments
            processed = process_attachments(attachments)
            attachment_errors = processed.errors
            image_paths_to_attach = processed.image_paths
            user_attachment_urls = processed.user_attachment_urls
            # Prepend Hermes-style context notes + inlined text content to
            # the user's message. Mirrors gateway/run.py:7727 ordering.
            if processed.prefix_text:
                if message.strip():
                    enriched_text = f"{processed.prefix_text}\n\n{message}"
                else:
                    enriched_text = processed.prefix_text
        except Exception as exc:
            log.exception("attachment preprocessing crashed: %s", exc)
            # Soft-fail: drop the attachments + surface the error in the
            # response so the UI can flag them. The text-only message
            # still goes through so the user isn't blocked.
            attachment_errors = [
                f"Pre-processing lampiran gagal ({type(exc).__name__}). "
                f"Lampiran tidak dikirim; teks pesan tetap diteruskan."
            ]

    # Append PORTAL_ATTACHMENT_URLS sentinel — persists the per-attachment
    # HTTP token URLs through Hermes' session storage so /app can rebuild
    # playable AudioCard / ImageCard / VideoCard / DocumentCard after page
    # refresh. Without this the optimistic blob: URLs die on tab unload
    # and chief loses access to his own uploads.
    #
    # Sentinel format (parsed by `strip-inbound-meta.ts::parseUserPayload`):
    #     [[PORTAL_ATTACHMENT_URLS:<json array>]]
    #
    # Placed on its own line at the END of the enriched text so it's
    # always findable by the regex parser regardless of how much prose
    # the prefix_text injected before it. parseUserPayload strips it out
    # before the user bubble renders so chief never sees the sentinel.
    if user_attachment_urls:
        try:
            import json as _json
            sentinel_json = _json.dumps(
                user_attachment_urls,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            enriched_text = (
                f"{enriched_text}\n\n[[PORTAL_ATTACHMENT_URLS:{sentinel_json}]]"
            )
        except Exception as exc:
            log.warning(
                "PORTAL_ATTACHMENT_URLS sentinel serialization failed: %s",
                exc,
            )

    # If after preprocessing we still have no usable text (no message,
    # all attachments dropped via errors), synthesize a minimal stub so
    # Hermes' non-empty-text guard doesn't reject the call.
    if not enriched_text.strip():
        if image_paths_to_attach:
            enriched_text = "[Image attached — what do you see?]"
        else:
            enriched_text = "[Attachment sent]"

    # Per-message real-time: prepend the receive timestamp so the agent knows
    # when THIS /app message was sent (engine only gives day-level date). /app's
    # strip-inbound-meta removes this exact leading format from the user bubble.
    # Honor the browser's device timezone (params.clientTz) so the agent gets the
    # USER's local time, not the container's WIB.
    _client_tz = params.get("clientTz")
    _ts_prefix = _app_message_time_prefix(
        _client_tz if isinstance(_client_tz, str) and _client_tz else None
    )
    if _ts_prefix:
        enriched_text = _ts_prefix + enriched_text

    # Build params for Hermes prompt.submit
    hermes_params: dict = {"text": enriched_text}

    # Optional overrides (only sent if non-default).
    #
    # IMPORTANT — do NOT pass `model` to prompt.submit. The engine HONORS a
    # `model` override here, but when it DIFFERS from the model the session's
    # agent was already built with, the engine attempts an on-the-fly switch,
    # fails to resolve a bare model name (e.g. "gemini-2.5-flash") in that
    # path, and FALLS BACK to its hardcoded default `anthropic/claude-sonnet-4`
    # — which then 404s against the active (gemini) provider endpoint, so the
    # reply streams ZERO events and comes back EMPTY. (Chief 2026-05-30: kiwi
    # replied empty while Buff worked, because Buff's per-agent model happened
    # to EQUAL the global model so no switch occurred; kiwi's gemini-2.5-flash
    # differed from the global gemini-3-flash-preview so it broke.) Per-session
    # model is applied correctly + fail-safe by the persona patch
    # (agentbuff_persona_patch._make_agent), which keeps the working global
    # runtime when a clean per-agent runtime can't be resolved. So we leave the
    # model to the session's agent object and never override it here.
    if soul_content:
        hermes_params["system_prompt_override"] = soul_content
    skills = agent_profile.get("skills") or []
    if skills:
        hermes_params["enabled_toolsets"] = skills

    # Session resolution. Hermes' prompt.submit REQUIRES the session to
    # exist in _sessions (per tui_gateway/server.py:619 _sess_nowait).
    # Portal's default flat key "main" never exists from Hermes' POV —
    # Hermes auto-generates a uuid (e.g. "554ffd2f") via session.create.
    #
    # Try with the requested flat id first. On "session not found",
    # auto-create a session and retry. Return BOTH ids so portal can
    # update activeSessionKey to the real Hermes id, so next call hits
    # the existing session directly.
    async def _attach_images(sid: str) -> None:
        """Register cached image paths with Hermes BEFORE submit so the
        engine's vision pipeline picks them up via session['attached_images']
        on the next turn. We swallow per-image failures so one bad image
        doesn't kill the whole submit."""
        for path in image_paths_to_attach:
            try:
                await ctx.hermes.call(
                    "image.attach",
                    {"session_id": sid, "path": path},
                    timeout=30.0,
                )
            except HermesRpcError as ie:
                log.warning(
                    "image.attach failed for %s on sid=%s: %s",
                    path, sid, ie.message,
                )
                attachment_errors.append(
                    f"image.attach: {ie.message}"
                )

    async def _try_submit(sid: str) -> dict:
        # Attach images BEFORE submit so Hermes' _enrich_with_attached_images
        # has the paths ready when prompt.submit consumes the session state.
        if image_paths_to_attach:
            await _attach_images(sid)
        params_with_sid = {**hermes_params, "session_id": sid}
        return await ctx.hermes.call(
            "prompt.submit", params_with_sid, timeout=300.0,
        )

    # Session resolution — three-tier lookup so old sessions don't get
    # silently replaced with brand new ones:
    #
    #   TIER 1 — direct submit with `flat_session_id`. Works when the id
    #            portal sent is currently in Hermes' `_sessions` (active
    #            sid) OR is "main" / a default that Hermes auto-handles.
    #
    #   TIER 2 — session.resume(flat_session_id). When TIER 1 fails with
    #            "session not found", the id is likely a DB key (dbkey
    #            timestamp form like "20260523_181530_f65212") for a
    #            session that was persisted but evicted from memory
    #            (container restart, idle eviction, etc.). session.resume
    #            re-hydrates it: reads the DB row, allocates a NEW
    #            in-memory sid pointing at the same DB session, returns
    #            that sid + the original target. We submit with the new
    #            sid but ECHO THE ORIGINAL `flat_session_id` back to
    #            portal — that's the stable public key. The dbkey↔sid
    #            alias is registered so subsequent calls in the same
    #            connection skip the resume.
    #
    #            BEFORE THIS FIX: TIER 1 failure jumped straight to TIER 3
    #            (auto-create). Result: every reply to a session that
    #            wasn't currently in memory created a brand new session.
    #            Chief reported this as "reply selalu ke session baru".
    #
    #   TIER 3 — session.create (auto). Only when both TIER 1 and TIER 2
    #            fail (TIER 2 also returns "session not found"). True new-
    #            session path: portal sent a placeholder key (e.g. "main"
    #            on first-ever message). Echo the NEW sid back so portal
    #            updates its key — this IS the new session.
    #
    # `actual_session_id` controls what gets echoed back to portal as
    # `sessionKey`. Always equals the public-facing key portal should
    # remember.

    actual_session_id = flat_session_id
    submit_sid: str = flat_session_id  # what we actually pass to prompt.submit

    # Fast path: if we already know a sid alias for the dbkey portal sent,
    # use it directly without trying TIER 1 first (TIER 1 would fail on
    # the dbkey itself since dbkeys aren't in `_sessions`).
    aliased_sid = get_sid_for_dbkey(flat_session_id)
    if aliased_sid:
        submit_sid = aliased_sid

    # P0#2 (2026-05-30): apply the bound agent's persona + model BEFORE the
    # TIER-1 submit. The /app UI calls sessions.create({agentId}) first, so by
    # the time chat.send arrives the session already exists in Hermes → the
    # submit takes TIER 1 (direct), which previously SKIPPED persona (only
    # TIER 2/3 had it) → every UI chat fell back to the global default agent.
    # _apply_session_persona is idempotent + bails fast ("not_found") for a
    # fresh key that will instead create+apply in TIER 3 below. (Caught by
    # chief's E2E: agent:ccprobe key replied with the default agent's persona.)
    await _apply_session_persona(
        ctx, submit_sid, agent_id, agent_profile, soul_content
    )

    try:
        result = await _try_submit(submit_sid)
        # Existing session path: prompt.submit succeeded. Still resolve
        # sid→dbkey alias so the next sessions.list refresh rewrites the
        # dbkey row to use sid — otherwise the sidebar row that portal
        # optimistically created under sid disappears when the dbkey row
        # replaces it.
        if _agent_lc and _agent_lc not in ("", "main", "default"):
            try:
                register_sid_agent(submit_sid, agent_id)
            except Exception:
                log.debug("register_sid_agent(submit) failed", exc_info=True)
        await _lookup_dbkey_for_sid(ctx.hermes, submit_sid)
    except HermesRpcError as e:
        msg = (e.message or "").lower()
        is_missing = (
            e.code == 4001
            or e.code == -32602
            or "session not found" in msg
            or "not found" in msg
        )
        if not is_missing:
            raise RpcError(_map_hermes_code(e.code), e.message)

        # TIER 2: try session.resume — maybe portal sent a dbkey for an
        # evicted session. session.resume re-hydrates it from DB.
        resumed_sid: Optional[str] = None
        try:
            log.info(
                "chat.send: session_id %r not in memory, trying session.resume",
                flat_session_id,
            )
            # Per-agent sessions live in profiles/<agent>/state.db, NOT the
            # root db. Without `profile`, the gateway resumes from the ROOT db
            # (server.py:3185), never finds the row -> 4007 -> we fall through
            # to TIER 3 and mint a BRAND-NEW session on every single reply.
            # That was the "tiap selesai balas bikin sesi baru + auto loncat ke
            # command center" bug. session.resume reads `profile` natively
            # (server.py:3169-3188) and opens THAT profile's state.db, so the
            # evicted per-agent session re-hydrates and the turn APPENDS to the
            # same thread instead of forking. Default agent (root db) is
            # unaffected — we only set profile for a real non-default agent.
            _resume_params: dict = {"session_id": flat_session_id}
            if agent_id and str(agent_id).lower() not in ("", "main", "default"):
                _resume_params["profile"] = str(agent_id).lower()
            resumed = await ctx.hermes.call("session.resume", _resume_params)
            if isinstance(resumed, dict):
                resumed_sid = resumed.get("session_id") or resumed.get("id")
        except HermesRpcError as re:
            # 4007 = "session not found" from session.resume's DB lookup.
            # 4006 = "session_id required" (empty). Both mean: this id has
            # no DB row → it's a fresh key, fall through to TIER 3.
            resume_msg = (re.message or "").lower()
            resume_missing = (
                re.code == 4007
                or re.code == 4006
                or "session not found" in resume_msg
            )
            if not resume_missing:
                # Resume failed for some other reason (DB error, etc.) —
                # surface it instead of masking with a new session.
                raise RpcError(_map_hermes_code(re.code), re.message)
        except HermesProcessError as re:
            raise RpcError("ENGINE_DOWN", str(re))

        if resumed_sid:
            # Resumed successfully. Register alias so subsequent calls
            # skip this whole branch. The PUBLIC key stays the original
            # flat_session_id (the dbkey) — chief's activeSessionKey
            # doesn't pivot, and the same key works after the next
            # container restart too.
            # Bind the resumed in-memory sid -> agent FIRST so the streaming
            # chat events (keyed by resumed_sid) canonicalize to the right
            # agent; register_sid_dbkey then propagates the binding onto the
            # durable dbkey too (see register_sid_dbkey).
            if _agent_lc and _agent_lc not in ("", "main", "default"):
                try:
                    register_sid_agent(resumed_sid, agent_id)
                except Exception:
                    log.debug("register_sid_agent(resumed) failed", exc_info=True)
            register_sid_dbkey(resumed_sid, flat_session_id)
            # P0#2: a resumed session rebuilds its agent fresh → re-apply persona.
            await _apply_session_persona(
                ctx, resumed_sid, agent_id, agent_profile, soul_content
            )
            try:
                result = await _try_submit(resumed_sid)
            except HermesRpcError as re:
                raise RpcError(_map_hermes_code(re.code), re.message)
            except HermesProcessError as re:
                raise RpcError("ENGINE_DOWN", str(re))
            # actual_session_id stays at flat_session_id (the dbkey portal
            # sent + remembered). Echo it back unchanged.
        else:
            # TIER 3: true new session. session.create + submit + echo new sid.
            log.info(
                "chat.send: session_id %r has no DB row, auto-creating",
                flat_session_id,
            )
            try:
                # Forward agentId so the persona patch binds this fresh
                # auto-created session to the right agent (per-session persona).
                _cp: dict = {}
                if agent_id and str(agent_id).lower() not in ("", "main", "default"):
                    _cp["agentId"] = agent_id
                created = await ctx.hermes.call("session.create", _cp)
            except HermesRpcError as ce:
                raise RpcError(_map_hermes_code(ce.code), ce.message)
            except HermesProcessError as ce:
                raise RpcError("ENGINE_DOWN", str(ce))

            new_sid = (
                created.get("session_id") or created.get("id")
                if isinstance(created, dict) else None
            )
            if not new_sid:
                raise RpcError(
                    "ENGINE_ERROR",
                    f"session.create did not return a session_id (got {created!r})",
                )
            actual_session_id = new_sid
            # Bind the new sid -> agent in the bridge's OWN map (persona_patch
            # records its binding in a SEPARATE dict that canonicalize doesn't
            # read), so the echoed key + streaming events carry agent:<id>:…
            # not agent:main.
            if _agent_lc and _agent_lc not in ("", "main", "default"):
                try:
                    register_sid_agent(new_sid, agent_id)
                except Exception:
                    log.debug("register_sid_agent(new) failed", exc_info=True)
            # P0#2: bind this fresh session to its agent's persona + model.
            await _apply_session_persona(
                ctx, new_sid, agent_id, agent_profile, soul_content
            )
            try:
                result = await _try_submit(new_sid)
            except HermesRpcError as re:
                raise RpcError(_map_hermes_code(re.code), re.message)
            except HermesProcessError as re:
                raise RpcError("ENGINE_DOWN", str(re))
            await _lookup_dbkey_for_sid(ctx.hermes, new_sid)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    return {
        "ok": True,
        "result": result,
        "agentId": agent_id,
        # Echo the actual session id (sid for fresh sessions) back so
        # the portal store can update activeSessionKey if it differed
        # from what they sent. Sessions.list will return matching sid
        # rows on next refresh — single canonical key end to end.
        # default_agent_id pins the right prefix even if the sid->agent
        # binding lookup somehow misses (belt-and-suspenders for the
        # agent:main-collapse bug on resumed per-agent sessions). For the
        # DEFAULT agent we MUST keep the "main" sentinel (NOT the literal
        # "default" id) — sessions.list + the client both key the default
        # agent as agent:main:…, so echoing agent:default:… would make the
        # client think the session changed and pivot. Only a real
        # non-default agent gets its id pinned here.
        "sessionKey": canonicalize_session_key(
            actual_session_id,
            default_agent_id=(
                agent_id if (_agent_lc and _agent_lc not in ("", "main", "default"))
                else "main"
            ),
        ),
        # Surface per-attachment errors (size cap, bad b64, unsupported
        # MIME) so the UI can show a non-fatal warning. Empty when all
        # attachments were preprocessed cleanly.
        "attachmentWarnings": attachment_errors,
    }


METHOD_HANDLERS["chat.send"] = handle_chat_send


async def handle_chat_abort(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "chat.abort params must be a dict")
    session_key_raw = params.get("sessionKey") or params.get("session_key") or "main"
    session_key = canonicalize_session_key(session_key_raw)

    try:
        result = await ctx.hermes.call(
            "session.interrupt", {"session_id": session_key},
        )
        return {"ok": True, "result": result}
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))


METHOD_HANDLERS["chat.abort"] = handle_chat_abort


# -----------------------------------------------------------------
# Interactive prompt resolution — approval / clarify / sudo / secret
# -----------------------------------------------------------------
# Hermes pauses the agent waiting for user input on these primitives.
# /app sends `*.respond` RPC → bridge forwards to tui_gateway (which
# already exposes the matching JSON-RPC method) → Hermes unblocks.
#
# Why forward instead of calling resolve_gateway_* directly: those
# functions live in tui_gateway's Python process (PID 25), not the
# bridge process (PID 7). Direct call would resolve in the bridge's
# in-memory queue which the agent doesn't read. JSON-RPC forward
# routes through the same wire tui_gateway already exposes.
#
# Telegram parity:
#   - approval.respond  → ✅ Setuju sekali / Sesi ini / Selalu / ❌ Tolak
#   - clarify.respond   → numbered choice OR ✏️ Lainnya free-text
#   - sudo.respond      → grant boolean (rare for /app users)
#   - secret.respond    → API-key paste flow (rare for /app users)


async def handle_approval_respond(params: dict, ctx: DispatchContext) -> dict:
    """User clicked an approval button in /app's ApprovalRow.
    Forwards `approval.respond` to tui_gateway which calls
    `tools.approval.resolve_gateway_approval(session_key, choice)`."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "approval.respond params must be a dict")
    session_key_raw = (
        params.get("sessionKey") or params.get("session_key") or "main"
    )
    session_key = canonicalize_session_key(session_key_raw)
    # Decanonicalize to the session_id portion, then map the stable DBKEY
    # (which the canonical key embeds for sid<->sessions.list parity) to the
    # LIVE in-memory SID. The engine's approval registry + `_sessions` are
    # keyed by the SID, so passing the dbkey yields 4001 "session not found"
    # — the exact bug that made Setuju/Tolak fail. Falls back to the raw value
    # when the key already holds a live sid (no dbkey alias registered yet).
    _, session_id = decanonicalize_session_key(session_key)
    session_id = get_sid_for_dbkey(session_id) or session_id
    choice = params.get("choice")
    if choice not in ("once", "session", "always", "deny"):
        raise RpcError(
            "INVALID_REQUEST",
            f"approval.respond choice must be once|session|always|deny, got {choice!r}",
        )
    try:
        result = await ctx.hermes.call(
            "approval.respond",
            {
                "session_id": session_id,
                "choice": choice,
                "all": bool(params.get("all", False)),
            },
        )
        return {"ok": True, "result": result}
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))


METHOD_HANDLERS["approval.respond"] = handle_approval_respond


async def handle_clarify_respond(params: dict, ctx: DispatchContext) -> dict:
    """User clicked a clarify choice or typed an `Other` response in
    /app's ClarifyRow. Forwards to tui_gateway's `clarify.respond`
    which resolves the pending clarify entry."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "clarify.respond params must be a dict")
    session_key_raw = (
        params.get("sessionKey") or params.get("session_key") or "main"
    )
    session_key = canonicalize_session_key(session_key_raw)
    _, session_id = decanonicalize_session_key(session_key)
    # Map the canonical key's DBKEY to the live in-memory SID — the engine
    # keys `_sessions` by SID, so a dbkey yields 4001 "session not found".
    # Same fix as approval.respond above.
    session_id = get_sid_for_dbkey(session_id) or session_id
    request_id = (
        params.get("requestId")
        or params.get("request_id")
        or params.get("clarify_id")
    )
    if not request_id:
        raise RpcError("INVALID_REQUEST", "clarify.respond requires requestId")
    response = params.get("response") or params.get("answer") or ""
    if not isinstance(response, str):
        response = str(response)
    # tui_gateway's clarify.respond handler reads `request_id` + `answer`
    # via `_respond(rid, params, "answer")` (verified line 3715-3717).
    try:
        result = await ctx.hermes.call(
            "clarify.respond",
            {
                "session_id": session_id,
                "request_id": request_id,
                "answer": response,
            },
        )
        return {"ok": True, "result": result}
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))


METHOD_HANDLERS["clarify.respond"] = handle_clarify_respond


async def handle_sudo_respond(params: dict, ctx: DispatchContext) -> dict:
    """User granted/denied a sudo password prompt in /app."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "sudo.respond params must be a dict")
    session_key_raw = (
        params.get("sessionKey") or params.get("session_key") or "main"
    )
    session_key = canonicalize_session_key(session_key_raw)
    _, session_id = decanonicalize_session_key(session_key)
    # Map dbkey -> live SID (engine keys _sessions by SID). See approval.respond.
    session_id = get_sid_for_dbkey(session_id) or session_id
    request_id = params.get("requestId") or params.get("request_id")
    if not request_id:
        raise RpcError("INVALID_REQUEST", "sudo.respond requires requestId")
    password = params.get("password") or ""
    try:
        result = await ctx.hermes.call(
            "sudo.respond",
            {
                "session_id": session_id,
                "request_id": request_id,
                "password": password,
            },
        )
        return {"ok": True, "result": result}
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))


METHOD_HANDLERS["sudo.respond"] = handle_sudo_respond


# -----------------------------------------------------------------
# Message edit + delete — bridge-side persistence
# -----------------------------------------------------------------
# Hermes 0.14 has NO native session.message.edit / .delete RPC. Bridge
# owns the session JSON files at `~/.hermes/sessions/session_*.json`,
# so we mutate directly + broadcast a synthetic event so /app updates.
# Telegram + Discord adapters call `edit_message`/`delete_message` on
# their platform APIs; /app equivalent is bridge-side mutation.


def _session_json_path(session_key: str):
    """Resolve the on-disk session JSON file path for a given canonical
    session_key. Mirrors `_resolve_session_path` patterns used elsewhere
    in the bridge."""
    from pathlib import Path as _Path
    _, session_id = decanonicalize_session_key(session_key)
    dbkey = get_dbkey_for_sid(session_id) or session_id
    # Path-traversal guard: dbkey comes from the client-supplied session key and
    # is interpolated into a filename, so a crafted key like "agent:main:../../x"
    # could escape the sessions dir. Strip to filename-safe chars + reject "..".
    # An over-sanitized key simply misses the (now legacy) JSON file, which is
    # safe — callers fall through to the state.db read.
    dbkey = re.sub(r"[^A-Za-z0-9._-]", "", str(dbkey or ""))
    if not dbkey or ".." in dbkey:
        dbkey = "__invalid__"
    return _Path("/home/hermes/.hermes/sessions") / f"session_{dbkey}.json"


def _parse_agentbuff_id(message_id: str) -> tuple[str | None, int | None, str | None]:
    """Parse our stable synthetic message id `agb_<dbkey>_<idx>[:suffix]`.

    Returns `(dbkey, idx, suffix_or_None)` on success, `(None, None, None)`
    if the id is not in our format (legacy / arbitrary string from a
    pre-stable-id client). Caller MUST handle the legacy path.

    Format details:
      - `agb_<dbkey>_<idx>`           ← user/system message
      - `agb_<dbkey>_<idx>:chat`      ← assistant chat-bubble (text+thinking)
      - `agb_<dbkey>_<idx>:tool<N>`   ← assistant tool_use #N
      - `agb_<dbkey>_<idx>:toolorphan`← orphan tool_result (no parent tool_use)
    All variants resolve to the same RAW source index — what differs is
    which sub-slot of the source message they referenced. For edit/delete/
    pin/reaction we just need the source index; the suffix is informational.

    `dbkey` validation matters because portal may have multiple sessions
    open simultaneously — verifying the id belongs to the session the RPC
    is targeting prevents cross-session contamination.
    """
    if not isinstance(message_id, str) or not message_id.startswith("agb_"):
        return None, None, None
    # Strip prefix, then split off optional suffix, then split dbkey vs index.
    body = message_id[len("agb_"):]
    suffix: str | None = None
    if ":" in body:
        body, suffix = body.split(":", 1)
    # dbkey contains underscores (e.g. "20260523_181530_f65212") so rsplit.
    if "_" not in body:
        return None, None, None
    dbkey, idx_str = body.rsplit("_", 1)
    try:
        idx = int(idx_str)
    except (TypeError, ValueError):
        return None, None, None
    return dbkey, idx, suffix


def _find_raw_message_by_id(
    raw_messages: list,
    message_id: str,
    session_dbkey: str,
) -> int:
    """Locate the index in `raw_messages` for an agentbuff-stable id, with
    legacy fallback. Returns -1 if not found.

    Strategy:
      1. Try parsing as `agb_<dbkey>_<idx>` (Phase 1+ ids) — if dbkey
         matches AND idx in range, return idx directly. O(1).
      2. Legacy fallback: linear scan for `msg.get("id") == message_id`.
         Pre-Phase-1 clients passed client-side UUIDs which Hermes never
         persisted to JSON, so this scan almost always misses — but we
         keep it so an external integration that DOES write `id` fields
         (custom skill, future Hermes version) still works.
    """
    dbkey, idx, _ = _parse_agentbuff_id(message_id)
    if dbkey is not None and idx is not None:
        # If dbkey mismatch, fall through to legacy scan (covers the rare
        # case where session was renamed/copied between persist + lookup).
        if dbkey == session_dbkey and 0 <= idx < len(raw_messages):
            if isinstance(raw_messages[idx], dict):
                return idx
    # Legacy: explicit msg.id field (Hermes doesn't write it but some
    # adapters / future versions might).
    for i, msg in enumerate(raw_messages):
        if isinstance(msg, dict) and msg.get("id") == message_id:
            return i
    return -1


async def handle_messages_edit(params: dict, ctx: DispatchContext) -> dict:
    """Mutate a message's text content in the persisted session JSON.
    Idempotent — re-running the same edit is a no-op. Broadcasts a
    synthetic `message.edited` event for live transcripts.
    """
    import json as _json
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "messages.edit params must be a dict")
    session_key = canonicalize_session_key(
        params.get("sessionKey") or params.get("session_key") or "main",
    )
    message_id = params.get("messageId") or params.get("message_id")
    new_text = params.get("newText") or params.get("new_text") or params.get("text")
    if not message_id or not isinstance(new_text, str):
        raise RpcError("INVALID_REQUEST", "messages.edit requires messageId + newText")
    json_path = _session_json_path(session_key)
    if not json_path.is_file():
        raise RpcError("NOT_FOUND", f"session file not found: {session_key}")
    try:
        data = _json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RpcError("INTERNAL_ERROR", f"failed to read session: {exc}")
    raw_messages = data.get("messages") or []
    # Resolve message_id via stable-id parser (Phase 1) with legacy fallback.
    _, session_id_dbkey = decanonicalize_session_key(session_key)
    dbkey = get_dbkey_for_sid(session_id_dbkey) or session_id_dbkey
    target_idx = _find_raw_message_by_id(raw_messages, message_id, dbkey)
    if target_idx < 0:
        raise RpcError("NOT_FOUND", f"message {message_id} not in session {session_key}")
    msg = raw_messages[target_idx]
    updated_count = 0
    if isinstance(msg.get("content"), str):
        msg["content"] = new_text
        msg["editedAt"] = int(__import__("time").time() * 1000)
        updated_count = 1
    elif isinstance(msg.get("content"), list):
        for block in msg["content"]:
            if isinstance(block, dict) and block.get("type") == "text":
                block["text"] = new_text
                break
        msg["editedAt"] = int(__import__("time").time() * 1000)
        updated_count = 1
    if updated_count == 0:
        raise RpcError("INVALID_REQUEST", f"message {message_id} has no editable text content")
    try:
        json_path.write_text(
            _json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        raise RpcError("INTERNAL_ERROR", f"failed to write session: {exc}")
    # Broadcast live `message.edited` event to all connected WS clients
    # so /app instances on this session update without a refresh.
    try:
        if ctx.bridge_app is not None:
            await ctx.bridge_app._broadcast_event({
                "type": "event",
                "event": "message.edited",
                "payload": {
                    "sessionKey": session_key,
                    "messageId": message_id,
                    "newText": new_text,
                    "editedAt": int(__import__("time").time() * 1000),
                },
            })
    except Exception:
        pass
    return {"ok": True, "updated": updated_count}


METHOD_HANDLERS["messages.edit"] = handle_messages_edit


def _deletions_json_path():
    """Per-bridge soft-delete OVERLAY store. Keyed <dbkey> → {<rawIdx>: deletedAtMs}.
    Hermes 0.16.0 stopped writing session_<dbkey>.json (transcripts live in
    state.db), so the old in-JSON `deleted` flag had nowhere to persist. This
    sidecar is the source of truth, applied at READ time in
    _claude_blocks_from_raw_messages — deletions survive refresh WITHOUT ever
    writing the engine's state.db (zero race with the live append path)."""
    from pathlib import Path as _Path
    return _Path("/home/hermes/.hermes/deletions.json")


def _load_deletions(dbkey: str) -> dict:
    """Return {<rawIdx:str>: deletedAtMs} for a dbkey (empty on any error)."""
    import json as _json
    try:
        p = _deletions_json_path()
        if not p.is_file():
            return {}
        return dict((_json.loads(p.read_text(encoding="utf-8")).get(dbkey)) or {})
    except Exception:
        return {}


def _profile_base_for_session(session_key: str):
    """(dbkey, base_dir) for a canonical session key — profile-aware (a
    non-default agent's transcript lives under profiles/<agent>/). Mirrors
    handle_sessions_get's base resolution."""
    import os as _os
    agent_id, session_id_dbkey = decanonicalize_session_key(session_key)
    dbkey = get_dbkey_for_sid(session_id_dbkey) or session_id_dbkey
    home = _os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
    if agent_id and agent_id not in ("main", "default"):
        cand = f"{home}/profiles/{agent_id}"
        base = cand if _os.path.isdir(cand) else home
    else:
        base = home
    return dbkey, base


def _raw_messages_for_session(session_key: str) -> list:
    """Load the raw transcript for a session — legacy JSON if it exists, else
    state.db (0.16.0). Used by messages.delete to resolve a stable id → raw idx."""
    import json as _json
    from pathlib import Path as _Path
    dbkey, base = _profile_base_for_session(session_key)
    json_path = _Path(base) / "sessions" / f"session_{dbkey}.json"
    if json_path.is_file():
        try:
            return _json.loads(json_path.read_text(encoding="utf-8")).get("messages") or []
        except Exception:
            pass
    try:
        return _raw_messages_from_db(f"{base}/state.db", dbkey) or []
    except Exception:
        return []


async def handle_messages_delete(params: dict, ctx: DispatchContext) -> dict:
    """Soft-delete a message via a bridge-side OVERLAY. Hermes has no native
    message.delete, and 0.16.0 no longer writes session_<dbkey>.json (so the old
    in-JSON flag silently 404'd on the live engine — a dead 'Hapus pesan'
    button). We record the raw-message index in a sidecar (deletions.json) and
    stamp `deleted` at READ time in the transcript reconstructor — the delete
    survives refresh with ZERO state.db writes (no race with the live engine) and
    keeps the message slot so tool_use→tool_result pairing stays intact."""
    import json as _json
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "messages.delete params must be a dict")
    session_key = canonicalize_session_key(
        params.get("sessionKey") or params.get("session_key") or "main",
    )
    message_id = params.get("messageId") or params.get("message_id")
    if not message_id:
        raise RpcError("INVALID_REQUEST", "messages.delete requires messageId")
    dbkey, _base = _profile_base_for_session(session_key)
    raw_messages = _raw_messages_for_session(session_key)
    target_idx = _find_raw_message_by_id(raw_messages, message_id, dbkey)
    if target_idx < 0:
        raise RpcError("NOT_FOUND", f"message {message_id} not in session {session_key}")

    now_ms = int(__import__("time").time() * 1000)
    sp = _deletions_json_path()
    try:
        store = _json.loads(sp.read_text(encoding="utf-8")) if sp.is_file() else {}
    except Exception:
        store = {}
    bucket = dict(store.get(dbkey) or {})
    bucket[str(target_idx)] = now_ms
    store[dbkey] = bucket
    try:
        sp.write_text(_json.dumps(store, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as exc:
        raise RpcError("INTERNAL_ERROR", f"failed to persist deletion: {exc}")

    try:
        if ctx.bridge_app is not None:
            await ctx.bridge_app._broadcast_event({
                "type": "event",
                "event": "message.deleted",
                "payload": {
                    "sessionKey": session_key,
                    "messageId": message_id,
                    "deletedAt": now_ms,
                },
            })
    except Exception:
        pass
    return {"ok": True, "updated": 1}


METHOD_HANDLERS["messages.delete"] = handle_messages_delete


# -----------------------------------------------------------------
# Reactions — bridge-side persistence for cross-channel sync
# -----------------------------------------------------------------


def _reactions_json_path():
    """Returns the per-bridge reactions store JSON path."""
    from pathlib import Path as _Path
    return _Path("/home/hermes/.hermes/reactions.json")


async def handle_reactions_set(params: dict, ctx: DispatchContext) -> dict:
    """Persist reaction add/remove. Per-bridge JSON file keyed by
    `<sessionKey>:<messageId>` → `{emoji: [userIds]}`. /app uses
    localStorage for the same data; this RPC enables cross-channel
    sync (e.g. /app reacts → bridge can call Telegram's add_reaction
    on the original message). Iter 6 baseline: just persist."""
    import json as _json
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "reactions.set params must be a dict")
    session_key = canonicalize_session_key(
        params.get("sessionKey") or params.get("session_key") or "main",
    )
    message_id = params.get("messageId") or params.get("message_id")
    emoji = params.get("emoji")
    user_id = params.get("userId") or params.get("user_id") or "chief"
    add = bool(params.get("add", True))
    if not message_id or not emoji:
        raise RpcError("INVALID_REQUEST", "reactions.set requires messageId + emoji")
    json_path = _reactions_json_path()
    try:
        data = _json.loads(json_path.read_text(encoding="utf-8")) if json_path.is_file() else {}
    except Exception:
        data = {}
    bucket_key = f"{session_key}:{message_id}"
    bucket = data.get(bucket_key) or {}
    users = list(bucket.get(emoji) or [])
    if add and user_id not in users:
        users.append(user_id)
    elif not add and user_id in users:
        users = [u for u in users if u != user_id]
    if users:
        bucket[emoji] = users
    else:
        bucket.pop(emoji, None)
    if bucket:
        data[bucket_key] = bucket
    else:
        data.pop(bucket_key, None)
    try:
        json_path.write_text(
            _json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    except Exception as exc:
        log.warning("reactions.set persist failed: %s", exc)
    # Broadcast live reaction update so other /app instances see it.
    try:
        if ctx.bridge_app is not None:
            await ctx.bridge_app._broadcast_event({
                "type": "event",
                "event": "reaction.changed",
                "payload": {
                    "sessionKey": session_key,
                    "messageId": message_id,
                    "emoji": emoji,
                    "userId": user_id,
                    "add": add,
                    "count": len(users),
                },
            })
    except Exception:
        pass
    # Cross-channel sync — if the original message lived on a Hermes
    # platform channel (Telegram, Discord, Slack), forward the reaction
    # to that channel via its adapter. Best-effort; failures don't break
    # the /app-local persistence above.
    try:
        await _sync_reaction_to_origin_channel(
            ctx, session_key, message_id, emoji, add,
        )
    except Exception:
        log.debug("cross-channel reaction sync skipped", exc_info=True)
    return {"ok": True, "count": len(users)}


async def _sync_reaction_to_origin_channel(
    ctx: DispatchContext,
    session_key: str,
    message_id: str,
    emoji: str,
    add: bool,
) -> None:
    """Best-effort: if the message originated on a Telegram/Discord/Slack
    channel, propagate the reaction to the original platform via the
    channel adapter's `add_reaction` / `remove_reaction` API.

    The Hermes session JSON tracks per-message `channel` + `chat_id` +
    `message_id` for cross-channel-originated messages. /app-originated
    messages have no `channel` field → silently skipped.
    """
    import json as _json
    json_path = _session_json_path(session_key)
    if not json_path.is_file():
        return
    try:
        data = _json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        return
    for msg in data.get("messages") or []:
        if not isinstance(msg, dict) or msg.get("id") != message_id:
            continue
        channel = msg.get("channel") or msg.get("source")
        chat_id = msg.get("chat_id") or msg.get("chatId")
        platform_message_id = msg.get("platformMessageId") or msg.get("platform_message_id")
        if not channel or not chat_id or not platform_message_id:
            return  # /app-originated, nothing to sync
        # Forward via Hermes' channel adapter — Hermes exposes a generic
        # `adapter.reaction` RPC for this (best-effort; may not exist
        # on older Hermes versions).
        try:
            await ctx.hermes.call(
                "adapter.reaction",
                {
                    "channel": channel,
                    "chat_id": chat_id,
                    "message_id": platform_message_id,
                    "emoji": emoji,
                    "action": "add" if add else "remove",
                },
            )
        except Exception:
            log.debug(
                "adapter.reaction RPC unavailable; reaction stays /app-local",
                exc_info=True,
            )
        return


METHOD_HANDLERS["reactions.set"] = handle_reactions_set


async def handle_reactions_list(params: dict, ctx: DispatchContext) -> dict:
    """Return all reactions for a session (used by /app on load to
    populate the local cache from persisted state)."""
    import json as _json
    if not isinstance(params, dict):
        params = {}
    session_key = canonicalize_session_key(
        params.get("sessionKey") or params.get("session_key") or "main",
    )
    json_path = _reactions_json_path()
    try:
        data = _json.loads(json_path.read_text(encoding="utf-8")) if json_path.is_file() else {}
    except Exception:
        data = {}
    prefix = f"{session_key}:"
    out: dict = {}
    for key, bucket in data.items():
        if key.startswith(prefix):
            message_id = key[len(prefix):]
            out[message_id] = bucket
    return {"reactions": out}


METHOD_HANDLERS["reactions.list"] = handle_reactions_list


async def handle_voice_tts_play(params: dict, ctx: DispatchContext) -> dict:
    """Generate TTS audio from text via Hermes' text_to_speech tool.

    Provider is read from `~/.hermes/config.yaml::tts.provider`. The
    `_seed_initial_config` migration in agentbuff_bridge.py auto-picks
    "gemini" (re-uses the GEMINI_API_KEY already in .env). Hermes'
    `_generate_gemini_tts` calls Google's official generateContent
    endpoint with `responseModalities: ["AUDIO"]` and wraps the
    returned 24kHz PCM as MP3 (via ffmpeg) or WAV (no ffmpeg fallback).

    Failure modes we surface as user-friendly Bahasa errors:
      - Empty/very-short text: Gemini returns finishReason="OTHER" and
        no content. The Hermes tool raises "malformed: 'content'" which
        we translate to "Teks terlalu singkat".
      - Provider down (edge-tts 403, gtts 403): same translation —
        anything that returned no audio file is surfaced as
        "Sintesis suara gagal — coba lagi" rather than dumping the
        provider's raw error text into the UI.
      - Safety filter: same translation; we can't reliably tell which
        triggered without inspecting the API response body, and the
        retry usually succeeds.

    Used by /app voice mode + per-bubble play button (`🔊` icon on
    every assistant message).
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "voice.tts.play params must be a dict")
    text = (params.get("text") or "").strip()
    if not text:
        raise RpcError("INVALID_REQUEST", "voice.tts.play requires text")
    # Gemini TTS occasionally returns finishReason=OTHER (no content)
    # for trivially short input (≤2 chars in testing). Hermes' tool
    # raises a generic exception in that case. Pre-filter to avoid
    # paying for the round-trip and to give the user actionable feedback.
    if len(text) < 3:
        raise RpcError(
            "INVALID_REQUEST",
            "Teks terlalu singkat untuk dibuat audio (minimal 3 karakter).",
        )
    try:
        import media_serve
        from tools.tts_tool import text_to_speech_tool
        import json as _json
        # Gemini TTS occasionally returns finishReason="OTHER" (no audio
        # content) even for valid text — verified via direct API probe
        # (3 identical calls: 2 STOP, 1 OTHER). Treat as transient and
        # retry up to 3x with a short backoff. Empirically 2 retries
        # almost always succeed.
        MAX_TRIES = 3
        result: dict = {}
        last_err = ""
        for attempt in range(MAX_TRIES):
            # Run the sync I/O-bound TTS in a thread
            result_str = await asyncio.to_thread(text_to_speech_tool, text)
            try:
                result = _json.loads(result_str)
            except Exception:
                result = {"success": False, "error": result_str}
            if result.get("success"):
                break
            last_err = (result.get("error") or "TTS gagal").lower()
            # Retryable: Gemini "malformed/no content" (finishReason=OTHER)
            # and explicit rate/quota signals. Anything else (api_key
            # invalid, file_not_found, etc.) is non-retryable.
            is_retryable = (
                "malformed" in last_err
                or "no audio data" in last_err
                or "empty audio" in last_err
                or "no audio" in last_err
                or "rate" in last_err
                or "429" in last_err
            )
            if not is_retryable or attempt == MAX_TRIES - 1:
                break
            # Short backoff: 250ms, 500ms — keeps total ≤ 1s in worst case.
            await asyncio.sleep(0.25 * (attempt + 1))

        if not result.get("success"):
            raw_err = last_err
            # Translate cryptic provider errors to Bahasa for /app users.
            if "malformed" in raw_err or "no audio data" in raw_err or "empty audio" in raw_err or "no audio" in raw_err:
                friendly = (
                    "Sintesis suara gagal setelah 3 percobaan. "
                    "Coba lagi atau perpanjang/perpendek teksnya."
                )
            elif "403" in raw_err or "rate" in raw_err or "quota" in raw_err or "429" in raw_err:
                friendly = (
                    "Provider TTS sedang dibatasi. Coba lagi dalam "
                    "beberapa detik."
                )
            elif "api_key" in raw_err or "unauthorized" in raw_err or "401" in raw_err:
                friendly = "API key TTS tidak valid atau belum di-set."
            else:
                # Surface raw error truncated so user sees actionable hint.
                friendly = f"Sintesis suara gagal: {(result.get('error') or 'unknown')[:120]}"
            raise RpcError("INTERNAL_ERROR", friendly)
        file_path = result.get("file_path")
        if not file_path:
            raise RpcError("INTERNAL_ERROR", "TTS returned no file_path")
        # Register the produced file with media_serve for HTTP delivery —
        # DURABLE url (survives the 24h cache TTL + container restart).
        import os as _os
        public_host = _os.environ.get("BRIDGE_PUBLIC_HOST") or "127.0.0.1"
        try:
            public_port = int(
                _os.environ.get("BRIDGE_PUBLIC_HEALTH_PORT")
                or _os.environ.get("BRIDGE_HEALTH_PORT")
                or "18790"
            )
        except (TypeError, ValueError):
            public_port = 18790
        url = media_serve.public_url_durable(
            file_path,
            host=public_host,
            port=public_port,
        )
        if not url:
            raise RpcError(
                "INTERNAL_ERROR",
                f"media_serve refused to register {file_path}",
            )
        return {
            "ok": True,
            "displayUrl": url,
            "filePath": file_path,
            "provider": result.get("provider", "gtts"),
            "voice": result.get("voice", "gtts-id"),
            "sizeBytes": _os.path.getsize(file_path) if _os.path.exists(file_path) else None,
        }
    except RpcError:
        raise
    except Exception as exc:
        log.exception("voice.tts.play crashed")
        raise RpcError("INTERNAL_ERROR", str(exc))


METHOD_HANDLERS["voice.tts.play"] = handle_voice_tts_play


async def handle_cron_schedule_prompt(params: dict, ctx: DispatchContext) -> dict:
    """Schedule a chat prompt for later delivery via Hermes' cron tool.
    Translates `{when, prompt, sessionKey}` → Hermes' cron job creation
    RPC. The cron job, when fired, submits the prompt to the same
    session as a regular user message.

    Telegram/Discord parity: clock-icon scheduled messages.
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.schedule_prompt params must be a dict")
    session_key = canonicalize_session_key(
        params.get("sessionKey") or params.get("session_key") or "main",
    )
    _, session_id = decanonicalize_session_key(session_key)
    when = params.get("when")
    prompt = params.get("prompt") or params.get("text")
    if not when or not prompt:
        raise RpcError("INVALID_REQUEST", "cron.schedule_prompt requires when + prompt")
    # Hermes' cron tool accepts ISO-8601 + a target sessionId. Forward
    # via the generic dispatch RPC — Hermes' cronjob tool registers
    # the schedule + handles the trigger internally.
    # Hermes exposes `cron.manage` (action=add) — see tui_gateway/server.py:6478.
    # Convert ISO date → cron expression (one-shot at minute granularity).
    # For "fire once at X" semantics we set the cron to that specific
    # minute. Hermes' cron tool will fire at the next match and the
    # one-shot behavior comes from the schedule itself.
    from datetime import datetime as _dt
    try:
        dt = _dt.fromisoformat(when.replace("Z", "+00:00"))
        cron_expr = f"{dt.minute} {dt.hour} {dt.day} {dt.month} *"
    except Exception:
        raise RpcError("INVALID_REQUEST", f"unparseable date: {when!r}")
    job_name = f"app-{session_id}-{int(__import__('time').time())}"
    try:
        result = await ctx.hermes.call(
            "cron.manage",
            {
                "action": "add",
                "name": job_name,
                "schedule": cron_expr,
                "prompt": prompt,
            },
        )
        return {"ok": True, "jobId": job_name, "result": result, "cronExpr": cron_expr}
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))


METHOD_HANDLERS["cron.schedule_prompt"] = handle_cron_schedule_prompt


# -----------------------------------------------------------------
# Sessions methods — mostly forward, some translation
# -----------------------------------------------------------------

# Hermes' `source` axis is granular (tui, chat, telegram, whatsapp, ...)
# while the portal's Sessions tab filters along a coarser kind axis
# (direct / group / global / unknown). One-to-many mapping; everything
# we know to be a person-to-person chat becomes "direct", everything else
# falls through to "unknown" so the filter chip still shows a count.
_PORTAL_KIND_BY_SOURCE = {
    "tui": "direct",
    "chat": "direct",
    # Channel adapters surface in the Sessions archive too — group them
    # under direct so they're visible by default. The Channels tab is the
    # source-of-truth view; this is just the unified archive.
    "telegram": "direct",
    "whatsapp": "direct",
    "discord": "direct",
    "slack": "direct",
    "google_chat": "direct",
    "google-chat": "direct",
    "googlechat": "direct",
    "webhook": "direct",
}


def _map_hermes_source_to_kind(source: Optional[str]) -> str:
    if not source:
        return "unknown"
    s = str(source).strip().lower()
    return _PORTAL_KIND_BY_SOURCE.get(s, "unknown")


#
# Model → context window (token capacity) lookup table.
# Used to derive `contextTokens` for each session (Hermes doesn't store this
# per-session; it's a model-fixed property). Add new models as they ship.
# Keys MUST be the suffix after provider prefix (e.g. "gemini-3-flash-preview").
#
_MODEL_CONTEXT_WINDOW: dict[str, int] = {
    # Google Gemini
    "gemini-3-flash-preview": 1_000_000,
    "gemini-3-flash": 1_000_000,
    "gemini-3-pro": 2_000_000,
    "gemini-2.5-flash": 1_000_000,
    "gemini-2.5-pro": 2_000_000,
    "gemini-2.0-flash": 1_000_000,
    "gemini-1.5-flash": 1_000_000,
    "gemini-1.5-pro": 2_000_000,
    # Anthropic Claude
    "claude-opus-4-7": 200_000,
    "claude-opus-4-6": 200_000,
    "claude-opus-4-5": 200_000,
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-haiku-4-5": 200_000,
    "claude-3-7-sonnet": 200_000,
    "claude-3-5-sonnet": 200_000,
    "claude-3-5-haiku": 200_000,
    "claude-3-opus": 200_000,
    # DeepSeek
    "deepseek-chat": 128_000,
    "deepseek-reasoner": 128_000,
    "deepseek-v3": 128_000,
    # Qwen
    "qwen-max": 128_000,
    "qwen-plus": 128_000,
    "qwen-turbo": 32_768,
    "qwen3-coder": 256_000,
    # OpenAI
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4.1": 1_000_000,
    "gpt-4.1-mini": 1_000_000,
    "o1": 200_000,
    "o1-mini": 128_000,
    "o3": 200_000,
    "o3-mini": 200_000,
    # Kimi
    "kimi-k2": 128_000,
    "moonshot-v1-128k": 128_000,
    # xAI
    "grok-2": 131_072,
    "grok-3": 131_072,
    # Z.AI / GLM
    "glm-4.5": 128_000,
    "glm-4.6": 200_000,
}


def _lookup_context_window(model: Optional[str]) -> Optional[int]:
    """Derive context-window token count from model name."""
    if not model:
        return None
    # Strip provider prefix (e.g. "google/gemini-3-flash" → "gemini-3-flash")
    name = str(model).split("/", 1)[-1].strip().lower()
    if name in _MODEL_CONTEXT_WINDOW:
        return _MODEL_CONTEXT_WINDOW[name]
    # Fuzzy match: try removing version suffixes like "-preview", "-2026-04-22"
    for key, ctx in _MODEL_CONTEXT_WINDOW.items():
        if name.startswith(key) or key.startswith(name):
            return ctx
    return None


#
# Provider detection by model-name prefix. Used when the model string doesn't
# carry an explicit provider/ prefix (Hermes' SQLite stores raw names like
# "gemini-3-flash-preview"). Keep in lockstep with _MODEL_CONTEXT_WINDOW so
# every model we know the context window for also gets a provider badge.
#
_PROVIDER_BY_MODEL_PREFIX: list[tuple[str, str]] = [
    ("gemini-", "google"),
    ("claude-", "anthropic"),
    ("gpt-", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("deepseek-", "deepseek"),
    ("qwen", "qwen"),
    ("kimi-", "kimi"),
    ("moonshot-", "kimi"),
    ("grok-", "xai"),
    ("glm-", "z.ai"),
    ("llama-", "meta"),
    ("mistral-", "mistral"),
    ("mixtral-", "mistral"),
]


def _parse_model_provider(model: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Parse model → (provider, name). Two paths:

    1. Explicit prefix:  "google/gemini-3-flash" → ("google", "gemini-3-flash")
    2. Prefix-detection: "gemini-3-flash"        → ("google", "gemini-3-flash")

    Returns (None, None) only for empty input.
    """
    if not model:
        return (None, None)
    s = str(model).strip()
    if "/" in s:
        provider, _, name = s.partition("/")
        return (provider.strip() or None, name.strip() or None)
    # No explicit prefix — sniff from model-name prefix.
    lower = s.lower()
    for prefix, provider in _PROVIDER_BY_MODEL_PREFIX:
        if lower.startswith(prefix):
            return (provider, s)
    return (None, s or None)


def _derive_status(end_reason: Optional[str], ended_at: Optional[float]) -> tuple[str, bool]:
    """Map Hermes `end_reason` → portal status enum + abortedLastRun flag.

    Hermes end_reason values (from observation):
      - None / "" with ended_at=None → session active or never finished
      - "tui_shutdown" → process exit, neutral
      - "user_abort" / "aborted" → user pressed stop
      - "error" / "failed" → run errored
      - "timeout" → exceeded time budget
      - "killed" → forcibly stopped
      - "done" / "complete" → normal end
    """
    if not end_reason and not ended_at:
        return ("running", False)
    er = (end_reason or "").lower().strip()
    if "user_abort" in er or "aborted" in er or "user_cancel" in er or er == "killed":
        return ("killed", True)
    if "fail" in er or er == "error":
        return ("failed", False)
    if "timeout" in er:
        return ("timeout", False)
    return ("done", False)


def _resolve_session_agent_map() -> dict[str, str]:
    """Build source-string → agentId map so sessions.list can tag each row
    with its OWNING agent, independent of channel.

    The engine does NOT persist an agent id on session rows — it only stores
    `source` (e.g. "tui", "whatsapp__kiwi", "telegram__sales"). But the agent
    that owns a synthetic channel account IS recorded in config under
    `platforms.<id>.extra.agent_id`. We invert that into a lookup keyed by the
    raw source string (lowercased) so the per-session resolver can answer
    "whose agent is this session?" purely from `source`.

    Result keys:
      - each synthetic platform id ("whatsapp__kiwi") → its agent_id ("kiwi")
      - the base channel ("whatsapp") also maps to that agent_id when the base
        has exactly one bound account (best-effort; ambiguous bases are skipped)

    Web / app / dev sources (tui/cli/api_server/chat/...) are intentionally
    ABSENT — the resolver falls back to "default" for those.
    """
    import os
    try:
        import yaml
    except ImportError:
        return {}
    cfg_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/config.yaml"
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except Exception as e:
        log.debug("resolve_session_agent_map: read %s failed: %s", cfg_path, e)
        return {}
    platforms = cfg.get("platforms") if isinstance(cfg.get("platforms"), dict) else {}
    out: dict[str, str] = {}
    base_counts: dict[str, set[str]] = {}
    for pid, pcfg in platforms.items():
        if not isinstance(pcfg, dict):
            continue
        extra = pcfg.get("extra") if isinstance(pcfg.get("extra"), dict) else {}
        aid = (extra.get("agent_id") or "").strip()
        if not aid:
            continue
        out[str(pid).strip().lower()] = aid
        base = (extra.get("base_channel") or "").strip().lower()
        if base:
            base_counts.setdefault(base, set()).add(aid)
    # Map base channel → agent only when unambiguous (single bound account).
    for base, aids in base_counts.items():
        if len(aids) == 1 and base not in out:
            out[base] = next(iter(aids))
    return out


def _agent_id_for_source(source: str | None, agent_map: dict[str, str]) -> str:
    """Resolve the owning agent id for a session given its raw `source`.

    Channel sources resolve via the platforms map; everything else (web / app /
    cli / unknown) belongs to the default agent. Returns the normalized id used
    by the agents catalog ("default" for the house agent)."""
    if not source:
        return "default"
    return agent_map.get(source.strip().lower(), "default")


def _read_behavior_config_from_yaml() -> dict[str, Any]:
    """Read PERILAKU AI settings from ~/.hermes/config.yaml.

    Hermes persists these globally via `/reasoning`, `/fast`, `/verbose`
    slash commands. Same values apply to all the agent's sessions until
    chief changes them again. We surface them per-row in sessions.list
    response so the drawer's dropdowns show the current state on open.
    """
    import os
    try:
        import yaml
    except ImportError:
        return {}
    cfg_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/config.yaml"
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except Exception as e:
        log.debug("read_behavior_config: failed to read %s: %s", cfg_path, e)
        return {}
    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    display = cfg.get("display") if isinstance(cfg.get("display"), dict) else {}
    sections = display.get("sections") if isinstance(display.get("sections"), dict) else {}

    # reasoning_effort: "" | "minimal" | "low" | "medium" | "high" | "xhigh"
    reasoning_effort = (agent.get("reasoning_effort") or "").strip().lower() or None

    # service_tier values di config.yaml: "" (normal) | "priority" | "fast"
    # In-memory agent.service_tier = "priority" when /fast on; saved config
    # writes "fast" (per _handle_fast_command save_config_value); our bridge
    # direct-write also uses "fast". Read all three forms as truthy.
    service_tier = (agent.get("service_tier") or "").strip().lower()
    if service_tier in ("priority", "fast"):
        fast_mode = True
    elif service_tier in ("", "normal"):
        fast_mode = False
    else:
        fast_mode = None

    # tool_progress: bool true | "off" | "new" | "all" | "verbose" → UI vocab.
    # MUST tolerate bool (vanilla stores tool_progress: true) — `.strip()` on a
    # bool crashes. true == verbose-on (→ "full"); false == off.
    tp_raw = display.get("tool_progress")
    if tp_raw is True:
        verbose_level = "full"
    elif tp_raw is False:
        verbose_level = "off"
    else:
        tp = str(tp_raw or "").strip().lower()
        if tp == "verbose":
            verbose_level = "full"
        elif tp in ("all", "new"):
            verbose_level = "on"
        elif tp == "off":
            verbose_level = "off"
        else:
            verbose_level = None

    # show_reasoning: bool | "all" (vanilla) + sections.thinking: "expanded"|"hidden"
    # Translate Hermes vocab → portal UI vocab so drawer dropdown matches.
    # UI options: "" (default) | "off" | "on" | "stream". Vanilla uses the
    # string "all" — treat it (and bool true / expanded) as reasoning-on.
    show_reasoning = display.get("show_reasoning")
    sr_str = str(show_reasoning).strip().lower() if isinstance(show_reasoning, str) else ""
    section_thinking = (sections.get("thinking") or "").strip().lower()
    if show_reasoning is True or sr_str == "all" or section_thinking == "expanded":
        reasoning_level = "on"
    elif show_reasoning is False or sr_str in ("off", "none", "hidden") or section_thinking == "hidden":
        reasoning_level = "off"
    else:
        reasoning_level = None

    return {
        "thinkingLevel": reasoning_effort,  # /reasoning <level> writes here
        "fastMode": fast_mode,
        "verboseLevel": verbose_level,
        "reasoningLevel": reasoning_level,
    }


_PEER_CACHE: dict[str, tuple[str | None, str | None]] = {}


def _resolve_session_peer(source, user_id):
    """Map a session's stored peer identity to (peerId, peerLabel).

    Hermes records the channel-side counterpart in sessions.user_id:
      - WhatsApp: a LID like "21986591932644@lid" (or a "<num>@s.whatsapp.net"
        JID). LIDs resolve to a real phone number via the Baileys
        lid-mapping-<lid>_reverse.json file in that account's wa-sessions dir.
      - Telegram/Discord/Slack/etc: the raw numeric/string user id.
      - Web (tui/cli/api_server): NULL -> no peer.
    Returns (None, None) when there is no peer to show.
    """
    uid = (str(user_id).strip() if user_id is not None else "")
    if not uid:
        return (None, None)
    src = (source or "").strip().lower()
    cache_key = f"{src}|{uid}"
    if cache_key in _PEER_CACHE:
        return _PEER_CACHE[cache_key]

    peer_id = uid
    peer_label = uid

    if src.startswith("whatsapp"):
        # source shape: "whatsapp__<accountId>" (default account: default-1)
        account = "default-1"
        if "__" in src:
            account = src.split("__", 1)[1] or account
        bare = uid.split("@", 1)[0]
        is_lid = uid.endswith("@lid")
        phone = None
        if is_lid:
            try:
                import json as _json
                import os as _os
                home = _os.environ.get("HERMES_HOME", "/home/hermes/.hermes")
                mp = f"{home}/wa-sessions/{account}/lid-mapping-{bare}_reverse.json"
                with open(mp, "r", encoding="utf-8") as fh:
                    phone = (_json.load(fh) or "").strip() or None
            except Exception:
                phone = None
        digits = (phone or (bare if not is_lid else "")).strip()
        if digits.isdigit():
            peer_id = digits
            peer_label = "+" + digits
        else:
            peer_id = bare
            peer_label = bare  # LID with no phone mapping yet

    result = (peer_id, peer_label)
    _PEER_CACHE[cache_key] = result
    return result


async def handle_sessions_list(params: dict, ctx: DispatchContext) -> dict:
    """Enriched sessions list — queries SQLite directly to expose all the
    fields the portal's SessionSummary type expects.

    Hermes' native `session.list` RPC only returns 6 fields per row (id, title,
    preview, started_at, message_count, source) — too thin for the drawer's
    "Penggunaan Token", "Model", "Durasi", "Asal Sesi", "Subagent list", and
    status chips. We bypass `session.list` and read SQLite directly for the
    full 12+ field set + bulk subqueries for last-message preview and child
    sessions. One SELECT pass + 2 small subqueries = fast even for 200+ rows.

    Additionally surfaces the global PERILAKU AI settings from config.yaml
    (per the Hermes design: /reasoning, /fast, /verbose write to config, not
    per-session SQLite columns). Same values applied to every row so the
    drawer dropdowns reflect current agent-wide state regardless of which
    session is being viewed.
    """
    import os
    import sqlite3

    db_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/state.db"
    deny_sources = {"tool"}  # mirror Hermes session.list deny-list
    limit = 200
    try:
        limit_param = int((params or {}).get("limit", 200) or 200)
        limit = max(1, min(500, limit_param))
    except (TypeError, ValueError):
        limit = 200

    # Single behavior-config read for this RPC — applied to every row.
    behavior = _read_behavior_config_from_yaml()
    # source → owning-agent map (channel accounts carry agent_id in config).
    agent_map = _resolve_session_agent_map()

    normalized: list[dict] = []
    seen_ids: set[str] = set()
    session_ids_for_subquery: list[str] = []

    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        cur = conn.cursor()
        # Mirror the engine's list_sessions_rich visibility filter (hermes_state.py
        # list_sessions_rich, default include_archived=False): hide archived rows
        # + hide child sessions (subagent runs + compression continuations carry a
        # parent_session_id) EXCEPT explicit branches. Without this the chat-history
        # list showed archived sessions, raw subagent runs, and duplicate
        # compression continuations the engine intends to hide. (Audit A3.)
        cur.execute(
            """
            SELECT id, source, model, started_at, ended_at, end_reason,
                   message_count, input_tokens, output_tokens, parent_session_id,
                   title, reasoning_tokens, user_id
            FROM sessions s
            WHERE archived = 0
              AND (s.parent_session_id IS NULL
                   OR EXISTS (SELECT 1 FROM sessions p
                              WHERE p.id = s.parent_session_id
                                AND p.end_reason = 'branched'
                                AND s.started_at >= p.ended_at))
            ORDER BY COALESCE(ended_at, started_at) DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()

        # Bulk-fetch: last message preview per session.
        # SQLite-friendly approach: for each session, get the most recent
        # user/assistant message body. We use a window function via subquery.
        session_ids = [r[0] for r in rows if r[0]]
        last_msg_by_session: dict[str, str] = {}
        last_ts_by_session: dict[str, float] = {}
        child_by_parent: dict[str, list[str]] = {}
        if session_ids:
            placeholders = ",".join("?" * len(session_ids))
            # Bulk last message preview (first 200 chars of most recent message)
            cur.execute(
                f"""
                SELECT m.session_id, m.content
                FROM messages m
                INNER JOIN (
                    SELECT session_id, MAX(timestamp) AS max_ts
                    FROM messages
                    WHERE session_id IN ({placeholders})
                      AND role IN ('user', 'assistant')
                      AND content IS NOT NULL
                      AND content != ''
                    GROUP BY session_id
                ) latest
                  ON m.session_id = latest.session_id
                 AND m.timestamp = latest.max_ts
                """,
                session_ids,
            )
            for sid, content in cur.fetchall():
                if isinstance(content, str) and content:
                    preview = content.strip()[:200]
                    last_msg_by_session[sid] = preview

            # Last ACTIVITY timestamp per session (any non-meta message). Drives
            # updatedAt so a session that JUST received a message — web OR a
            # channel turn (Telegram/WhatsApp) running in a separate process —
            # rises to the top of the sidebar (the list sorts by updatedAt).
            # started_at/ended_at only reflect creation/close, not fresh inbound
            # activity, so an old-but-just-active channel thread stayed buried.
            cur.execute(
                f"""
                SELECT session_id, MAX(timestamp) AS mts
                FROM messages
                WHERE session_id IN ({placeholders})
                  AND role != 'session_meta'
                GROUP BY session_id
                """,
                session_ids,
            )
            for sid, mts in cur.fetchall():
                if mts is not None:
                    try:
                        last_ts_by_session[sid] = float(mts)
                    except (TypeError, ValueError):
                        pass

            # Bulk: child sessions
            cur.execute(
                f"""
                SELECT parent_session_id, id
                FROM sessions
                WHERE parent_session_id IN ({placeholders})
                """,
                session_ids,
            )
            for parent, child in cur.fetchall():
                if parent and child:
                    child_by_parent.setdefault(parent, []).append(child)
        conn.close()

        for row in rows:
            (sid, source, model, started_at, ended_at, end_reason,
             msg_count, in_tok, out_tok, parent_sid, title, reasoning_tok,
             user_id) = row
            if (source or "").strip().lower() in deny_sources:
                continue
            if not sid:
                continue
            if _is_sid_tombstoned(sid):
                continue  # just-deleted — don't resurrect within the TTL window

            # ARCHITECTURE: Use dbkey as canonical public key — stable across
            # session.resume aliasing. Previously we returned the in-memory
            # sid here, which mutated the key after Kompres/chat operations
            # and broke UI references (drawer became stale, find-by-key
            # returned undefined). Events tagged with sid can resolve back
            # via sessionId field if needed.
            public_id = sid
            seen_ids.add(public_id)
            session_ids_for_subquery.append(sid)

            provider, model_name = _parse_model_provider(model)
            status, aborted = _derive_status(end_reason, ended_at)
            input_tokens = int(in_tok or 0)
            output_tokens = int(out_tok or 0)
            total_tokens = input_tokens + output_tokens
            context_tokens = _lookup_context_window(model)

            # Runtime: ended_at - started_at (in ms). If still running, current - started.
            runtime_ms = None
            if started_at:
                end_ts = ended_at if ended_at else None
                if end_ts:
                    runtime_ms = max(0, int((end_ts - started_at) * 1000))

            # Surface (channel scope hint from source). For "telegram:123" style.
            surface = source if (source and ":" in source) else None

            normalized.append({
                # Core
                "key": canonicalize_session_key(public_id),
                # Title/label echo the user's first message — verbatim prose.
                "title": title or "",
                "label": title or "",
                "kind": _map_hermes_source_to_kind(source),
                # Raw source string (tui/telegram/whatsapp/cli/api_server/...).
                # UI uses this for channel filter (separate from "kind" axis).
                "source": (source or "").strip().lower() or None,
                # Channel-side peer identity (who the agent talked to). Web
                # sessions have none. WhatsApp LIDs resolve to a phone number.
                "peer": _resolve_session_peer(source, user_id)[0],
                "peerLabel": _resolve_session_peer(source, user_id)[1],
                # Owning agent. For /app sessions the source is just "tui", so
                # _agent_id_for_source can't tell which agent the user picked —
                # use the persisted sid→agent binding (set at sessions.create)
                # first, so a kak-tutor session shows kak-tutor (not Buff). We
                # check BOTH the row id AND its dbkey/sid alias (mirrors what
                # canonicalize_session_key does for the key) so both the
                # synthetic-sid row and the real dbkey row agree. Channel
                # sessions still resolve via the source/platforms map.
                "agentId": (
                    get_agent_for_sid(public_id)
                    or get_agent_for_sid(get_dbkey_for_sid(public_id) or "")
                    or get_agent_for_sid(get_sid_for_dbkey(public_id) or "")
                    or _agent_id_for_source(source, agent_map)
                ),
                "updatedAt": last_ts_by_session.get(sid) or ended_at or started_at,
                # Tokens (kategori 2)
                "totalTokens": total_tokens if total_tokens > 0 else None,
                "inputTokens": input_tokens if input_tokens > 0 else None,
                "outputTokens": output_tokens if output_tokens > 0 else None,
                "contextTokens": context_tokens,  # kategori 3 (lookup)
                # Model
                "model": model_name,
                "modelProvider": provider,
                # Status
                "status": status,
                "abortedLastRun": aborted,
                # Runtime
                "startedAt": started_at,
                "endedAt": ended_at,
                "runtimeMs": runtime_ms,
                # Lineage
                "childSessions": child_by_parent.get(sid, []),
                "sessionId": sid,
                # Origin (only if source has format like "telegram:xxx")
                "surface": surface,
                # Preview
                "lastMessagePreview": (last_msg_by_session.get(sid, "") or None),
                # PERILAKU AI — agent-wide values from config.yaml, surfaced per-row
                "thinkingLevel": behavior.get("thinkingLevel"),
                "fastMode": behavior.get("fastMode"),
                "verboseLevel": behavior.get("verboseLevel"),
                "reasoningLevel": behavior.get("reasoningLevel"),
            })
    except sqlite3.Error as e:
        log.error("sessions.list: sqlite error: %s", e)
        raise RpcError("INTERNAL_ERROR", f"sessions DB error: {e}")

    # ── Aggregate PER-PROFILE sessions (2026-06-09) ────────────────────────
    # NON-default agents created via the wizard store their sessions + messages
    # in profiles/<agent>/state.db (persona_patch overrides HERMES_HOME per
    # turn). The root query above only sees the DEFAULT agent's sessions, so
    # every per-agent thread was MISSING from the sidebar and vanished on
    # refresh ("sesi tiba-tiba hilang"). Read each profile DB and tag its rows
    # with the owning agent (the profile dir name). Best-effort: a broken
    # profile DB is skipped, never fails the whole list.
    import glob as _glob
    _home = os.environ.get("HERMES_HOME", "/home/hermes/.hermes")
    for _pdb in _glob.glob(_home + "/profiles/*/state.db"):
        try:
            _agent = _pdb.split("/profiles/")[1].split("/")[0]
        except Exception:
            continue
        try:
            pconn = sqlite3.connect(_pdb, timeout=5.0)
            # Same engine visibility filter as the root query (A3): hide archived
            # + subagent/compression children except branches.
            prows = pconn.execute(
                "SELECT id, source, model, started_at, ended_at, end_reason, "
                "message_count, input_tokens, output_tokens, parent_session_id, "
                "title, reasoning_tokens, user_id FROM sessions s "
                "WHERE archived = 0 AND (s.parent_session_id IS NULL "
                "  OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id "
                "             AND p.end_reason = 'branched' AND s.started_at >= p.ended_at)) "
                "ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?",
                (limit,),
            ).fetchall()
            pprev: dict = {}
            plast_ts: dict = {}
            pids = [r[0] for r in prows if r[0]]
            if pids:
                ph = ",".join("?" * len(pids))
                for _sid, _content in pconn.execute(
                    "SELECT m.session_id, m.content FROM messages m INNER JOIN "
                    "(SELECT session_id, MAX(timestamp) mt FROM messages WHERE "
                    f"session_id IN ({ph}) AND role IN ('user','assistant') AND "
                    "content IS NOT NULL AND content != '' GROUP BY session_id) l "
                    "ON m.session_id=l.session_id AND m.timestamp=l.mt",
                    pids,
                ).fetchall():
                    if isinstance(_content, str) and _content:
                        pprev[_sid] = _content.strip()[:200]
                # Last-activity ts per profile session → updatedAt (rise on
                # fresh channel/web message, not creation time).
                for _sid, _mts in pconn.execute(
                    "SELECT session_id, MAX(timestamp) FROM messages WHERE "
                    f"session_id IN ({ph}) AND role != 'session_meta' "
                    "GROUP BY session_id",
                    pids,
                ).fetchall():
                    if _mts is not None:
                        try:
                            plast_ts[_sid] = float(_mts)
                        except (TypeError, ValueError):
                            pass
            pconn.close()
        except sqlite3.Error:
            continue
        for prow in prows:
            (sid, source, model, started_at, ended_at, end_reason,
             msg_count, in_tok, out_tok, parent_sid, title, reasoning_tok,
             user_id) = prow
            if (source or "").strip().lower() in deny_sources or not sid:
                continue
            if sid in seen_ids:
                continue
            if _is_sid_tombstoned(sid):
                continue  # just-deleted per-agent row — don't resurrect
            seen_ids.add(sid)
            provider, model_name = _parse_model_provider(model)
            status, aborted = _derive_status(end_reason, ended_at)
            input_tokens = int(in_tok or 0)
            output_tokens = int(out_tok or 0)
            total_tokens = input_tokens + output_tokens
            normalized.append({
                "key": canonicalize_session_key(sid, _agent),
                "title": title or "",
                "label": title or "",
                "kind": _map_hermes_source_to_kind(source),
                "source": (source or "").strip().lower() or None,
                "peer": None,
                "peerLabel": None,
                "agentId": _agent,
                "updatedAt": plast_ts.get(sid) or ended_at or started_at,
                "totalTokens": total_tokens if total_tokens > 0 else None,
                "inputTokens": input_tokens if input_tokens > 0 else None,
                "outputTokens": output_tokens if output_tokens > 0 else None,
                "contextTokens": _lookup_context_window(model),
                "model": model_name,
                "modelProvider": provider,
                "status": status,
                "abortedLastRun": aborted,
                "startedAt": started_at,
                "endedAt": ended_at,
                "runtimeMs": None,
                "childSessions": [],
                "sessionId": sid,
                "surface": (source if (source and ":" in source) else None),
                "lastMessagePreview": pprev.get(sid) or None,
                "thinkingLevel": behavior.get("thinkingLevel"),
                "fastMode": behavior.get("fastMode"),
                "verboseLevel": behavior.get("verboseLevel"),
                "reasoningLevel": behavior.get("reasoningLevel"),
            })
    # Merge order: keep the newest sessions across root + all profiles, capped.
    normalized.sort(key=lambda r: r.get("updatedAt") or 0, reverse=True)
    normalized = normalized[:limit]

    # Inject pending sids (sessions just-created but not flushed to DB yet)
    for sid, info in list(_PENDING_SIDS.items()):
        if sid in seen_ids:
            clear_pending_sid(sid)
            continue
        if _is_sid_tombstoned(sid):
            clear_pending_sid(sid)
            continue  # deleted before it ever flushed — don't surface it
        row = _pending_session_row(sid, info)
        normalized.insert(0, {
            "key": canonicalize_session_key(sid),
            "title": row["title"],
            "label": row["title"],
            "kind": _map_hermes_source_to_kind(row["source"]),
            "source": (row.get("source") or "").strip().lower() or None,
            "agentId": _agent_id_for_source(row.get("source"), agent_map),
            "updatedAt": row["updated_at"],
            "totalTokens": None,
            "inputTokens": None,
            "outputTokens": None,
            "contextTokens": None,
            "model": None,
            "modelProvider": None,
            "status": "running",  # newly created = considered active
            "abortedLastRun": False,
            "startedAt": row["updated_at"],
            "endedAt": None,
            "runtimeMs": None,
            "childSessions": [],
            "sessionId": sid,
            "surface": None,
            "lastMessagePreview": None,
            "thinkingLevel": behavior.get("thinkingLevel"),
            "fastMode": behavior.get("fastMode"),
            "verboseLevel": behavior.get("verboseLevel"),
            "reasoningLevel": behavior.get("reasoningLevel"),
        })

    return {"sessions": normalized}


METHOD_HANDLERS["sessions.list"] = handle_sessions_list


# ────────────────────────────────────────────────────────────────────────
#  sessions.search — full-text search across ALL session JSON files
# ────────────────────────────────────────────────────────────────────────
#
# Hermes Desktop equivalent: `searchSessions()` in src/main/sessions.ts:224.
# That implementation queries an SQLite FTS5 index of message bodies.
# We don't maintain that index in the bridge (single-source-of-truth =
# session JSON files on disk), so we scan-on-search.
#
# For chief's typical workload (≤500 sessions, ≤200KB each), scanning
# linearly is sub-second. If perf becomes a concern later we'll add an
# in-memory cache or migrate to a real FTS5 backend.
#
# Wire contract — params:
#   - query: str (required, ≤200 chars after trim, multi-word = AND match)
#   - limit: int (optional, default 20, capped at 100)
#
# Return shape (verified by frontend session-utils):
#   {
#     "results": [
#       {
#         "sessionKey": "agent:main:<dbkey>",
#         "title": str (derived from first user msg if empty),
#         "snippet": str (40-char context around first match, plain text),
#         "snippetHtml": str (with <mark>...</mark> around the match),
#         "matchCount": int (how many message bodies matched in this session),
#         "updatedAt": int (ms epoch, from `last_updated` field),
#         "source": str | None (session platform if known),
#         "messageCount": int (total messages in session),
#       },
#       ...
#     ],
#     "total": int (sessions scanned),
#     "query": str (echo back sanitized query),
#   }
async def handle_sessions_search(
    params: dict, ctx: DispatchContext,
) -> dict:
    import json as _json
    import re as _re
    from pathlib import Path as _Path
    from datetime import datetime as _dt

    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "sessions.search params must be a dict")

    raw_query = params.get("query")
    if not isinstance(raw_query, str):
        raise RpcError("INVALID_REQUEST", "sessions.search query must be a string")
    # Sanitize: trim, hard cap length, strip control chars, lowercase.
    query = "".join(ch for ch in raw_query.strip() if ord(ch) >= 32)[:200]
    if not query:
        return {"results": [], "total": 0, "query": ""}
    q_lower = query.lower()
    # Multi-word AND: ALL terms must appear (mimics FTS5 prefix AND match).
    terms = [t for t in q_lower.split() if t]
    if not terms:
        return {"results": [], "total": 0, "query": ""}

    limit = params.get("limit", 20)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(100, limit))

    # NOTE: engine 0.15.x+ STOPPED writing per-session session_<id>.json — the
    # old glob of /home/hermes/.hermes/sessions/session_*.json always found 0
    # files, so search silently returned nothing. We now read the SAME source of
    # truth the rest of the bridge uses (state.db, via handle_sessions_list for
    # correct keys/titles + _raw_messages_from_db for the transcript), so a hit
    # opens to exactly the session the user clicked.
    results: list[dict] = []
    total_scanned = 0

    def _content_to_str(content) -> str:
        """Flatten various content shapes to plain text for search/snippet."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text" and isinstance(block.get("text"), str):
                        parts.append(block["text"])
                    elif isinstance(block.get("content"), str):
                        parts.append(block["content"])
            return " ".join(parts)
        return ""

    def _iso_to_ms(iso_str) -> int:
        """Parse ISO datetime string to JS-style ms timestamp. Returns 0 on
        failure (so sessions still rank by file mtime fallback)."""
        if not isinstance(iso_str, str):
            return 0
        try:
            # Handle "+00:00" + bare ISO + naive datetime
            s = iso_str.strip()
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = _dt.fromisoformat(s)
            return int(dt.timestamp() * 1000)
        except (ValueError, TypeError):
            return 0

    def _html_escape(text: str) -> str:
        """Minimal HTML escape — prevent injection from session content."""
        return (
            text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;")
        )

    def _make_snippet(content: str, match_pos: int, match_len: int) -> tuple[str, str]:
        """Return (plain_snippet, html_snippet_with_mark) for the match.

        Context: 20 chars before + match + 20 chars after. Adds ellipsis
        prefix/suffix if context starts/ends mid-content.
        """
        CTX = 20
        start = max(0, match_pos - CTX)
        end = min(len(content), match_pos + match_len + CTX)
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(content) else ""
        snippet_plain = (prefix + content[start:end] + suffix).replace("\n", " ").strip()
        # HTML version: escape entire snippet, then re-inject <mark> at the
        # matched substring position. Recompute match offsets in the sliced
        # window to handle prefix ellipsis.
        sliced = content[start:end]
        local_match_start = match_pos - start
        local_match_end = local_match_start + match_len
        before = _html_escape(sliced[:local_match_start])
        match_text = _html_escape(sliced[local_match_start:local_match_end])
        after = _html_escape(sliced[local_match_end:])
        snippet_html = (
            ("…" if start > 0 else "")
            + before
            + f"<mark>{match_text}</mark>"
            + after
            + ("…" if end < len(content) else "")
        ).replace("\n", " ").strip()
        return snippet_plain, snippet_html

    import os as _os

    def _flatten_db_content(raw) -> str:
        """state.db `content` is a string; for tool/structured turns it can be a
        JSON-encoded block list. Flatten to plain text for matching + snippet."""
        if not isinstance(raw, str) or not raw:
            return ""
        s = raw.lstrip()
        if s[:1] in ("[", "{"):
            try:
                return _content_to_str(_json.loads(raw))
            except Exception:
                return raw
        return raw

    # Enumerate sessions from the same source the UI lists from, so keys/titles/
    # source/updatedAt match exactly (a hit opens the right thread). Read each
    # transcript via the shared _raw_messages_from_db (the path sessions.get uses).
    listing = await handle_sessions_list({"limit": 500}, ctx)
    sessions = listing.get("sessions") if isinstance(listing, dict) else None
    if not isinstance(sessions, list):
        sessions = []
    _home = _os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"

    for srow in sessions:
        if not isinstance(srow, dict):
            continue
        total_scanned += 1
        key = srow.get("key") or srow.get("sessionKey") or ""
        if not key:
            continue
        # Profile-aware DB path (mirror handle_sessions_get).
        agent_id, session_id = decanonicalize_session_key(key)
        if agent_id and agent_id not in ("main", "default"):
            _cand = f"{_home}/profiles/{agent_id}"
            base = _cand if _os.path.isdir(_cand) else _home
        else:
            base = _home
        dbkey = get_dbkey_for_sid(session_id) or session_id
        sid_for_query = srow.get("sessionId") or session_id
        raw_msgs = _raw_messages_from_db(f"{base}/state.db", sid_for_query, session_id, dbkey)
        if not raw_msgs:
            continue

        msg_texts: list[str] = []
        first_user_text = ""
        for m in raw_msgs:
            if not isinstance(m, dict):
                continue
            text = _flatten_db_content(m.get("content"))
            if text:
                msg_texts.append(text)
                if not first_user_text and m.get("role") == "user":
                    first_user_text = text
        if not msg_texts:
            continue
        full_text = "\n".join(msg_texts)
        full_lower = full_text.lower()

        # AND match: every term must appear somewhere in the aggregated text.
        if not all(term in full_lower for term in terms):
            continue

        match_count = sum(
            1 for mt in msg_texts if all(term in mt.lower() for term in terms)
        )
        if match_count == 0:
            continue

        primary_term = max(terms, key=len)
        primary_pos = full_lower.find(primary_term)
        if primary_pos < 0:
            primary_pos, primary_term_len = 0, 0
        else:
            primary_term_len = len(primary_term)
        snippet_plain, snippet_html = _make_snippet(
            full_text, primary_pos, primary_term_len,
        )

        # Title: prefer the list row's title (already engine/derived), else
        # derive from the first user message.
        title = (srow.get("title") or "").strip()
        if not title and first_user_text:
            clean = _re.sub(r"[*_`#>]+", " ", first_user_text)
            clean = _re.sub(r"\s+", " ", clean).strip()
            if len(clean) > 60:
                cut = clean[:60]
                sp = cut.rfind(" ")
                if sp > 30:
                    cut = cut[:sp]
                title = cut + "…"
            else:
                title = clean
        if not title:
            title = "Sesi tanpa judul"

        updated_at = srow.get("updatedAt")
        try:
            updated_at_ms = int(updated_at) if updated_at else 0
        except (TypeError, ValueError):
            updated_at_ms = 0

        results.append({
            "sessionKey": key,
            "title": title,
            "snippet": snippet_plain,
            "snippetHtml": snippet_html,
            "matchCount": match_count,
            "updatedAt": updated_at_ms,
            "source": srow.get("source") or None,
            "messageCount": len(raw_msgs),
        })

    # Sort by updatedAt DESC primary, matchCount DESC secondary.
    results.sort(key=lambda r: (r["updatedAt"], r["matchCount"]), reverse=True)
    return {
        "results": results[:limit],
        "total": total_scanned,
        "query": query,
    }


METHOD_HANDLERS["sessions.search"] = handle_sessions_search


async def handle_sessions_create(params: dict, ctx: DispatchContext) -> dict:
    # P0#2 (2026-05-30): honor the agent the user picked (Command Center /
    # "Thread baru" dropdown). The canonical key MUST be
    # `agent:<agentId>:<sid>` so chat.send resolves THAT agent's profile and
    # _apply_session_persona binds its persona + model. Before this fix the
    # handler dropped agentId and always returned `agent:main:<sid>` → every
    # /app session routed to the DEFAULT agent regardless of pick. (Caught by
    # chief's E2E: sessions.create({agentId:ccprobe}) → agent:main:... wrong.)
    agent_id = None
    if isinstance(params, dict):
        raw_agent = params.get("agentId") or params.get("agent_id")
        if isinstance(raw_agent, str) and raw_agent.strip():
            agent_id = raw_agent.strip()
    # Forward agentId to the engine so the agentbuff_persona_patch wrapper
    # (installed in bootstrap_tui_gateway) can bind sid → agent and inject that
    # agent's PURE persona + model into THIS session's agent object only — no
    # global config write. The unpatched engine session.create ignores unknown
    # params (it reads only `cols`), so this is safe even if the patch is off.
    create_params: dict = {}
    if agent_id and agent_id.lower() not in ("", "main", "default"):
        create_params["agentId"] = agent_id
    try:
        result = await ctx.hermes.call("session.create", create_params)
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    # Hermes returns `session_id` (per tui_gateway/server.py:2138).
    # Old code looked for `id` only and silently fell back to "main",
    # which is why every sessions.create response used to canonicalize
    # to `agent:main:main` regardless of the actual Hermes uuid.
    raw_id = None
    if isinstance(result, dict):
        raw_id = result.get("session_id") or result.get("id")
    if raw_id:
        # Register sid→dbkey alias deterministically via session.status
        # (reads _sessions[sid]["session_key"] — set at create time, no
        # need to wait for DB write or prompt.submit). After alias
        # registered, the eventual dbkey row from sessions.list is
        # rewritten to sid → no duplicate row.
        # Bind sid (and its dbkey alias) → agent so chat events canonicalize
        # to agent:<id>:<sid> instead of agent:main:<sid> (UI was showing a
        # specialist agent's session/replies as Buff).
        if agent_id and agent_id.lower() not in ("", "main", "default"):
            register_sid_agent(raw_id, agent_id)
            dbk = get_dbkey_for_sid(raw_id)
            if dbk:
                register_sid_agent(dbk, agent_id)
        await _lookup_dbkey_for_sid(ctx.hermes, raw_id)
        # Re-bind the dbkey now that the alias is resolved (in case it wasn't
        # known above).
        if agent_id and agent_id.lower() not in ("", "main", "default"):
            dbk2 = get_dbkey_for_sid(raw_id)
            if dbk2:
                register_sid_agent(dbk2, agent_id)
        # ALSO mark as pending so the synthetic injection in sessions.list
        # surfaces this sid as a row BEFORE Hermes' first DB write — the
        # alias rewrite alone can't help when the underlying dbkey row
        # doesn't exist in sessions.list yet. clear_pending_sid runs the
        # moment a real dbkey row materialises AND gets rewritten to sid
        # (seen_ids matches), so no permanent duplicate.
        register_pending_sid(raw_id, params if isinstance(params, dict) else None)
    return {
        "key": canonicalize_session_key(raw_id or "main", agent_id or "main"),
        "agentId": agent_id or "main",
        "raw": result,
    }


METHOD_HANDLERS["sessions.create"] = handle_sessions_create


def _raw_messages_from_db(db_path: str, *candidate_ids) -> list:
    """Reconstruct raw Hermes-style ``messages[]`` for a session straight from
    a state.db (~6 ms). Engine 0.15.x stopped writing ``session_<id>.json``, so
    the JSON path in handle_sessions_get always misses and every thread-open
    fell back to the ``session.history`` RPC (~3.5 s). The messages table holds
    the full transcript (role / content / tool_calls / tool_call_id / tool_name
    / reasoning), which is exactly what ``_claude_blocks_from_raw_messages``
    consumes. Tries each candidate id (sid / dbkey); returns the first non-empty
    result. Returns [] on any failure so the caller falls through to the RPC.

    `db_path` is the profile-aware DB (caller passes profiles/<agent>/state.db
    for non-default agents — that's where their messages actually live)."""
    import sqlite3
    import json as _json

    for sid in candidate_ids:
        if not sid:
            continue
        rows = []
        try:
            conn = sqlite3.connect(db_path, timeout=5.0)
            try:
                rows = conn.execute(
                    "SELECT role, content, tool_calls, tool_call_id, tool_name, "
                    "reasoning, reasoning_content FROM messages "
                    "WHERE session_id=? AND role!='session_meta' "
                    "ORDER BY timestamp ASC, id ASC",
                    (sid,),
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            rows = []
        if not rows:
            continue
        out: list = []
        for role, content, tcs, tcid, tname, reasoning, rcontent in rows:
            m: dict = {"role": role, "content": content or ""}
            if tcs:
                try:
                    m["tool_calls"] = _json.loads(tcs)
                except Exception:
                    pass
            if tcid:
                m["tool_call_id"] = tcid
            if tname:
                m["name"] = tname
            r = reasoning or rcontent
            if r:
                m["reasoning"] = r
            out.append(m)
        return out
    return []


async def handle_sessions_get(params: dict, ctx: DispatchContext) -> dict:
    """Load full transcript for a session.

    We bypass `session.history` RPC (which strips tool output bodies
    and reasoning) and read the RAW session JSON file from disk under
    `/home/hermes/.hermes/sessions/session_<dbkey>.json`. This is the
    only path that preserves:
      - tool_calls (assistant msg with full function args)
      - tool result content body (tool msg with stdout/return value)
      - reasoning (assistant msg's `reasoning` field — what TUI shows
        as the collapsible "thinking" panel)
    All of which are critical for chief's "show everything terminal
    shows" requirement.

    Lookup order:
      1. If `session_id` is an in-memory sid (8 hex), resolve to dbkey
         via alias map.
      2. Read `session_<dbkey>.json`.
      3. If file not found, fall back to legacy session.history RPC
         (degraded — no tool body, no reasoning).
    """
    import json as _json
    import os as _os
    from pathlib import Path as _Path

    key = (params or {}).get("key") or (params or {}).get("sessionKey") or "main"
    agent_id, session_id = decanonicalize_session_key(key)
    dbkey = get_dbkey_for_sid(session_id) or session_id

    # Profile-aware base. A NON-default agent's sessions + messages live in its
    # OWN profile dir (profiles/<agent>/{state.db,sessions/}), NOT the root —
    # persona_patch runs each turn with HERMES_HOME overridden to the profile.
    # sessions.list aggregates across profiles, but this getter used to read
    # ONLY the root state.db, so opening any non-default-agent thread found zero
    # messages -> /app saw an empty/NOT_FOUND transcript -> it cleared the active
    # key and snapped back to the empty Command Center ("sesi gak bisa dibuka").
    # Read the correct profile DB. (2026-06-09)
    _home = _os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
    if agent_id and agent_id not in ("main", "default"):
        _cand = f"{_home}/profiles/{agent_id}"
        base = _cand if _os.path.isdir(_cand) else _home
    else:
        base = _home
    db_path = f"{base}/state.db"

    # ── Path 1: raw JSON read (preferred) ──────────────────────────────
    sessions_dir = _Path(base) / "sessions"
    json_path = sessions_dir / f"session_{dbkey}.json"
    if json_path.is_file():
        try:
            data = _json.loads(json_path.read_text(encoding="utf-8"))
            raw_messages = data.get("messages") or []
            # Pass dbkey so `_claude_blocks_from_raw_messages` can stamp
            # each output message with a STABLE per-(session,index) id
            # (`__agentbuff.id = agb_<dbkey>_<idx>`). Hermes session JSON
            # has no per-message id field, so /app fell back to client-
            # generated UUIDs which never matched bridge-side persistence
            # (messages.edit/delete, reactions.set) — every refresh wiped
            # deletes + reactions silently because the client UUID had
            # no anchor on disk. The stable synthetic id we emit here is
            # what /app stores + passes back to those RPCs; the handlers
            # parse `agb_<dbkey>_<idx>` and mutate the right slot in
            # messages[].
            messages = _claude_blocks_from_raw_messages(raw_messages, dbkey)
            # Rewrite local-path MEDIA tags in assistant messages to fresh
            # HTTP URLs so /app's history rehydrate produces playable
            # AudioCard / ImageCard / VideoCard / DocumentCard cards.
            # Without this, refreshed assistant bubbles show MEDIA:/abs/path
            # plaintext + no media card (TS-side extractor can only
            # promote HTTP URLs to attachments; local paths get stripped).
            _rewrite_assistant_media_tags(messages)
            return {
                "key": canonicalize_session_key(dbkey),
                "messages": messages,
            }
        except Exception as e:
            log.warning(
                "raw-json read failed for %s: %s — falling back to RPC",
                dbkey, e,
            )

    # ── Path 1b: reconstruct transcript from state.db (fast: ~6ms) ─────
    # Engine 0.15.x no longer writes session_<id>.json, so Path 1 always
    # misses and the RPC fallback below costs ~3.5s per thread-open. The
    # messages table carries the full transcript — rebuild from it directly.
    try:
        raw_db = _raw_messages_from_db(db_path, dbkey, session_id)
        if raw_db:
            messages = _claude_blocks_from_raw_messages(raw_db, dbkey)
            _rewrite_assistant_media_tags(messages)
            return {
                "key": canonicalize_session_key(dbkey),
                "messages": messages,
            }
    except Exception as e:
        log.warning(
            "db-reconstruct failed for %s: %s — falling back to RPC", dbkey, e
        )

    # ── Path 2: RPC fallback (degraded — no tool output, no reasoning) ─
    try:
        history = await ctx.hermes.call(
            "session.history", {"session_id": session_id}
        )
    except HermesRpcError as e:
        msg_lower = (e.message or "").lower()
        is_missing = (
            "not found" in msg_lower
            or e.code == 4001
            or e.code == -32602
        )
        if not is_missing:
            raise RpcError(_map_hermes_code(e.code), e.message)
        try:
            history = await ctx.hermes.call(
                "session.resume", {"session_id": dbkey}
            )
        except HermesRpcError as e2:
            msg2 = (e2.message or "").lower()
            if "not found" in msg2 or e2.code in (4006, 4007):
                raise RpcError("NOT_FOUND", f"session {key!r} not found")
            raise RpcError(_map_hermes_code(e2.code), e2.message)
        except HermesProcessError as e2:
            raise RpcError("ENGINE_DOWN", str(e2))
        if isinstance(history, dict):
            new_sid = history.get("session_id")
            resumed_dbkey = history.get("resumed") or dbkey
            if isinstance(new_sid, str) and isinstance(resumed_dbkey, str):
                register_sid_dbkey(new_sid, resumed_dbkey)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    messages = (
        history.get("messages") if isinstance(history, dict) else (history or [])
    )
    return {
        "key": canonicalize_session_key(session_id),
        "messages": _normalize_history_messages(messages),
    }


def _scrub_brand(text: str) -> str:
    """Brand-scrub one RPC-response string (MEDIA:/URL/path-protected).

    ENABLED 2026-06-11 (Chief: "aku tetep mau semua informasi di web ini
    semuanya di amankan dan tidak ada kebocoran nama brand lain tanpa
    terkecuali, jadi hanya bener bener chatnya aja yang ga di sentuh!").
    Supersedes the 2026-06-05 "show /app verbatim" decision: every RPC-response
    surface that is NOT chat prose (file content like SOUL.md, tool results,
    tools.catalog / config.get / cron.list / skills metadata incl. the literal
    'hermes-agent' skill name) gets the engine brand hidden.

    Delegates to `event_translator._scrub_display` so the brand catalog +
    MEDIA/URL/path protection are a SINGLE source of truth shared with the
    streaming-event path. The chat-prose exemption is handled UPSTREAM by
    `_deep_scrub`'s `protect_prose` branch — user/assistant prose never reaches
    this function — so the chat bubble stays verbatim."""
    if not isinstance(text, str) or not text:
        return text
    try:
        from event_translator import _scrub_display
        return _scrub_display(text)
    except Exception:
        return text


# Session-list prose fields that echo the user's own words — kept verbatim
# whenever protect_prose is on (Chief: "jangan ubah chat ku & balasan agen").
_PROSE_KEYS = frozenset({"title", "label", "lastMessagePreview"})


def _deep_scrub(value, *, protect_prose: bool = False):
    """Recursively brand-scrub an RPC-response payload before it leaves the
    bridge (defense in depth over per-site scrubs).

    Display-safe: every string is laundered through `_scrub_brand`
    (`_scrub_display` — MEDIA:/URL protected), so media never breaks.

    Prose exemption (Chief 2026-06-03 — "jangan ubah chat ku & balasan agen"):
    when `protect_prose=True` (session / history responses) the USER + ASSISTANT
    chat PROSE stays VERBATIM. Recognised structurally so it can't be confused
    with tool metadata:
      - a `{"type": "text", "text": ...}` chat block  → `text` verbatim
      - a message with `role` in user/system/assistant + STRING content → verbatim
      - session-list prose fields (`title`/`label`/`lastMessagePreview`) → verbatim
    Everything else (tool_use input, tool_result body, thinking, status, plus
    all non-session methods: tools.catalog / skills.status / config.get /
    cron.list / agents.list / errors) is scrubbed. Functional media/URL keys are
    always passed through verbatim."""
    try:
        from event_translator import _DISPLAY_FUNCTIONAL_KEYS as _FK
    except Exception:
        _FK = frozenset()
    if isinstance(value, str):
        return _scrub_brand(value)
    if isinstance(value, dict):
        if protect_prose:
            # Chat text block — keep prose, scrub siblings.
            if value.get("type") == "text" and isinstance(value.get("text"), str):
                return {
                    k: (v if k == "text" else _deep_scrub(v, protect_prose=True))
                    for k, v in value.items()
                }
            # User / assistant / system message with plain-string content = prose.
            if value.get("role") in {"user", "assistant", "system"} and isinstance(
                value.get("content"), str
            ):
                return {
                    k: (v if k == "content" else _deep_scrub(v, protect_prose=True))
                    for k, v in value.items()
                }
        out = {}
        for k, v in value.items():
            if k in _FK:
                out[k] = v  # functional media/URL field — verbatim
            elif protect_prose and k in _PROSE_KEYS:
                out[k] = v  # session-list prose echoes the user's words — verbatim
            else:
                out[k] = _deep_scrub(v, protect_prose=protect_prose)
        return out
    if isinstance(value, list):
        return [_deep_scrub(v, protect_prose=protect_prose) for v in value]
    return value


# Match `MEDIA:` followed by a local absolute path (Unix: `/...`, tilde:
# `~/...`), optionally prefixed by a `sandbox:` or `file://` scheme the agent
# sometimes emits. Stops at whitespace or `]`. We deliberately DON'T match HTTP
# URLs here — those are already browser-loadable and the /app TS-side
# extractor handles them. The `path` group is the bare filesystem path in all
# three forms, so the rewrite below resolves + durable-copies it identically.
import re as _re_media
_LOCAL_PATH_MEDIA_TAG_RE = _re_media.compile(
    r"\bMEDIA:(?:sandbox:|file://)?(?P<path>(?:/|~/)[^\s\]]+)",
)

# Replacement for a MEDIA: tag whose file is gone from disk (cache rotation /
# rebuild). Path-free + brand-free so it's safe verbatim in the (scrub-exempt)
# assistant bubble — never leak a dead container path or vanish the bubble.
_MEDIA_EXPIRED_NOTE = "_(media tidak tersedia lagi — minta Buff kirim ulang)_"


def _rewrite_assistant_media_tags(messages: list) -> None:
    """Walk through history `messages[]` (in-place) and rewrite every
    `MEDIA:/abs/path/to/file` tag in an assistant text block to a fresh
    `MEDIA:http://127.0.0.1:<bridge>/media/<token>/<filename>` URL.

    Why this is needed:
        Hermes' session storage persists agent replies verbatim including
        `MEDIA:/abs/path` tags. On `/app` refresh, `sessions.get` returns
        that raw text — the TS-side `extractAssistantBotMedia` can only
        promote HTTP URLs to AttachmentPart (browser can't reach a local
        path through the loopback bridge port without a token). So
        refreshed assistant bubbles for TTS / image_generate /
        video_generate output would lose their AudioCard etc.

    Strategy:
        For each `MEDIA:/path` we find, call `media_serve.register_media`
        to mint a fresh token, build the public URL via
        `media_serve.public_url`, and substitute in place. Files that
        no longer exist on disk (cache rotation, container rebuild that
        wiped the audio cache) get their MEDIA: tag stripped instead so
        the bubble doesn't show a dead path.

    Side-effects:
        - Mutates `messages` IN PLACE.
        - Calls `media_serve.register_media` for every recognised path —
          tokens land in the per-bridge-process in-memory table with the
          default TTL.
        - Logs each rewrite at INFO level for observability.

    Idempotent — re-runs on already-URL-form text are no-ops because the
    regex only matches local-path form.
    """
    import os as _os
    try:
        import media_serve  # type: ignore
    except ImportError:
        return

    bridge_host = _os.environ.get("BRIDGE_PUBLIC_HOST") or "127.0.0.1"
    try:
        bridge_port = int(
            _os.environ.get("BRIDGE_PUBLIC_HEALTH_PORT")
            or _os.environ.get("BRIDGE_HEALTH_PORT")
            or "18790"
        )
    except (TypeError, ValueError):
        bridge_port = 18790

    rewrites = 0
    drops = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "text":
                continue
            text = block.get("text")
            if not isinstance(text, str):
                continue
            orig = text
            # 1) Convert markdown-local media the agent RESENDS as markdown
            #    (`![alt](sandbox:/x.jpg)` / `[Voice note](sandbox:/x.webm)`) into
            #    MEDIA: tags, so the TS history extractor (extract-bot-media.ts)
            #    promotes them to AttachmentPart cards rendered OUTSIDE the bubble
            #    — identical to the live path. 2) Rewrite every MEDIA: local path
            #    to a durable HTTP URL the browser can actually fetch.
            text = media_serve.normalize_markdown_media_to_tags(text)
            new_text, r, d = media_serve.rewrite_local_media_in_text(
                text, host=bridge_host, port=bridge_port,
            )
            rewrites += r
            drops += d
            if new_text != orig:
                # Tidy whitespace introduced by stripped (dropped) tags
                import re as _re_ws
                new_text = _re_ws.sub(r"\n{3,}", "\n\n", new_text).strip()
                block["text"] = new_text

    if rewrites or drops:
        log.warning(
            "sessions.get: rewrote %d local media ref(s) to durable URLs "
            "(%d expired — file gone from cache)",
            rewrites, drops,
        )


def _compact_skill_injection(text: str) -> str:
    """Collapse the engine's per-session skill auto-load injection for DISPLAY.

    When many skills are enabled, Hermes prepends the FULL manual of every
    auto-loaded skill (~760KB / ~190K tokens for 60+ skills) to the first user
    message. The user only typed a short message (it sits at the very end, after
    the last injected skill block). Rendering the raw 760KB blob makes opening a
    channel session take seconds. We keep the real user text + a small note about
    how many skills were loaded — the actual chat prose is preserved, only the
    engine-injected context is folded away. Non-injected messages pass through
    untouched."""
    if not isinstance(text, str) or len(text) < 50_000:
        return text
    n_skills = text.count("skill is auto-loaded")
    if n_skills == 0:
        # Huge but not a skill injection — hard cap so the transcript still loads.
        return text[:20_000] + f"\n\n_…(dipotong, ~{len(text) // 1024}KB)_"
    # The real user message sits after the LAST injected skill block. Each block
    # ends with the skill-directory resolution note ("…using the absolute path.").
    marker = "using the absolute path."
    idx = text.rfind(marker)
    tail = text[idx + len(marker):].strip() if idx != -1 else ""
    note = f"_🧩 {n_skills} skill di-load otomatis sebagai konteks_"
    return (tail + "\n\n" if tail else "") + note


def _claude_blocks_from_raw_messages(raw_messages: list, session_dbkey: str = "") -> list:
    """Translate raw Hermes session JSON `messages[]` → portal Claude-style
    block array per message.

    Stable IDs (`__agentbuff.id`): every emitted message gets a
    deterministic id `f"agb_{session_dbkey}_{src_idx}"` where `src_idx`
    is the position in the RAW input array (not the output array — an
    assistant-row with text+tool_calls emits 1 chat + N tool msgs, all
    sharing the same source index but suffixed `:chat`, `:tool0`, etc.).
    Bridge-side persistence (messages.edit/delete, reactions.set/list)
    parses this id to find the message slot in the raw JSON. Hermes
    itself has no per-message id — without this synthetic anchor, every
    /app refresh would lose deletes + reactions because the client-side
    UUID never re-matched anything on disk.

    Critical: aligns the OUTPUT STRUCTURE with what the live store path
    produces, so a refreshed session and a streamed session look IDENTICAL
    to the UI:

      user            → chat-bubble msg (kind=chat in store)
      assistant w/ text+tool_calls
                      → EMIT TWO MSGS:
                          (a) chat-bubble msg with [thinking?, text] (kind=chat)
                          (b) tool msg with [tool_use, tool_result] paired
                              from subsequent role=tool entry (kind=tool)
      assistant w/ tool_calls only
                      → tool msg with [tool_use, tool_result] paired
      assistant w/ text only (post-tool final)
                      → chat-bubble msg with [text]
      tool            → folded into the preceding tool_use msg as the
                        matching tool_result block (skipped as standalone)

    Without this split, raw JSON assistant rows that have BOTH content
    AND tool_calls would render bare via MessageBlocks (kind=tool path),
    losing the bubble styling the user expects for normal chat text.
    """
    import json as _json

    out: list = []
    # Buffer: maps tool_call_id → tool msg position in `out`, so a later
    # role=tool entry can fold its result body back into the right msg.
    pending_tool_msgs: dict = {}

    # Apply the soft-delete OVERLAY (deletions.json) onto the raw rows so
    # _stamp_id propagates `deleted` to /app. This is the source of truth on
    # 0.16.0 where the engine no longer writes session_<dbkey>.json (the legacy
    # in-JSON flag never persisted). See handle_messages_delete.
    if session_dbkey:
        _dels = _load_deletions(session_dbkey)
        for _idx_str, _at in _dels.items():
            try:
                _i = int(_idx_str)
            except (TypeError, ValueError):
                continue
            if 0 <= _i < len(raw_messages) and isinstance(raw_messages[_i], dict):
                raw_messages[_i]["deleted"] = True
                raw_messages[_i].setdefault("deletedAt", _at)

    def _stamp_id(msg: dict, src_idx: int, suffix: str = "") -> dict:
        """Attach stable `__agentbuff.id` to an output message AND propagate
        mutation flags (deleted, editedAt, deletedAt) from the source raw
        message — without this, deleted/edited state stays in session JSON
        on disk but never reaches /app on rehydrate, so refresh always
        shows the original undeleted/unedited text.
        """
        agb_id = f"agb_{session_dbkey}_{src_idx}{suffix}"
        msg.setdefault("__agentbuff", {})["id"] = agb_id
        # Pull source row's mutation flags forward to /app. Skip the tool/
        # chat sub-split: a deleted assistant text+tool_calls row marks the
        # CHAT slot deleted, NOT the tool slot — but currently /app's UX
        # only deletes chat bubbles, so propagating to both is harmless
        # (tool slots ignore the flag in their render path).
        if 0 <= src_idx < len(raw_messages):
            src = raw_messages[src_idx]
            if isinstance(src, dict):
                if src.get("deleted") is True:
                    msg["deleted"] = True
                if isinstance(src.get("deletedAt"), (int, float)):
                    msg["deletedAt"] = src["deletedAt"]
                if isinstance(src.get("editedAt"), (int, float)):
                    msg["editedAt"] = src["editedAt"]
        return msg

    for src_idx, raw in enumerate(raw_messages):
        if not isinstance(raw, dict):
            continue
        role = raw.get("role")
        if role not in {"user", "assistant", "tool", "system"}:
            continue

        if role == "tool":
            # Fold into the matching tool_use msg (added during the
            # assistant turn that called this tool). If no match, emit
            # standalone tool_result msg as a fallback.
            tool_call_id = raw.get("tool_call_id") or ""
            content_raw = raw.get("content")
            content_str = (
                content_raw if isinstance(content_raw, str)
                else _json.dumps(content_raw) if content_raw is not None
                else ""
            )
            pretty = content_str
            if content_str.strip().startswith("{"):
                try:
                    parsed = _json.loads(content_str)
                    pretty = _json.dumps(parsed, indent=2, ensure_ascii=False)
                except Exception:
                    pass
            pretty = _scrub_brand(pretty)
            tool_msg_idx = pending_tool_msgs.pop(tool_call_id, None)
            if tool_msg_idx is not None and tool_msg_idx < len(out):
                tool_msg = out[tool_msg_idx]
                if isinstance(tool_msg.get("content"), list):
                    tool_msg["content"].append({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": pretty,
                    })
                continue
            # Fallback: orphan tool result (no matching tool_use)
            out.append(_stamp_id({
                "role": "tool",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": pretty,
                }],
                "toolCallId": tool_call_id,
                "toolName": raw.get("name") or "tool",
            }, src_idx, ":toolorphan"))
            continue

        if role == "assistant":
            reasoning = raw.get("reasoning")
            content_raw = raw.get("content")
            content_str = content_raw if isinstance(content_raw, str) else ""
            tool_calls = raw.get("tool_calls") or []

            # (a) Chat bubble entry — emit only when there's actual prose
            # (text content OR reasoning). Skips entirely for tool-only
            # rows (assistant msg with content="" + tool_calls only),
            # avoiding the empty-bubble pollution chief reported.
            chat_blocks: list = []
            if isinstance(reasoning, str) and reasoning.strip():
                chat_blocks.append({
                    "type": "thinking",
                    "thinking": _scrub_brand(reasoning),
                })
            if content_str.strip():
                # Assistant PROSE reply — verbatim (Chief: jangan ubah balasan agen).
                chat_blocks.append({"type": "text", "text": content_str})
            if chat_blocks:
                out.append(_stamp_id({
                    "role": "assistant",
                    "content": chat_blocks,
                }, src_idx, ":chat"))

            # (b) For EACH tool_call, emit a separate tool msg with just
            # the tool_use block. Subsequent role=tool entry will fold
            # its tool_result back into the right one via pending_tool_msgs.
            for tc_idx, tc in enumerate(tool_calls):
                if not isinstance(tc, dict):
                    continue
                tc_id = tc.get("id") or tc.get("call_id") or ""
                fn = tc.get("function") or {}
                name = fn.get("name") or "tool"
                args_raw = fn.get("arguments") or "{}"
                try:
                    args = (
                        _json.loads(args_raw) if isinstance(args_raw, str)
                        else (args_raw or {})
                    )
                except Exception:
                    args = {"raw": args_raw}
                tool_msg = _stamp_id({
                    "role": "tool",
                    "content": [{
                        "type": "tool_use",
                        "id": tc_id,
                        "name": name,
                        "input": args,
                    }],
                    "toolCallId": tc_id,
                    "toolName": name,
                }, src_idx, f":tool{tc_idx}")
                pending_tool_msgs[tc_id] = len(out)
                out.append(tool_msg)
            continue

        # user / system
        content_raw = raw.get("content")
        text = content_raw if isinstance(content_raw, str) else ""
        text = _compact_skill_injection(text)
        out.append(_stamp_id({"role": role, "content": text}, src_idx))

    # Defense in depth: deep-scrub recursively so any field we missed
    # (tool_use.input.name when model called skill_view("hermes-agent"),
    # nested tool_result strings, etc.) gets laundered before leaving the
    # bridge. protect_prose=True keeps user/assistant chat text verbatim while
    # still scrubbing tool_use input, tool_result bodies, and thinking.
    return _deep_scrub(out, protect_prose=True)


def _normalize_history_messages(raw: list) -> list:
    """Translate Hermes message shape → portal shape.

    Hermes (`_history_to_messages` in tui_gateway/server.py:2053) emits
    three shapes:

      user / assistant:
        { role, text }
      tool (one row per call, output NOT preserved):
        { role: "tool", name, context }
        where `context` is a human-readable preview string of the args
        (e.g. "print(5 + 5)" for execute_code).

    Portal /app's `rawToMessage` (src/lib/app/store.ts:330) reads `content`,
    `blocks`, `tool_use_id`, etc. — Claude-style block array. Without
    reshaping:
      - text messages render as "(pesan kosong)" because content is null
      - tool rows render as empty bubbles because store's detectToolMarkers
        sees role=tool but no `toolCallId` or `tool_use` block, so
        reshapeToolMessageBlocks has nothing to wrap.

    We map each Hermes row to portal block-array form:
      - text rows  → { role, content: text }   (string content)
      - tool rows  → { role: "tool", content: [{ type: "tool_use", id,
                        name, input: { preview: context } }],
                       toolCallId: id, toolName: name }
        Synthesised tool_use_id is "hist-<name>-<idx>" so each row gets a
        stable unique id without colliding with live runtime call_xxx ids.
        Note: Hermes history loses the tool's stdout/result so we only
        surface the call signature — no tool_result block.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for idx, m in enumerate(raw):
        if not isinstance(m, dict):
            continue

        role = m.get("role")
        if role == "tool":
            name = m.get("name") or "tool"
            context = m.get("context")
            args = {}
            if isinstance(context, dict):
                args = context
            elif isinstance(context, str) and context:
                args = {"preview": context}
            tool_use_id = f"hist-{name}-{idx}"
            block = {
                "type": "tool_use",
                "id": tool_use_id,
                "name": name,
            }
            if args:
                block["input"] = args
            out.append({
                "role": "tool",
                "content": [block],
                # Top-level marker fields so the store's detectToolMarkers
                # also catches this (belt-and-suspenders — the type:"tool_use"
                # block above is the primary signal).
                "toolCallId": tool_use_id,
                "toolName": name,
            })
            continue

        # Already in portal shape? pass through.
        if "content" in m and m.get("content") is not None:
            scrubbed = dict(m)
            c = m.get("content")
            # PROSE (text blocks + plain-string content) stays VERBATIM (Chief:
            # jangan ubah chat ku & balasan agen). Only thinking + tool_result
            # bodies are brand-scrubbed (display-safe).
            if isinstance(c, list):
                scrubbed["content"] = [
                    dict(b, **{
                        "thinking": _scrub_brand(b.get("thinking")) if "thinking" in b else b.get("thinking"),
                        "content": _scrub_brand(b.get("content")) if (b.get("type") != "text" and isinstance(b.get("content"), str)) else b.get("content"),
                    }) if isinstance(b, dict) else b
                    for b in c
                ]
            elif isinstance(c, str) and m.get("role") in ("user", "system"):
                # Fold away the giant per-session skill auto-load injection so the
                # transcript loads fast (real user text is preserved).
                scrubbed["content"] = _compact_skill_injection(c)
            out.append(scrubbed)
            continue
        text = m.get("text")
        if not isinstance(text, str):
            text = "" if text is None else str(text)
        if m.get("role") in ("user", "system"):
            text = _compact_skill_injection(text)
        normalized = dict(m)
        normalized["content"] = text
        out.append(normalized)
    return out


METHOD_HANDLERS["sessions.get"] = handle_sessions_get


async def handle_sessions_delete(params: dict, ctx: DispatchContext) -> dict:
    key = (params or {}).get("key") or (params or {}).get("sessionKey") or ""
    if not key:
        raise RpcError("INVALID_REQUEST", "sessions.delete: key required")
    # KEEP agent_id (it used to be discarded as `_`). A non-default agent's
    # session row physically lives in profiles/<agent>/state.db, NOT root.
    # Dropping the agent meant delete only ever touched root, so the per-agent
    # row survived and the profile-aware sessions.list kept re-surfacing it —
    # the "deleted session won't disappear" bug. Mirror handle_sessions_get's
    # profile resolution. (2026-06-09)
    agent_id, session_id = decanonicalize_session_key(key)
    # session.delete only accepts dbkey. Resolve sid alias if present.
    dbkey_for_delete = get_dbkey_for_sid(session_id) or session_id

    import os
    _home = os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
    _alc = (agent_id or "").lower()
    if _alc and _alc not in ("main", "default"):
        _cand = f"{_home}/profiles/{_alc}"
        db_path = f"{_cand}/state.db" if os.path.isdir(_cand) else f"{_home}/state.db"
    else:
        db_path = f"{_home}/state.db"

    # 1) Ask the engine to delete. Clean path for the default/root agent + it
    #    manages its own in-memory bookkeeping. The engine is root-only with no
    #    profile selector, so for a non-default agent this is effectively a
    #    no-op — the SQLite delete below (against the PROFILE db) is the
    #    authoritative one. Swallow "not found" (idempotent) AND "active
    #    session" (we finish the job via direct SQLite, same as the original
    #    force-delete path that let a just-created-never-used thread be deleted).
    engine_raw = None
    try:
        engine_raw = await ctx.hermes.call(
            "session.delete", {"session_id": dbkey_for_delete}
        )
    except HermesRpcError as e:
        msg_lower = (e.message or "").lower()
        recoverable = (
            "not found" in msg_lower
            or "active session" in msg_lower
            or "cannot delete" in msg_lower
            or e.code in (4006, 4007, 4023, -32602)
        )
        if not recoverable:
            raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    # 2) AUTHORITATIVE delete from the correct db (profile for a per-agent row,
    #    root for default). Idempotent + best-effort: a row the engine already
    #    removed (default agent) just deletes zero rows here — never a failure.
    try:
        import sqlite3
        conn = sqlite3.connect(db_path, timeout=5.0)
        cur = conn.cursor()
        cur.execute("DELETE FROM messages WHERE session_id = ?", (dbkey_for_delete,))
        cur.execute("DELETE FROM sessions WHERE id = ?", (dbkey_for_delete,))
        conn.commit()
        conn.close()
    except sqlite3.Error as se:
        log.warning("sessions.delete: SQLite delete on %s failed: %s", db_path, se)

    # 3) Drop ALL in-memory aliases so nothing re-derives the row: sid↔dbkey,
    #    pending, AND the sid→agent binding (previously leaked — never popped).
    clear_pending_sid(dbkey_for_delete)
    clear_pending_sid(session_id)
    _SID_TO_DBKEY.pop(session_id, None)
    _DBKEY_TO_SID.pop(dbkey_for_delete, None)
    _SID_TO_AGENT.pop(session_id, None)
    _SID_TO_AGENT.pop(dbkey_for_delete, None)
    # 4) Tombstone so a racing/re-flushing sessions.list can't blink it back.
    _tombstone_deleted_sid(session_id)
    _tombstone_deleted_sid(dbkey_for_delete)

    # 5) Folder assignment cleanup (best-effort) so no orphan ref lingers.
    try:
        async with _FOLDERS_FILE_LOCK:
            blob = _load_folders_blob()
            removed = blob["assignments"].pop(key, None)
            # Also try canonical-key form in case `key` came pre-canonicalized
            canon = canonicalize_session_key(session_id)
            if canon != key:
                blob["assignments"].pop(canon, None)
                removed = removed or canon
            if removed:
                _save_folders_blob(blob)
    except Exception as fe:
        # Folder cleanup is best-effort — session is already deleted in DB.
        log.warning("sessions.delete: folder cleanup failed: %s", fe)
    return {"ok": True, "key": key, "raw": engine_raw or {"deleted": dbkey_for_delete}}


METHOD_HANDLERS["sessions.delete"] = handle_sessions_delete


async def handle_sessions_subscribe(params: dict, ctx: DispatchContext) -> dict:
    """No-op stub. Portal's /app gateway-provider calls this on connect-
    ready to subscribe to session lifecycle events (`sessions.changed`).
    Bridge already broadcasts events to ALL connected clients by default,
    so explicit subscription is unnecessary — we just ACK with `{ok: true}`
    so the portal stops logging "method=sessions.subscribe not found"
    WARN lines on every reconnect."""
    return {"ok": True}


METHOD_HANDLERS["sessions.subscribe"] = handle_sessions_subscribe


# ─────────────────────────────────────────────────────────────────────────
# FOLDERS — user-defined session grouping (AgentBuff feature, NOT in Hermes).
#
# Storage: single JSON file at $HERMES_HOME/agentbuff_folders.json with shape
#   {
#     "folders": [{ id, name, emoji, color, createdAt, updatedAt }],
#     "assignments": { "<sessionKey>": "<folderId>", ... }
#   }
#
# Live alongside Hermes state (same volume), survives container restart,
# orthogonal to Hermes schema (no engine modification).
#
# Concurrency: best-effort last-write-wins. Read-modify-write is short and
# protected by an asyncio lock. Sufficient for single-user portal.
# ─────────────────────────────────────────────────────────────────────────

import os as _os
import uuid as _uuid
import asyncio as _asyncio

_FOLDERS_FILE_LOCK = _asyncio.Lock()


def _folders_file_path() -> str:
    return _os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/agentbuff_folders.json"


def _load_folders_blob() -> dict:
    """Read folders file. Returns empty shape if missing/corrupt."""
    import json
    path = _folders_file_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"folders": [], "assignments": {}}
        folders = data.get("folders")
        assignments = data.get("assignments")
        return {
            "folders": folders if isinstance(folders, list) else [],
            "assignments": assignments if isinstance(assignments, dict) else {},
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError) as e:
        log.debug("folders file read miss: %s", e)
        return {"folders": [], "assignments": {}}


def _save_folders_blob(blob: dict) -> None:
    """Write folders file atomically (write to tmp + rename)."""
    import json, tempfile
    path = _folders_file_path()
    dir_ = _os.path.dirname(path) or "."
    try:
        # Atomic write to avoid corruption on crash mid-write
        fd, tmp_path = tempfile.mkstemp(suffix=".tmp", prefix="folders_", dir=dir_)
        try:
            with _os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(blob, f, ensure_ascii=False, indent=2)
            _os.replace(tmp_path, path)
        except Exception:
            try:
                _os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError as e:
        log.error("folders file write failed: %s", e)
        raise RpcError("INTERNAL_ERROR", f"folders write failed: {e}")


def _new_folder_id() -> str:
    return "f_" + _uuid.uuid4().hex[:12]


def _validate_folder_name(name) -> str:
    if not isinstance(name, str):
        raise RpcError("INVALID_REQUEST", "folder name must be a string")
    trimmed = name.strip()
    if not trimmed:
        raise RpcError("INVALID_REQUEST", "folder name cannot be empty")
    if len(trimmed) > 80:
        trimmed = trimmed[:80]
    return trimmed


async def handle_folders_list(params: dict, ctx: DispatchContext) -> dict:
    """Return all folders + sessionKey→folderId assignments map."""
    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
    return {"folders": blob["folders"], "assignments": blob["assignments"]}


METHOD_HANDLERS["folders.list"] = handle_folders_list


async def handle_folders_create(params: dict, ctx: DispatchContext) -> dict:
    """Create a new folder. Returns the created folder object."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "folders.create params must be a dict")
    name = _validate_folder_name(params.get("name"))
    emoji = params.get("emoji") if isinstance(params.get("emoji"), str) else None
    color = params.get("color") if isinstance(params.get("color"), str) else None
    description = params.get("description") if isinstance(params.get("description"), str) else None

    now_ms = int(_time.time() * 1000)
    folder = {
        "id": _new_folder_id(),
        "name": name,
        "emoji": emoji[:8] if emoji else None,
        "color": color[:32] if color else None,
        "description": description[:500] if description else None,
        "createdAt": now_ms,
        "updatedAt": now_ms,
    }

    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
        # Reject duplicate name (case-insensitive). Mass-market user
        # confusion otherwise — two folders "Belajar" feels broken.
        existing_names = {f.get("name", "").strip().lower() for f in blob["folders"] if isinstance(f, dict)}
        if folder["name"].lower() in existing_names:
            raise RpcError("INVALID_REQUEST", f"Folder dengan nama '{folder['name']}' sudah ada")
        blob["folders"].append(folder)
        _save_folders_blob(blob)
    return {"folder": folder}


METHOD_HANDLERS["folders.create"] = handle_folders_create


async def handle_folders_update(params: dict, ctx: DispatchContext) -> dict:
    """Update folder fields. Only name/emoji/color/description editable."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "folders.update params must be a dict")
    fid = params.get("id")
    if not isinstance(fid, str) or not fid:
        raise RpcError("INVALID_REQUEST", "folders.update: id required")

    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
        target = next((f for f in blob["folders"] if isinstance(f, dict) and f.get("id") == fid), None)
        if not target:
            raise RpcError("NOT_FOUND", f"folder {fid} tidak ditemukan")
        if "name" in params:
            new_name = _validate_folder_name(params.get("name"))
            # Dedup check (excluding self)
            for f in blob["folders"]:
                if not isinstance(f, dict) or f.get("id") == fid:
                    continue
                if f.get("name", "").strip().lower() == new_name.lower():
                    raise RpcError("INVALID_REQUEST", f"Folder dengan nama '{new_name}' sudah ada")
            target["name"] = new_name
        if "emoji" in params:
            emoji = params.get("emoji")
            target["emoji"] = (str(emoji)[:8]) if emoji else None
        if "color" in params:
            color = params.get("color")
            target["color"] = (str(color)[:32]) if color else None
        if "description" in params:
            description = params.get("description")
            target["description"] = (str(description)[:500]) if description else None
        target["updatedAt"] = int(_time.time() * 1000)
        _save_folders_blob(blob)
    return {"folder": target}


METHOD_HANDLERS["folders.update"] = handle_folders_update


async def handle_folders_delete(params: dict, ctx: DispatchContext) -> dict:
    """Delete folder + unassign all sessions in it. Does NOT delete sessions."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "folders.delete params must be a dict")
    fid = params.get("id")
    if not isinstance(fid, str) or not fid:
        raise RpcError("INVALID_REQUEST", "folders.delete: id required")

    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
        before_count = len(blob["folders"])
        blob["folders"] = [f for f in blob["folders"] if not (isinstance(f, dict) and f.get("id") == fid)]
        removed = before_count != len(blob["folders"])
        # Clean up assignments pointing to deleted folder
        unassigned = 0
        keys_to_clear = [k for k, v in blob["assignments"].items() if v == fid]
        for k in keys_to_clear:
            blob["assignments"].pop(k, None)
            unassigned += 1
        if removed or unassigned:
            _save_folders_blob(blob)
    return {"ok": True, "removed": removed, "unassigned": unassigned}


METHOD_HANDLERS["folders.delete"] = handle_folders_delete


async def handle_folders_assign(params: dict, ctx: DispatchContext) -> dict:
    """Assign a session to a folder (or null to unassign)."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "folders.assign params must be a dict")
    session_key = params.get("sessionKey") or params.get("key")
    if not isinstance(session_key, str) or not session_key:
        raise RpcError("INVALID_REQUEST", "folders.assign: sessionKey required")
    folder_id = params.get("folderId")
    if folder_id is not None and (not isinstance(folder_id, str) or not folder_id):
        raise RpcError("INVALID_REQUEST", "folders.assign: folderId must be string or null")

    # Canonicalize session key — store the canonical form so chat sidebar
    # lookup uses the same key regardless of how it was passed in.
    canonical_key = canonicalize_session_key(session_key)

    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
        # Validate folder exists if assigning
        if folder_id is not None:
            exists = any(isinstance(f, dict) and f.get("id") == folder_id for f in blob["folders"])
            if not exists:
                raise RpcError("NOT_FOUND", f"folder {folder_id} tidak ditemukan")
            blob["assignments"][canonical_key] = folder_id
        else:
            blob["assignments"].pop(canonical_key, None)
        _save_folders_blob(blob)
    return {"ok": True, "sessionKey": canonical_key, "folderId": folder_id}


METHOD_HANDLERS["folders.assign"] = handle_folders_assign


async def handle_folders_assign_bulk(params: dict, ctx: DispatchContext) -> dict:
    """Bulk-assign multiple sessions to a folder (or null)."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "folders.assign.bulk params must be a dict")
    session_keys = params.get("sessionKeys")
    if not isinstance(session_keys, list) or not all(isinstance(k, str) and k for k in session_keys):
        raise RpcError("INVALID_REQUEST", "folders.assign.bulk: sessionKeys must be list of strings")
    folder_id = params.get("folderId")
    if folder_id is not None and (not isinstance(folder_id, str) or not folder_id):
        raise RpcError("INVALID_REQUEST", "folders.assign.bulk: folderId must be string or null")
    if len(session_keys) > 500:
        raise RpcError("INVALID_REQUEST", "folders.assign.bulk: too many keys (max 500)")

    canonical_keys = [canonicalize_session_key(k) for k in session_keys]

    async with _FOLDERS_FILE_LOCK:
        blob = _load_folders_blob()
        if folder_id is not None:
            exists = any(isinstance(f, dict) and f.get("id") == folder_id for f in blob["folders"])
            if not exists:
                raise RpcError("NOT_FOUND", f"folder {folder_id} tidak ditemukan")
            for k in canonical_keys:
                blob["assignments"][k] = folder_id
        else:
            for k in canonical_keys:
                blob["assignments"].pop(k, None)
        _save_folders_blob(blob)
    return {"ok": True, "count": len(canonical_keys), "folderId": folder_id}


METHOD_HANDLERS["folders.assign.bulk"] = handle_folders_assign_bulk


def _rename_session_in_db(session_id: str, title: str) -> bool:
    """Update session title directly in SQLite.

    Hermes doesn't expose a session.rename RPC. The `hermes sessions rename`
    CLI updates the SQLite row directly — we mirror that here so the bridge
    doesn't need to spawn a subprocess or chase slash-command side effects.

    Returns True if a row was updated, False if no matching session_id found.
    Empty title falls back to NULL (so Hermes' derived-title logic re-engages).
    """
    import os, sqlite3
    db_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/state.db"
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        cur = conn.cursor()
        if title:
            cur.execute(
                "UPDATE sessions SET title = ? WHERE id = ?",
                (title, session_id),
            )
        else:
            # Empty → clear (Hermes will re-derive from first user msg)
            cur.execute(
                "UPDATE sessions SET title = NULL WHERE id = ?",
                (session_id,),
            )
        updated = cur.rowcount > 0
        conn.commit()
        conn.close()
        return updated
    except sqlite3.Error as e:
        log.warning("rename_session_in_db: sqlite error: %s", e)
        return False


async def _ensure_session_active(dbkey: str, ctx: DispatchContext) -> str:
    """Ensure session is loaded into Hermes memory; return the active sid.

    Hermes' slash.exec / session.compress / etc. only work on sessions
    currently in memory. Archived sessions (just dbkey, never resumed in
    this engine run) return "session not found" until session.resume
    re-hydrates them.

    Mirrors the auto-resume pattern in chat.send (TIER 2 in handle_chat_send).

    Returns the active sid to use for subsequent calls. If the session is
    already in memory, returns dbkey unchanged.
    """
    # First check the sid alias map — if dbkey already has an in-memory sid,
    # use that directly without round-tripping resume.
    aliased_sid = get_sid_for_dbkey(dbkey)
    if aliased_sid:
        return aliased_sid

    # Otherwise resume from DB. session.resume returns the new sid.
    try:
        resumed = await ctx.hermes.call(
            "session.resume", {"session_id": dbkey}
        )
    except HermesRpcError as e:
        msg = (e.message or "").lower()
        if e.code in (4007, 4006) or "not found" in msg:
            raise RpcError("NOT_FOUND", f"session not found: {dbkey}")
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    if not isinstance(resumed, dict):
        raise RpcError("ENGINE_ERROR", "session.resume returned non-dict response")

    new_sid = resumed.get("session_id") or resumed.get("id")
    if not new_sid:
        raise RpcError("ENGINE_ERROR", "session.resume did not return session_id")

    # Register alias so future calls in this engine run skip resume.
    register_sid_dbkey(new_sid, dbkey)
    return new_sid


def _write_config_yaml(updates: dict) -> bool:
    """Direct config.yaml writer for fields that Hermes' slash commands
    don't reliably persist:

      - `agent.service_tier` (/fast) — only persists if model is Claude
        Opus 4.6 or OpenAI Priority; otherwise the slash returns early
        without saving. We want it persisted regardless so the dropdown
        UI reflects chief's intent.
      - `display.tool_progress` (/verbose) — Hermes' `_toggle_verbose`
        cycles `self.tool_progress_mode` in-memory but never calls
        `save_config_value`. Setting is lost on next session start.

    Pattern mirrors `_rename_session_in_db` for session.title (where slash
    doesn't have a deterministic path either). Direct file write is safe
    because Hermes re-reads config on next session create.

    `updates` is a flat dict of dotted paths → values:
      e.g. {"agent.service_tier": "fast", "display.tool_progress": "verbose"}

    Returns True on success, False on yaml/IO error.
    """
    import os, yaml
    cfg_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/config.yaml"
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        for dotted, value in updates.items():
            parts = dotted.split(".")
            cursor = cfg
            for p in parts[:-1]:
                if p not in cursor or not isinstance(cursor[p], dict):
                    cursor[p] = {}
                cursor = cursor[p]
            cursor[parts[-1]] = value
        with open(cfg_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        return True
    except (OSError, yaml.YAMLError) as e:
        log.warning("write_config_yaml: failed: %s", e)
        return False


async def handle_sessions_patch(params: dict, ctx: DispatchContext) -> dict:
    """Apply session label + AI behavior settings.

    Routing per field:
      - `label`         → direct SQLite UPDATE on sessions.title
      - `thinkingLevel` → slash `/reasoning <level>` via `slash.exec` (Hermes
                          writes to agent.reasoning_effort in config.yaml)
      - `reasoningLevel`→ slash `/reasoning show|hide` (writes
                          display.show_reasoning + sections.thinking)
      - `fastMode`      → DIRECT config.yaml write (Hermes' /fast bails out
                          if model doesn't support it; we want chief's
                          choice persisted regardless)
      - `verboseLevel`  → DIRECT config.yaml write (Hermes' /verbose never
                          persists — engine bug, in-memory only)

    Slash-driven fields require an active session (auto-resume). Direct-
    write fields don't (config.yaml is global anyway).
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "sessions.patch params must be a dict")
    key = params.get("key") or params.get("sessionKey")
    if not key:
        raise RpcError("INVALID_REQUEST", "sessions.patch: key required")

    relevant_keys = {"label", "thinkingLevel", "fastMode", "verboseLevel", "reasoningLevel"}
    if not relevant_keys.intersection(params.keys()):
        return {"ok": True, "applied": []}

    _, session_id = decanonicalize_session_key(key)
    dbkey = get_dbkey_for_sid(session_id) or session_id

    applied: list[str] = []

    # 1. Label rename — direct SQLite UPDATE
    if "label" in params:
        label = params.get("label")
        title = "" if label is None else str(label).strip()
        if len(title) > 512:
            title = title[:512]
        ok_rename = _rename_session_in_db(dbkey, title)
        if not ok_rename:
            log.info("sessions.patch: rename skipped, no DB row for %s", dbkey)
        else:
            applied.append("label")

    # 2. fastMode — direct config write (bypass /fast model-conditional bail-out)
    if "fastMode" in params and params["fastMode"] is not None:
        v = params["fastMode"]
        service_tier = "fast" if v is True else ("" if v is False else None)
        if service_tier is not None:
            if _write_config_yaml({"agent.service_tier": service_tier}):
                applied.append("fastMode")

    # 3. verboseLevel — write display.tool_progress in VANILLA representation.
    #    Vanilla stores `tool_progress: true` (bool). We keep that exact value so
    #    /app's verbose chat UI works WITHOUT drifting config from vanilla
    #    (Chief 2026-06-03: config must equal vanilla 19500). The bridge's
    #    display read is now bool-tolerant.
    if "verboseLevel" in params and params["verboseLevel"] is not None:
        level = str(params["verboseLevel"]).strip().lower()
        tp_val: object = None
        if level == "off":
            tp_val = False
        elif level in ("on", "all", "full", "verbose", "new"):
            tp_val = True
        if tp_val is not None:
            if _write_config_yaml({"display.tool_progress": tp_val}):
                applied.append("verboseLevel")

    # 4. thinkingLevel — NO-OP for global config (Chief: match vanilla, which has
    #    NO `agent.reasoning_effort`). The /app bootstrap auto-sent this on every
    #    session, drifting config away from vanilla. The model uses its engine
    #    default reasoning (Codex reasons by default; Gemini uses its default) —
    #    exactly like vanilla. Acknowledge the param so /app doesn't error.
    if "thinkingLevel" in params and params["thinkingLevel"]:
        applied.append("thinkingLevel")  # accepted, intentionally not persisted

    # 5. reasoningLevel — write display.show_reasoning in VANILLA representation
    #    ("all" string), WITHOUT display.sections (vanilla has no sections key).
    if "reasoningLevel" in params and params["reasoningLevel"]:
        level = str(params["reasoningLevel"]).strip().lower()
        show_value: object = None
        if level in ("on", "show", "stream", "all"):
            show_value = "all"
        elif level in ("off", "hide"):
            show_value = False
        if show_value is not None:
            if _write_config_yaml({"display.show_reasoning": show_value}):
                applied.append("reasoningLevel")

    return {"ok": True, "applied": applied}


METHOD_HANDLERS["sessions.patch"] = handle_sessions_patch


async def handle_sessions_compact(params: dict, ctx: DispatchContext) -> dict:
    """Compact (compress) a session's conversation history.

    Auto-resumes archived sessions, then forwards to Hermes `session.compress`.
    Long handler (default timeout 5min via hermes_client.LONG_HANDLER_METHODS).
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "sessions.compact params must be a dict")
    key = params.get("key") or params.get("sessionKey")
    if not key:
        raise RpcError("INVALID_REQUEST", "sessions.compact: key required")

    _, session_id = decanonicalize_session_key(key)
    dbkey = get_dbkey_for_sid(session_id) or session_id
    active_sid = await _ensure_session_active(dbkey, ctx)

    try:
        result = await ctx.hermes.call(
            "session.compress",
            {"session_id": active_sid},
        )
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    return {"ok": True, "key": key, "raw": result or {}}


METHOD_HANDLERS["sessions.compact"] = handle_sessions_compact


def _wipe_session_messages_in_db(session_id: str) -> dict:
    """Direct SQLite wipe of messages for a session — keeps the session row.

    Hermes' `/clear` slash creates a NEW session ID, which breaks the
    portal's session_key reference. For "Reset Obrolan" UX the chief wants
    "wipe history, keep this session", so we DELETE from messages directly
    and reset the session row's counters.

    Caveat: if the session is currently in Hermes memory (active sid), the
    in-memory transcript stays cached until next resume. For archived
    sessions this is clean.
    """
    import os, sqlite3, time
    db_path = os.environ.get("HERMES_HOME", "/home/hermes/.hermes") + "/state.db"
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,))
        msg_count = cur.fetchone()[0]

        # Wipe messages
        cur.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        # Reset session counters; keep id, source, model, created_at, title.
        cur.execute(
            """UPDATE sessions
               SET message_count = 0,
                   tool_call_count = 0,
                   input_tokens = 0,
                   output_tokens = 0,
                   cache_read_tokens = 0,
                   cache_write_tokens = 0,
                   reasoning_tokens = 0,
                   api_call_count = 0,
                   ended_at = NULL,
                   end_reason = NULL
               WHERE id = ?""",
            (session_id,),
        )
        affected = cur.rowcount
        conn.commit()
        conn.close()
        return {
            "ok": True,
            "messages_wiped": msg_count,
            "session_updated": affected > 0,
        }
    except sqlite3.Error as e:
        log.warning("wipe_session_messages_in_db: sqlite error: %s", e)
        return {"ok": False, "error": str(e)}


async def handle_sessions_reset(params: dict, ctx: DispatchContext) -> dict:
    """Reset (clear history) of a session.

    Strategy: direct SQLite DELETE of messages for this session_id +
    reset of counters on the sessions row. Keeps the session_id stable
    so chief's activeSessionKey reference doesn't break. (Hermes' /clear
    slash would rotate the session_id which we don't want.)

    If the session is currently active in Hermes memory, the in-memory
    transcript stays cached until next resume. For archived sessions
    this is a clean wipe.
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "sessions.reset params must be a dict")
    key = params.get("key") or params.get("sessionKey")
    if not key:
        raise RpcError("INVALID_REQUEST", "sessions.reset: key required")

    _, session_id = decanonicalize_session_key(key)
    dbkey = get_dbkey_for_sid(session_id) or session_id

    result = _wipe_session_messages_in_db(dbkey)
    if not result.get("ok"):
        raise RpcError("INTERNAL_ERROR", f"db wipe failed: {result.get('error')}")

    return {
        "ok": True,
        "key": key,
        "raw": result,
    }


METHOD_HANDLERS["sessions.reset"] = handle_sessions_reset


# -----------------------------------------------------------------------------
# Compaction (snapshot) stubs — OpenClaw-era concept, not implemented in Hermes.
# We return empty/error responses cleanly so the UI loading state doesn't hang
# or surface scary errors. The Snapshots tab in /app/sessions drawer is
# hidden client-side; these stubs are defense-in-depth for any other caller.
# -----------------------------------------------------------------------------


async def handle_sessions_compaction_list(params: dict, ctx: DispatchContext) -> dict:
    """No checkpoints — Hermes doesn't expose compaction lineage."""
    return {"ok": True, "checkpoints": []}


METHOD_HANDLERS["sessions.compaction.list"] = handle_sessions_compaction_list


async def handle_sessions_compaction_branch(params: dict, ctx: DispatchContext) -> dict:
    raise RpcError(
        "NOT_IMPLEMENTED",
        "Branching from snapshot is not available in this engine version.",
    )


METHOD_HANDLERS["sessions.compaction.branch"] = handle_sessions_compaction_branch


async def handle_sessions_compaction_restore(params: dict, ctx: DispatchContext) -> dict:
    raise RpcError(
        "NOT_IMPLEMENTED",
        "Restoring from snapshot is not available in this engine version.",
    )


METHOD_HANDLERS["sessions.compaction.restore"] = handle_sessions_compaction_restore


def _channel_message_aggregates(
    start_date: Optional[str], end_date: Optional[str]
) -> dict:
    """Per-channel inbound(user)/outbound(assistant) message counts straight from
    the engine session DB (state.db), mapping synthetic source → base channel
    (whatsapp__default-1 → whatsapp). Date bounds (YYYY-MM-DD) are interpreted in
    the container timezone. This replaces the dead OpenClaw `aggregates.byChannel`
    that Hermes never emitted (the channels dashboard read it → always 0).
    Fail-open: returns {} on any error so usage never breaks the dashboard."""
    import os
    import sqlite3
    from datetime import datetime, timedelta

    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    db_path = os.path.join(home, "state.db")
    if not os.path.exists(db_path):
        return {}

    lo = hi = None
    if start_date and end_date:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
            lo = datetime.fromisoformat(start_date).replace(tzinfo=tz).timestamp()
            hi = (
                datetime.fromisoformat(end_date).replace(tzinfo=tz)
                + timedelta(days=1)
            ).timestamp()
        except Exception:
            lo = hi = None

    by_base: dict = {}
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            q = (
                "SELECT s.source, m.role, COUNT(*) FROM messages m "
                "JOIN sessions s ON m.session_id = s.id "
            )
            args: list = []
            if lo is not None and hi is not None:
                q += "WHERE m.timestamp >= ? AND m.timestamp < ? "
                args = [lo, hi]
            q += "GROUP BY s.source, m.role"
            for source, role, cnt in conn.execute(q, args).fetchall():
                if not source:
                    continue
                base = str(source).split("__", 1)[0]  # synthetic → base channel
                entry = by_base.setdefault(
                    base, {"total": 0, "user": 0, "assistant": 0}
                )
                if role == "user":
                    entry["user"] += cnt
                    entry["total"] += cnt
                elif role == "assistant":
                    entry["assistant"] += cnt
                    entry["total"] += cnt
                # tool / session_meta roles are not inbound/outbound messages
        finally:
            conn.close()
    except Exception:
        log.debug("channel message aggregates failed", exc_info=True)
        return {}
    return by_base


def _daily_message_aggregates(
    start_date: Optional[str], end_date: Optional[str]
) -> list:
    """Per-day inbound(user)/outbound(assistant) message counts from the engine
    session DB, bucketed by LOCAL date (container timezone). Feeds the dashboard
    "Task Carry" today-vs-yesterday metric — the OpenClaw `aggregates.daily` that
    Hermes never emitted (so the card was stuck at 0). Fail-open: returns [].

    Shape per entry: {date: "YYYY-MM-DD", messages: {user, assistant, total},
    tokens: {total: 0}}. Tokens-by-day are not attributed here (energy is a
    future BYOK-off feature; the day token field stays 0)."""
    import os
    import sqlite3
    from datetime import datetime, timedelta

    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    db_path = os.path.join(home, "state.db")
    if not os.path.exists(db_path):
        return []

    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
    except Exception:
        return []

    lo = hi = None
    if start_date and end_date:
        try:
            lo = datetime.fromisoformat(start_date).replace(tzinfo=tz).timestamp()
            hi = (
                datetime.fromisoformat(end_date).replace(tzinfo=tz)
                + timedelta(days=1)
            ).timestamp()
        except Exception:
            lo = hi = None

    by_date: dict = {}
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            q = "SELECT m.timestamp, m.role FROM messages m "
            args: list = []
            if lo is not None and hi is not None:
                q += "WHERE m.timestamp >= ? AND m.timestamp < ? "
                args = [lo, hi]
            for ts, role in conn.execute(q, args).fetchall():
                if ts is None:
                    continue
                try:
                    d = datetime.fromtimestamp(float(ts), tz).strftime("%Y-%m-%d")
                except Exception:
                    continue
                entry = by_date.setdefault(
                    d, {"user": 0, "assistant": 0, "total": 0}
                )
                if role == "user":
                    entry["user"] += 1
                    entry["total"] += 1
                elif role == "assistant":
                    entry["assistant"] += 1
                    entry["total"] += 1
        finally:
            conn.close()
    except Exception:
        log.debug("daily message aggregates failed", exc_info=True)
        return []

    return [
        {
            "date": d,
            "messages": v,
            "tokens": {"total": 0},
        }
        for d, v in sorted(by_date.items())
    ]


# -------------------------------------------------------------------------
# Usage / token analytics — read straight from the engine session DB
# -------------------------------------------------------------------------
# The engine's state.db `sessions` table is the source of truth for token +
# cost accounting (input/output/cache/reasoning tokens, estimated/actual cost
# USD, model, source channel, message counts, timing). The Hermes engine has
# no OpenClaw-style `usage.cost` / `usage.status` RPCs, so the portal Usage tab
# is served entirely from these DB reads. BYOK note: for free/"included"
# endpoints the engine records cost=0 / cost_status="included" — that's a
# truthful $0, NOT a missing value.


def _now_ms() -> int:
    import time as _t
    return int(_t.time() * 1000)


def _usage_db_path() -> Optional[str]:
    import os
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    p = os.path.join(home, "state.db")
    return p if os.path.exists(p) else None


def _usage_date_bounds(start_date, end_date):
    """(lo, hi) epoch seconds for [start_date, end_date] inclusive, in the
    container timezone. (None, None) when unbounded/unparseable."""
    import os
    from datetime import datetime, timedelta
    if not (start_date and end_date):
        return None, None
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
        lo = datetime.fromisoformat(start_date).replace(tzinfo=tz).timestamp()
        hi = (datetime.fromisoformat(end_date).replace(tzinfo=tz)
              + timedelta(days=1)).timestamp()
        return lo, hi
    except Exception:
        return None, None


def _zero_cost_totals() -> dict:
    return {
        "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
        "reasoning": 0,
        "totalTokens": 0, "totalCost": 0.0,
        "inputCost": 0.0, "outputCost": 0.0,
        "cacheReadCost": 0.0, "cacheWriteCost": 0.0,
        "missingCostEntries": 0,
    }


def _accumulate(bucket: dict, inp, out, cr, cw, cost, cost_status, rt=0) -> None:
    inp = int(inp or 0); out = int(out or 0)
    cr = int(cr or 0); cw = int(cw or 0); rt = int(rt or 0)
    bucket["input"] += inp
    bucket["output"] += out
    bucket["cacheRead"] += cr
    bucket["cacheWrite"] += cw
    bucket["reasoning"] = bucket.get("reasoning", 0) + rt
    # Match the engine's canonical total (hermes_cli/main.py: input + output +
    # cache_read + cache_write + reasoning) — reasoning_tokens was being dropped.
    bucket["totalTokens"] += inp + out + cr + cw + rt
    if cost is not None:
        try:
            bucket["totalCost"] += float(cost)
        except (TypeError, ValueError):
            pass
    # "included"/"actual"/"estimated" = cost is known (often $0 for BYOK free
    # endpoints). null / unknown / error = genuinely unaccounted.
    if cost_status in (None, "", "unknown", "error", "missing"):
        bucket["missingCostEntries"] += 1


def _usage_snapshot(start_date, end_date, session_limit: int = 50,
                    include_sessions: bool = True) -> dict:
    """One pass over the session DB → totals + daily + byModel + byChannel +
    byAgent + messages + per-session rows. Shapes mirror the portal Usage
    contract (CostTotals etc.). Fail-open: returns empty aggregates on error."""
    import sqlite3
    from datetime import datetime
    import os

    def _empty_billing():
        return {
            "modes": {}, "providers": {},
            "subscriptionTokens": 0, "pricedTokens": 0,
            "unpricedTokens": 0, "freeTokens": 0, "paidCostUsd": 0.0,
            "provider": None, "mode": None,
        }

    empty = {
        "totals": _zero_cost_totals(),
        "daily": [], "byModel": [], "byChannel": [], "byAgent": [],
        "messages": {"total": 0, "user": 0, "assistant": 0},
        "sessions": [], "billing": _empty_billing(),
    }
    db_path = _usage_db_path()
    if not db_path:
        return empty
    lo, hi = _usage_date_bounds(start_date, end_date)
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
    except Exception:
        tz = None

    totals = _zero_cost_totals()
    billing = _empty_billing()
    by_model: dict = {}
    by_channel: dict = {}
    by_agent: dict = {}
    daily: dict = {}
    sessions_out: list = []

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            where = ""
            args: list = []
            if lo is not None and hi is not None:
                where = "WHERE started_at >= ? AND started_at < ?"
                args = [lo, hi]
            rows = conn.execute(
                "SELECT id, source, model, started_at, ended_at, message_count, "
                "tool_call_count, input_tokens, output_tokens, cache_read_tokens, "
                "cache_write_tokens, reasoning_tokens, estimated_cost_usd, "
                "actual_cost_usd, cost_status, billing_provider, billing_mode, title "
                f"FROM sessions {where} ORDER BY started_at DESC",
                args,
            ).fetchall()
            for r in rows:
                inp = r["input_tokens"]; out = r["output_tokens"]
                cr = r["cache_read_tokens"]; cw = r["cache_write_tokens"]
                rt = r["reasoning_tokens"]
                cost = r["actual_cost_usd"]
                if cost is None:
                    cost = r["estimated_cost_usd"]
                cstatus = r["cost_status"]
                base = str(r["source"] or "tui").split("__", 1)[0]
                model = r["model"] or "—"

                # Billing classification — distinguish flat-subscription usage
                # (cost genuinely $0 incremental) from pay-per-token (real cost)
                # from un-priced. Drives an honest "Biaya" display instead of a
                # bare misleading $0.
                bmode = r["billing_mode"] or "unknown"
                bprov = r["billing_provider"] or None
                tok = int(inp or 0) + int(out or 0) + int(cr or 0) + int(cw or 0)
                billing["modes"][bmode] = billing["modes"].get(bmode, 0) + tok
                if bprov:
                    billing["providers"][bprov] = billing["providers"].get(bprov, 0) + tok
                if bmode == "subscription_included":
                    billing["subscriptionTokens"] += tok
                elif cost is not None and float(cost or 0) > 0:
                    billing["pricedTokens"] += tok
                    billing["paidCostUsd"] += float(cost)
                elif cstatus in (None, "", "unknown", "error", "missing"):
                    billing["unpricedTokens"] += tok
                else:
                    # cost_status known (e.g. "free") with 0 cost → genuinely free
                    billing["freeTokens"] += tok

                _accumulate(totals, inp, out, cr, cw, cost, cstatus, rt)
                _accumulate(by_model.setdefault(model, _zero_cost_totals()),
                            inp, out, cr, cw, cost, cstatus, rt)
                by_model[model].setdefault("_count", 0)
                by_model[model]["_count"] += 1
                _accumulate(by_channel.setdefault(base, _zero_cost_totals()),
                            inp, out, cr, cw, cost, cstatus, rt)
                _accumulate(by_agent.setdefault("default", _zero_cost_totals()),
                            inp, out, cr, cw, cost, cstatus, rt)

                started = r["started_at"]
                if started and tz is not None:
                    try:
                        dkey = datetime.fromtimestamp(float(started), tz).strftime("%Y-%m-%d")
                    except Exception:
                        dkey = None
                    if dkey:
                        d = daily.setdefault(dkey, _zero_cost_totals())
                        _accumulate(d, inp, out, cr, cw, cost, cstatus, rt)

                if include_sessions and len(sessions_out) < session_limit:
                    st = _zero_cost_totals()
                    _accumulate(st, inp, out, cr, cw, cost, cstatus, rt)
                    ended = r["ended_at"]
                    first_ms = int(float(started) * 1000) if started else None
                    last_ms = int(float(ended) * 1000) if ended else first_ms
                    duration = (last_ms - first_ms) if (first_ms and last_ms) else None
                    sessions_out.append({
                        "key": r["id"],
                        "sessionId": r["id"],
                        "label": r["title"] or None,
                        "channel": base,
                        "model": model,
                        "updatedAt": last_ms or first_ms,
                        "usage": {
                            **st,
                            "firstActivity": first_ms,
                            "lastActivity": last_ms,
                            "durationMs": duration,
                            "messageCounts": {"total": int(r["message_count"] or 0)},
                            "toolUsage": {
                                "totalCalls": int(r["tool_call_count"] or 0),
                                "uniqueTools": 0,
                            },
                        },
                        "contextWeight": None,
                    })

            # Message in/out counts (reuse the channel aggregate's source query)
            mwhere = ""
            margs: list = []
            if lo is not None and hi is not None:
                mwhere = "WHERE m.timestamp >= ? AND m.timestamp < ?"
                margs = [lo, hi]
            msg = {"total": 0, "user": 0, "assistant": 0}
            for role, cnt in conn.execute(
                "SELECT m.role, COUNT(*) FROM messages m "
                f"{mwhere} GROUP BY m.role", margs,
            ).fetchall():
                if role == "user":
                    msg["user"] += cnt; msg["total"] += cnt
                elif role == "assistant":
                    msg["assistant"] += cnt; msg["total"] += cnt
        finally:
            conn.close()
    except Exception:
        log.debug("usage snapshot failed", exc_info=True)
        return empty

    def _rows(d: dict, key_name: str, count_key: bool = False) -> list:
        out = []
        for k, v in sorted(d.items(), key=lambda kv: kv[1]["totalTokens"], reverse=True):
            cnt = v.pop("_count", None)
            row = {key_name: k, "totals": v}
            if count_key and cnt is not None:
                row["count"] = cnt
            out.append(row)
        return out

    if billing["providers"]:
        billing["provider"] = max(billing["providers"].items(), key=lambda kv: kv[1])[0]
    if billing["modes"]:
        billing["mode"] = max(billing["modes"].items(), key=lambda kv: kv[1])[0]

    return {
        "totals": totals,
        "daily": [{"date": d, **v} for d, v in sorted(daily.items())],
        "byModel": _rows(by_model, "model", count_key=True),
        "byChannel": _rows(by_channel, "channel"),
        "byAgent": _rows(by_agent, "agentId"),
        "messages": msg,
        "sessions": sessions_out,
        "billing": billing,
    }


async def handle_sessions_usage(params: dict, ctx: DispatchContext) -> dict:
    """Usage snapshot served from the session DB. Superset shape so all three
    consumers are satisfied at once:
      - billing poller       → totals.tokens.total
      - channels dashboard   → aggregates.byChannel (message counts)
      - today-stats          → aggregates.daily (message counts)
      - Usage tab            → totals (CostTotals) + sessions[] + aggregates
                               (byModel/byChannel/byAgent/daily token+cost)."""
    start = params.get("startDate")
    end = params.get("endDate")
    limit = params.get("limit") if isinstance(params.get("limit"), int) else 50
    snap = _usage_snapshot(start, end, session_limit=limit)

    # CostTotals superset + legacy tokens.total for the poller.
    totals = dict(snap["totals"])
    totals["tokens"] = {"total": totals["totalTokens"]}

    return {
        "updatedAt": int(_now_ms()),
        "startDate": start or "",
        "endDate": end or "",
        "totals": totals,
        "sessions": snap["sessions"],
        # Legacy breakdown kept for any old consumer.
        "breakdown": [
            {"sessionId": s["sessionId"], "tokens": s["usage"]["totalTokens"]}
            for s in snap["sessions"]
        ],
        "aggregates": {
            # Token+cost aggregates (Usage tab). byChannelUsage avoids clobbering
            # the message-count `byChannel` map the channels dashboard reads.
            "byModel": snap["byModel"],
            "byProvider": [],
            "byAgent": snap["byAgent"],
            "byChannelUsage": snap["byChannel"],
            "messages": snap["messages"],
            # Per-channel MESSAGE counts (channels dashboard) — {base:{total,user,
            # assistant}}.
            "byChannel": _channel_message_aggregates(start, end),
            # Per-day MESSAGE counts (today-stats Task Carry). Token/cost daily
            # for the Usage tab lives in usage.cost.daily instead.
            "daily": _daily_message_aggregates(start, end),
        },
    }


METHOD_HANDLERS["sessions.usage"] = handle_sessions_usage


async def handle_usage_cost(params: dict, ctx: DispatchContext) -> dict:
    """Daily cost+token series + totals (Usage tab hero/chart). Computed from
    the session DB. `days` selects the trailing window."""
    import os
    from datetime import datetime, timedelta
    days = params.get("days") if isinstance(params.get("days"), int) else 30
    days = max(1, min(days, 366))
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
        today = datetime.now(tz)
    except Exception:
        today = datetime.now()
    end = today.strftime("%Y-%m-%d")
    start = (today - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    snap = _usage_snapshot(start, end, include_sessions=False)
    return {
        "updatedAt": int(_now_ms()),
        "days": days,
        "daily": snap["daily"],
        "totals": snap["totals"],
        "billing": snap["billing"],
    }


METHOD_HANDLERS["usage.cost"] = handle_usage_cost


async def handle_usage_status(params: dict, ctx: DispatchContext) -> dict:
    """Provider rate-limit windows. Hermes does not expose per-provider usage
    windows, so we honestly return none (the UI shows "not available" rather
    than fabricated quota bars)."""
    return {"updatedAt": int(_now_ms()), "providers": []}


METHOD_HANDLERS["usage.status"] = handle_usage_status


# -----------------------------------------------------------------
# Models / commands — direct forward with passthrough
# -----------------------------------------------------------------


async def handle_models_list(params: dict, ctx: DispatchContext) -> dict:
    try:
        result = await ctx.hermes.call("model.options", params or {})
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    return result if isinstance(result, dict) else {"models": result}


METHOD_HANDLERS["models.list"] = handle_models_list


async def handle_commands_list(params: dict, ctx: DispatchContext) -> dict:
    # Hermes may not expose commands.catalog; return empty list if missing
    try:
        result = await ctx.hermes.call("commands.catalog", params or {})
    except HermesRpcError as e:
        if e.code == -32601:  # method not found
            return {"commands": []}
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    return result if isinstance(result, dict) else {"commands": result}


METHOD_HANDLERS["commands.list"] = handle_commands_list


# -----------------------------------------------------------------
# Agents — custom (filesystem-backed)
# -----------------------------------------------------------------


async def handle_agents_list(params: dict, ctx: DispatchContext) -> dict:
    try:
        return await ctx.agents.list_agents()
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.list"] = handle_agents_list


async def handle_agents_get(params: dict, ctx: DispatchContext) -> dict:
    """Fetch a single agent row. L1 (2026-05-30): the backing
    ctx.agents.get_agent() already existed + is battle-tested (create/update/
    clone all return it) but was never wired as an RPC, so any external
    integrator reaching for the obvious `agents.get` hit METHOD_NOT_FOUND."""
    agent_id = params.get("agentId") or params.get("id") or ""
    try:
        return await ctx.agents.get_agent(agent_id)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.get"] = handle_agents_get


# Serializes agent-creating RPCs (create/clone/import) so the per-tier cap can't
# be raced: the bridge is single-process asyncio, so holding this across the
# count-then-create window guarantees two concurrent creates can't both pass.
_AGENT_CREATE_LOCK = asyncio.Lock()


async def _enforce_agent_cap(ctx: DispatchContext) -> None:
    """Raise RpcError if the user is at their per-tier agent cap. Fail-open on a
    counting error (don't block a create because OUR count failed). Call while
    holding _AGENT_CREATE_LOCK."""
    if ctx.tier_limits is None:
        return
    try:
        listing = await ctx.agents.list_agents()
        current = len(listing.get("agents", [])) if isinstance(listing, dict) else 0
    except AgentsError:
        return  # can't count -> fail open
    try:
        await ctx.tier_limits.check_count("agents", current)
    except LimitError as e:
        raise RpcError(e.code, e.message)


async def handle_agents_create(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.create params must be a dict")
    agent_id = params.get("id") or params.get("agentId")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.create: id required")
    profile = params.get("profile") or {}
    soul_content = params.get("soulContent") or params.get("soul_content") or ""

    # Per-tier cap (D7) + the create itself, under one lock so the
    # count-then-create window can't be raced by a second concurrent create.
    async with _AGENT_CREATE_LOCK:
        await _enforce_agent_cap(ctx)
        # Resolve the provider for the chosen model BEFORE writing it (same fix as
        # agents.update). Without this a cross-provider model (e.g. gpt-5.5 picked
        # while gemini is the global default) got mis-inferred → routed to gemini →
        # the new agent silently ran the wrong model. The UI now passes
        # providerSlug, but we auto-resolve here too so the bridge is correct.
        mp = profile.get("model") if isinstance(profile, dict) else None
        if isinstance(mp, dict):
            model_id = (mp.get("primary") or mp.get("default") or "").strip()
            if model_id and not mp.get("providerSlug"):
                slug = await _resolve_model_provider_slug(model_id, ctx)
                if slug:
                    mp["providerSlug"] = slug
        try:
            result = await ctx.agents.create_agent(agent_id, profile, soul_content)
        except AgentsError as e:
            raise RpcError(e.code, e.message)
    # create_agent only writes the profile + SOUL + sidecar — it does NOT apply
    # the model (that lives in update_agent). So a blank-created agent would lose
    # its chosen model entirely. Patch it now via update_agent, which writes
    # model.{default,primary,provider} to the profile config.yaml.
    if isinstance(mp, dict) and (mp.get("primary") or mp.get("default")):
        try:
            await ctx.agents.update_agent(agent_id, {"model": mp})
        except Exception as exc:  # noqa: BLE001
            log.warning("agents.create: post-create model patch failed: %s", exc)
    return result


METHOD_HANDLERS["agents.create"] = handle_agents_create


async def _resolve_model_provider_slug(model_id: str, ctx: DispatchContext) -> Optional[str]:
    """Find which provider a model id belongs to, via the engine's model.options
    provider groups. Lets agents.update set the RIGHT provider so a cross-provider
    model (e.g. a Codex model picked while gemini is default) routes to its own
    endpoint instead of being mis-inferred."""
    try:
        opts = await ctx.hermes.call("model.options", {})
    except Exception:  # noqa: BLE001
        return None
    provs = (opts or {}).get("providers") if isinstance(opts, dict) else None
    if not isinstance(provs, list):
        return None
    for g in provs:
        if isinstance(g, dict) and model_id in (g.get("models") or []):
            return g.get("slug")
    return None


async def handle_agents_update(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.update params must be a dict")
    agent_id = params.get("id") or params.get("agentId")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.update: id required")
    patch = params.get("patch") or {}
    # Resolve the provider for a newly-chosen model BEFORE writing it, so the
    # engine routes the model to its own endpoint (picking a Codex model without
    # provider=openai-codex sent it to gemini → 404). agents_handler reads the
    # injected `model.providerSlug`.
    mp = patch.get("model") if isinstance(patch, dict) else None
    if isinstance(mp, dict):
        model_id = (mp.get("primary") or mp.get("default") or "").strip()
        if model_id and not mp.get("providerSlug"):
            slug = await _resolve_model_provider_slug(model_id, ctx)
            if slug:
                mp["providerSlug"] = slug
        # Normalize fallbacks (UI sends bare model-id strings) into
        # {provider, model} dicts with the provider resolved per model, so the
        # engine routes each fallback_providers entry to its own endpoint.
        fbs = mp.get("fallbacks")
        if isinstance(fbs, list):
            norm = []
            for e in fbs:
                if isinstance(e, str) and e.strip():
                    m = e.strip()
                    s = await _resolve_model_provider_slug(m, ctx)
                    norm.append({"provider": s or "", "model": m})
                elif isinstance(e, dict) and (e.get("model") or "").strip():
                    m = (e.get("model") or "").strip()
                    prov = (e.get("provider") or "").strip()
                    if not prov:
                        prov = await _resolve_model_provider_slug(m, ctx) or ""
                    norm.append({"provider": prov, "model": m})
            mp["fallbacks"] = norm
    # Resolve provider for each auxiliary task's chosen model (auxiliary.<task>).
    aux = patch.get("auxiliary") if isinstance(patch, dict) else None
    if isinstance(aux, dict):
        for v in aux.values():
            if isinstance(v, dict):
                m = (v.get("model") or "").strip()
                if m and not (v.get("provider") or "").strip():
                    s = await _resolve_model_provider_slug(m, ctx)
                    if s:
                        v["provider"] = s
    try:
        return await ctx.agents.update_agent(agent_id, patch)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.update"] = handle_agents_update


async def handle_agents_delete(params: dict, ctx: DispatchContext) -> dict:
    agent_id = (params or {}).get("id") or (params or {}).get("agentId")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.delete: id required")
    try:
        return await ctx.agents.delete_agent(agent_id)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.delete"] = handle_agents_delete


async def handle_agents_files_list(params: dict, ctx: DispatchContext) -> dict:
    agent_id = (params or {}).get("agentId") or (params or {}).get("id")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.files.list: agentId required")
    try:
        return await ctx.agents.list_files(agent_id)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.files.list"] = handle_agents_files_list


async def handle_agents_files_get(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.files.get params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    filename = params.get("filename") or params.get("name")
    if not agent_id or not filename:
        raise RpcError("INVALID_REQUEST", "agents.files.get: agentId + filename required")
    try:
        return await ctx.agents.get_file(agent_id, filename)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.files.get"] = handle_agents_files_get


async def handle_agents_files_set(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.files.set params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    filename = params.get("filename") or params.get("name")
    content = params.get("content")
    if not agent_id or not filename or content is None:
        raise RpcError(
            "INVALID_REQUEST",
            "agents.files.set: agentId + filename + content required",
        )
    try:
        return await ctx.agents.set_file(agent_id, filename, content)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.files.set"] = handle_agents_files_set


# -----------------------------------------------------------------
# Agents — Tier 1+2 extensions
# -----------------------------------------------------------------
# Handlers:
#   agents.clone
#   agents.files.reset
#   agents.skills.set
#   agents.describe
#   agents.export / agents.import
#   agents.template.list / agents.template.instantiate
#   agents.memory.entries / .addEntry / .updateEntry / .removeEntry / .capacity


async def handle_agents_clone(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.clone params must be a dict")
    source_id = params.get("sourceId") or params.get("source_id")
    new_id = params.get("newId") or params.get("new_id") or params.get("id")
    if not source_id or not new_id:
        raise RpcError("INVALID_REQUEST", "agents.clone: sourceId + newId required")
    new_name = params.get("name") or params.get("newName")
    new_emoji = params.get("emoji") or params.get("newEmoji")
    # Per-tier cap (D7) — clone creates a new profile, so it counts. Same lock as
    # create so the count-then-create window can't be raced.
    async with _AGENT_CREATE_LOCK:
        await _enforce_agent_cap(ctx)
        try:
            return await ctx.agents.clone_agent(
                source_id=source_id,
                new_id=new_id,
                new_name=new_name,
                new_emoji=new_emoji,
            )
        except AgentsError as e:
            raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.clone"] = handle_agents_clone


async def handle_agents_files_reset(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.files.reset params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    filename = params.get("filename") or params.get("name")
    if not agent_id or not filename:
        raise RpcError("INVALID_REQUEST", "agents.files.reset: agentId + filename required")
    try:
        return await ctx.agents.reset_file(agent_id, filename)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.files.reset"] = handle_agents_files_reset


async def handle_agents_skills_set(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.skills.set params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    skills = params.get("skills")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.skills.set: agentId required")
    if skills is None:
        raise RpcError("INVALID_REQUEST", "agents.skills.set: skills array required")
    try:
        return await ctx.agents.set_skill_allowlist(agent_id, skills)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.skills.set"] = handle_agents_skills_set


async def handle_agents_skill_set_disabled(params: dict, ctx: DispatchContext) -> dict:
    """agents.skills.setDisabled — toggle one skill's per-agent disabled state
    directly (engine-native gate). Used by the "Buatan Agen" tab so agent-created
    skills reflect/control the real engine state, not the allowlist whitelist."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    name = params.get("name") or params.get("skillKey")
    disabled = params.get("disabled")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agentId required")
    if not name:
        raise RpcError("INVALID_REQUEST", "name required")
    if not isinstance(disabled, bool):
        raise RpcError("INVALID_REQUEST", "disabled (bool) required")
    try:
        return await ctx.agents.set_agent_skill_disabled(agent_id, name, disabled)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.skills.setDisabled"] = handle_agents_skill_set_disabled


async def handle_agents_skills_reset(params: dict, ctx: DispatchContext) -> dict:
    """agents.skills.resetToFactory — restore the factory skill baseline:
    builtin skills ON, non-builtin (bought/agent-created) OFF but kept."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agentId required")
    try:
        return await ctx.agents.reset_skills_to_factory(agent_id)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.skills.resetToFactory"] = handle_agents_skills_reset


async def handle_agents_describe(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.describe params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    overwrite = bool(params.get("overwrite") or False)
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.describe: agentId required")
    from agents_describer import describe_agent
    return await describe_agent(ctx.agents, agent_id, overwrite=overwrite)


METHOD_HANDLERS["agents.describe"] = handle_agents_describe


async def handle_agents_export(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.export params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    include_memory = bool(params.get("includeMemory", True))
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "agents.export: agentId required")
    from agents_archive import export_agent
    try:
        return await export_agent(ctx.agents, agent_id, include_memory=include_memory)
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.export"] = handle_agents_export


async def handle_agents_import(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.import params must be a dict")
    archive_b64 = params.get("base64") or params.get("archive")
    new_id = params.get("newAgentId") or params.get("agentId") or params.get("id")
    overwrite = bool(params.get("overwrite") or False)
    if not archive_b64:
        raise RpcError("INVALID_REQUEST", "agents.import: base64 required")
    from agents_archive import import_agent
    # Per-tier cap (D7) — a NEW import adds a profile; an overwrite replaces an
    # existing one (count unchanged), so only the new-import path is gated.
    async with _AGENT_CREATE_LOCK:
        if not overwrite:
            await _enforce_agent_cap(ctx)
        try:
            return await import_agent(
                ctx.agents,
                archive_base64=archive_b64,
                new_agent_id=new_id,
                overwrite=overwrite,
            )
        except AgentsError as e:
            raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.import"] = handle_agents_import


async def handle_agents_template_list(params: dict, ctx: DispatchContext) -> dict:
    from agents_templates import list_templates
    return list_templates()


METHOD_HANDLERS["agents.template.list"] = handle_agents_template_list


async def handle_agents_template_instantiate(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.template.instantiate params must be a dict")
    template_id = params.get("templateId") or params.get("template_id")
    new_id = params.get("newAgentId") or params.get("agentId") or params.get("id")
    if not template_id or not new_id:
        raise RpcError(
            "INVALID_REQUEST",
            "agents.template.instantiate: templateId + newAgentId required",
        )
    name = params.get("name")
    emoji = params.get("emoji")
    # 2026-05-30: wizard overrides — the user's step-2/3/4 edits win over the
    # template defaults. skills_override forwarded ONLY when the client sent a
    # list (possibly empty = user cleared all); older clients omit it -> None ->
    # template's preset skills stay.
    theme = params.get("theme")
    # 2026-06-08: role/persona tagline + model fallbacks were silently dropped on
    # the template path (only the blank path forwarded them). Forward both now —
    # description -> new profile sidecar, fallbacks -> new profile config.yaml.
    description_override = params.get("description")
    soul_override = params.get("soulContent") or params.get("soul")
    model_override = params.get("model") or params.get("modelPrimary")
    fallbacks_override = params.get("fallbacks")
    if not isinstance(fallbacks_override, list):
        fallbacks_override = None
    # Resolve the provider for the chosen model so a cross-provider model
    # (gpt-5.5 under openai-codex while gemini is default) routes correctly
    # instead of falling back to gemini. UI may pass providerSlug; auto-resolve
    # otherwise.
    provider_slug_override = params.get("providerSlug")
    if isinstance(model_override, str) and model_override.strip() and not provider_slug_override:
        provider_slug_override = await _resolve_model_provider_slug(
            model_override.strip(), ctx
        )
    skills_override = params.get("skills")
    if not isinstance(skills_override, list):
        skills_override = None
    from agents_templates import instantiate_template
    try:
        return await instantiate_template(
            ctx.agents,
            template_id=template_id,
            new_agent_id=new_id,
            custom_name=name,
            custom_emoji=emoji,
            custom_theme=theme,
            description_override=description_override,
            soul_override=soul_override,
            model_override=model_override,
            provider_slug_override=provider_slug_override,
            fallbacks_override=fallbacks_override,
            skills_override=skills_override,
        )
    except AgentsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["agents.template.instantiate"] = handle_agents_template_instantiate


# Memory CRUD ------------------------------------------------------


async def _memory_op(params: dict, ctx: DispatchContext, op: str) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", f"agents.memory.{op} params must be a dict")
    agent_id = params.get("agentId") or params.get("id")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", f"agents.memory.{op}: agentId required")
    import agents_memory as _mem
    try:
        if op == "entries":
            return await _mem.list_entries(ctx.agents, agent_id)
        if op == "addEntry":
            content = params.get("content") or ""
            return await _mem.add_entry(ctx.agents, agent_id, content)
        if op == "updateEntry":
            index = params.get("index")
            content = params.get("content") or ""
            return await _mem.update_entry(
                ctx.agents, agent_id,
                index if isinstance(index, int) else -1,
                content,
            )
        if op == "removeEntry":
            index = params.get("index")
            return await _mem.remove_entry(
                ctx.agents, agent_id,
                index if isinstance(index, int) else -1,
            )
        if op == "capacity":
            return await _mem.capacity(ctx.agents, agent_id)
        raise RpcError("INVALID_REQUEST", f"unknown memory op: {op}")
    except AgentsError as e:
        raise RpcError(e.code, e.message)


async def handle_agents_memory_entries(params: dict, ctx: DispatchContext) -> dict:
    return await _memory_op(params, ctx, "entries")


METHOD_HANDLERS["agents.memory.entries"] = handle_agents_memory_entries


async def handle_agents_memory_add(params: dict, ctx: DispatchContext) -> dict:
    return await _memory_op(params, ctx, "addEntry")


METHOD_HANDLERS["agents.memory.addEntry"] = handle_agents_memory_add


async def handle_agents_memory_update(params: dict, ctx: DispatchContext) -> dict:
    return await _memory_op(params, ctx, "updateEntry")


METHOD_HANDLERS["agents.memory.updateEntry"] = handle_agents_memory_update


async def handle_agents_memory_remove(params: dict, ctx: DispatchContext) -> dict:
    return await _memory_op(params, ctx, "removeEntry")


METHOD_HANDLERS["agents.memory.removeEntry"] = handle_agents_memory_remove


async def handle_agents_memory_capacity(params: dict, ctx: DispatchContext) -> dict:
    return await _memory_op(params, ctx, "capacity")


METHOD_HANDLERS["agents.memory.capacity"] = handle_agents_memory_capacity


# -----------------------------------------------------------------
# Tools — catalog + effective (UI Senjata panel)
# -----------------------------------------------------------------


async def handle_tools_catalog(params: dict, ctx: DispatchContext) -> dict:
    agent_id = (params or {}).get("agentId") or (params or {}).get("id") or "default"
    include_plugins = bool((params or {}).get("includePlugins", True))
    from tools_handler import build_tools_catalog
    return await build_tools_catalog(
        ctx.hermes, ctx.agents, agent_id, include_plugins=include_plugins,
    )


METHOD_HANDLERS["tools.catalog"] = handle_tools_catalog


async def handle_tools_effective(params: dict, ctx: DispatchContext) -> dict:
    agent_id = (params or {}).get("agentId") or (params or {}).get("id")
    session_key = (params or {}).get("sessionKey") or (params or {}).get("session_key")
    if not agent_id:
        raise RpcError("INVALID_REQUEST", "tools.effective: agentId required")
    from tools_handler import build_tools_effective
    return await build_tools_effective(ctx.hermes, ctx.agents, agent_id, session_key)


METHOD_HANDLERS["tools.effective"] = handle_tools_effective


async def handle_tools_toggle(params: dict, ctx: DispatchContext) -> dict:
    """tools.toggle — enable/disable a single toolset on a profile.

    Writes to REAL Hermes config.yaml::platform_toolsets.cli.
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "tools.toggle params must be a dict")
    # SECURITY (2026-06-08): require an EXPLICIT agentId. configure_toolset has no
    # _profile_exists guard, and a falsy agentId previously fell through to
    # "default" -> profile_home("default") = ~/.hermes (the GLOBAL root config),
    # so a missing/empty agentId silently rewrote platform_toolsets.cli for ALL
    # agents. Reject it. The literal "default" (editing the default agent) is
    # still allowed — only an empty/absent id is refused.
    agent_id = params.get("agentId") or params.get("id")
    if not agent_id or not str(agent_id).strip():
        raise RpcError(
            "INVALID_REQUEST",
            "tools.toggle: agentId required (refusing to fall back to global config)",
        )
    agent_id = str(agent_id).strip()
    toolset = params.get("toolset") or params.get("name")
    enable = params.get("enable")
    if not toolset or enable is None:
        raise RpcError("INVALID_REQUEST", "tools.toggle: toolset + enable required")
    from tools_handler import configure_toolset
    try:
        return await configure_toolset(
            ctx.hermes, ctx.agents, agent_id, str(toolset), bool(enable),
        )
    except ValueError as e:
        raise RpcError("ENGINE_ERROR", str(e))


METHOD_HANDLERS["tools.toggle"] = handle_tools_toggle


# -----------------------------------------------------------------
# Skills + models extras (UI Skill panel + ModelPicker)
# -----------------------------------------------------------------


async def handle_skills_update(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "skills.update params must be a dict")
    skill_key = params.get("skillKey") or params.get("name")
    enabled = params.get("enabled")
    if skill_key is None or enabled is None:
        raise RpcError("INVALID_REQUEST", "skills.update: skillKey + enabled required")
    from skills_extras import update_skill_enabled
    try:
        return await update_skill_enabled(ctx.config, str(skill_key), bool(enabled))
    except ValueError as e:
        raise RpcError("INVALID_REQUEST", str(e))


METHOD_HANDLERS["skills.update"] = handle_skills_update


async def handle_models_auth_status(params: dict, ctx: DispatchContext) -> dict:
    from skills_extras import build_models_auth_status
    return await build_models_auth_status()


METHOD_HANDLERS["models.authStatus"] = handle_models_auth_status


async def handle_agents_soul_generate(params: dict, ctx: DispatchContext) -> dict:
    """LLM-driven SOUL.md synthesis — used by wizard step 2 "Generate" button.

    Params:
      - name: str (required)        — agent display name
      - brief: str                  — long-form description from user
      - persona: str                — one-liner persona/expertise tagline
      - channelTargets: list[str]   — channels picked in wizard (web/tele/wa/etc)
      - tone: str                   — optional tone preference

    Returns { ok, soul, model } on success; { ok: false, reason } on error.
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "agents.soulGenerate params must be a dict")
    name = str(params.get("name") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "agents.soulGenerate: 'name' is required")

    brief = str(params.get("brief") or "")
    persona = str(params.get("persona") or "")
    channel_targets = params.get("channelTargets") or []
    if not isinstance(channel_targets, list):
        channel_targets = []
    tone = str(params.get("tone") or "")

    from agents_soul_generator import generate_soul
    return await generate_soul(
        name=name,
        brief=brief,
        persona=persona,
        channel_targets=[str(c) for c in channel_targets if c],
        tone=tone,
    )


METHOD_HANDLERS["agents.soulGenerate"] = handle_agents_soul_generate


# -----------------------------------------------------------------
# env.list — surface which env var NAMES are present in the container
# (NOT their values) so the UI's capability requirement resolver can
# show "ready" vs "butuh setup" badges accurately.
#
# Security: returns NAMES ONLY, filtered to a curated whitelist that
# covers known capability requirements. Random env vars (Docker
# bookkeeping, container metadata, system paths) NEVER leave the
# bridge. If a new capability needs detection, add its env prefix to
# `_ENV_NAME_PATTERNS` below.
# -----------------------------------------------------------------

import os as _os
import re as _re

# Patterns for env var names the UI is allowed to know about.
# Matches names (case-sensitive — env vars are conventionally UPPER_SNAKE).
_ENV_NAME_PATTERNS: list[_re.Pattern] = [
    _re.compile(r".*_API_KEY$"),
    _re.compile(r".*_TOKEN$"),
    _re.compile(r".*_SECRET$"),
    _re.compile(r".*_CLIENT_ID$"),
    _re.compile(r".*_REFRESH_TOKEN$"),
    _re.compile(r".*_ACCESS_TOKEN$"),
    _re.compile(r"^GEMINI_.*"),
    _re.compile(r"^OPENAI_.*"),
    _re.compile(r"^ANTHROPIC_.*"),
    _re.compile(r"^GROQ_.*"),
    _re.compile(r"^DEEPGRAM_.*"),
    _re.compile(r"^DEEPSEEK_.*"),
    _re.compile(r"^XAI_.*"),
    _re.compile(r"^QWEN_.*"),
    _re.compile(r"^MOONSHOT_.*"),
    _re.compile(r"^MISTRAL_.*"),
    _re.compile(r"^BRAVE_.*"),
    _re.compile(r"^HASS_.*"),
    _re.compile(r"^HOMEASSISTANT_.*"),
    _re.compile(r"^SPOTIFY_.*"),
    _re.compile(r"^GITHUB_.*"),
    _re.compile(r"^GOOGLE_.*"),
    _re.compile(r"^MATRIX_.*"),
    _re.compile(r"^MATTERMOST_.*"),
    _re.compile(r"^NOTION_.*"),
    _re.compile(r"^TELEGRAM_.*"),
    _re.compile(r"^DISCORD_.*"),
    _re.compile(r"^SLACK_.*"),
    _re.compile(r"^WHATSAPP_.*"),
    _re.compile(r"^STRIPE_.*"),
    _re.compile(r"^MIDTRANS_.*"),
]


def _is_capability_env_name(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    for pat in _ENV_NAME_PATTERNS:
        if pat.match(name):
            return True
    return False


async def handle_env_list(params: dict, ctx: DispatchContext) -> dict:
    """env.list — return env var NAMES (no values) that the UI needs to
    decide capability readiness badges. Curated whitelist via
    `_ENV_NAME_PATTERNS`. Empty string values are treated as missing."""
    present: list[str] = []
    for name, value in _os.environ.items():
        if not _is_capability_env_name(name):
            continue
        if not value or not value.strip():
            continue
        present.append(name)
    present.sort()
    return {"presentKeys": present, "totalScanned": len(_os.environ)}


METHOD_HANDLERS["env.list"] = handle_env_list


# -----------------------------------------------------------------
# Plugins — Hermes plugin manager exposed for /app/agents Plugin tab
# -----------------------------------------------------------------


_PLUGINS_HANDLER_REGISTRY: dict = {"handler": None}


def _get_plugins_handler(ctx: DispatchContext):
    """Lazy-init bridge PluginsHandler bound to the same HERMES_HOME."""
    h = _PLUGINS_HANDLER_REGISTRY["handler"]
    if h is not None:
        return h
    from plugins_handler import PluginsHandler
    from pathlib import Path as _Path
    home = ctx.agents._home if ctx.agents is not None else _Path(
        os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
    )
    h = PluginsHandler(home)
    _PLUGINS_HANDLER_REGISTRY["handler"] = h
    return h


async def handle_plugins_list(params: dict, ctx: DispatchContext) -> dict:
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).list_plugins()
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.list"] = handle_plugins_list


async def handle_plugins_info(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "plugins.info params must be a dict")
    key = params.get("key") or params.get("name") or params.get("id")
    if not key:
        raise RpcError("INVALID_REQUEST", "plugins.info: key required")
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).get_plugin(key)
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.info"] = handle_plugins_info


async def handle_plugins_enable(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "plugins.enable params must be a dict")
    key = params.get("key") or params.get("name") or params.get("id")
    if not key:
        raise RpcError("INVALID_REQUEST", "plugins.enable: key required")
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).enable_plugin(key)
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.enable"] = handle_plugins_enable


async def handle_plugins_disable(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "plugins.disable params must be a dict")
    key = params.get("key") or params.get("name") or params.get("id")
    if not key:
        raise RpcError("INVALID_REQUEST", "plugins.disable: key required")
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).disable_plugin(key)
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.disable"] = handle_plugins_disable


async def handle_plugins_remove(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "plugins.remove params must be a dict")
    key = params.get("key") or params.get("name") or params.get("id")
    if not key:
        raise RpcError("INVALID_REQUEST", "plugins.remove: key required")
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).remove_plugin(key)
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.remove"] = handle_plugins_remove


async def handle_plugins_discover(params: dict, ctx: DispatchContext) -> dict:
    from plugins_handler import PluginsError
    try:
        return await _get_plugins_handler(ctx).force_discover()
    except PluginsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["plugins.discover"] = handle_plugins_discover


# -----------------------------------------------------------------
# MCP (Model Context Protocol) — external connectors
# -----------------------------------------------------------------


_MCP_HANDLER_REGISTRY: dict = {"handler": None}


def _get_mcp_handler(ctx: DispatchContext):
    h = _MCP_HANDLER_REGISTRY["handler"]
    if h is not None:
        return h
    from mcp_handler import McpHandler
    from pathlib import Path as _Path
    home = ctx.agents._home if ctx.agents is not None else _Path(
        os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
    )
    h = McpHandler(home)
    _MCP_HANDLER_REGISTRY["handler"] = h
    return h


async def handle_mcp_list(params: dict, ctx: DispatchContext) -> dict:
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).list_servers()
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.list"] = handle_mcp_list


async def handle_mcp_info(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "mcp.info params must be a dict")
    name = params.get("name") or params.get("id")
    if not name:
        raise RpcError("INVALID_REQUEST", "mcp.info: name required")
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).get_server(name)
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.info"] = handle_mcp_info


async def handle_mcp_presets(params: dict, ctx: DispatchContext) -> dict:
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).list_presets()
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.presets"] = handle_mcp_presets


async def handle_mcp_add(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "mcp.add params must be a dict")
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).add_server(params)
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.add"] = handle_mcp_add


async def handle_mcp_remove(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "mcp.remove params must be a dict")
    name = params.get("name") or params.get("id")
    if not name:
        raise RpcError("INVALID_REQUEST", "mcp.remove: name required")
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).remove_server(name)
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.remove"] = handle_mcp_remove


async def handle_mcp_test(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "mcp.test params must be a dict")
    name = params.get("name") or params.get("id")
    if not name:
        raise RpcError("INVALID_REQUEST", "mcp.test: name required")
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).test_server(name)
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.test"] = handle_mcp_test


async def handle_mcp_configure(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "mcp.configure params must be a dict")
    name = params.get("name") or params.get("id")
    if not name:
        raise RpcError("INVALID_REQUEST", "mcp.configure: name required")
    from mcp_handler import McpError
    try:
        return await _get_mcp_handler(ctx).configure_server(
            name,
            enabled_tools=params.get("enabledTools") or params.get("enabled_tools"),
            enabled=params.get("enabled"),
        )
    except McpError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["mcp.configure"] = handle_mcp_configure


# -----------------------------------------------------------------
# Channels — custom (config.yaml + restart)
# -----------------------------------------------------------------


async def handle_channels_status(params: dict, ctx: DispatchContext) -> dict:
    return await ctx.channels.status()


METHOD_HANDLERS["channels.status"] = handle_channels_status


# Serializes channel-pairing RPCs so the per-tier cap can't be raced.
_CHANNEL_PAIR_LOCK = asyncio.Lock()


def _count_channel_accounts(status: dict) -> int:
    """Total channel accounts: NATIVE (channels[].accounts) + SYNTHETIC
    (agentChannels[].channels[].accounts across all agents). Counting the
    synthetic side too fixes the undercount the portal's totals had."""
    total = 0
    for ch in (status.get("channels") or {}).values():
        if isinstance(ch, dict):
            total += len(ch.get("accounts") or [])
    for ag in (status.get("agentChannels") or {}).values():
        if not isinstance(ag, dict):
            continue
        for ch in (ag.get("channels") or {}).values():
            if isinstance(ch, dict):
                total += len(ch.get("accounts") or [])
    return total


def _channel_account_exists(status: dict, channel_id: str, account_id) -> bool:
    """True if pairing (channel_id, account_id) would re-pair an EXISTING account
    rather than add a new one — so a user at their cap can still fix/re-pair an
    already-connected channel."""
    def _aid(a: dict):
        return a.get("account_id") or a.get("accountId")

    ch = (status.get("channels") or {}).get(channel_id)
    if isinstance(ch, dict):
        accts = ch.get("accounts") or []
        if account_id is None and accts:
            return True
        if account_id is not None and any(_aid(a) == account_id for a in accts):
            return True
    for ag in (status.get("agentChannels") or {}).values():
        if not isinstance(ag, dict):
            continue
        sch = (ag.get("channels") or {}).get(channel_id)
        if isinstance(sch, dict) and account_id is not None:
            if any(_aid(a) == account_id for a in (sch.get("accounts") or [])):
                return True
    return False


async def _enforce_channel_cap(ctx: DispatchContext, channel_id: str, account_id) -> None:
    """Raise RpcError if adding a NEW channel account would exceed the per-tier
    cap. Re-pairing an existing account is always allowed. Fail-open on a counting
    error. Call while holding _CHANNEL_PAIR_LOCK."""
    if ctx.tier_limits is None:
        return
    try:
        status = await ctx.channels.status()
    except ChannelsError:
        return  # can't count -> fail open
    if _channel_account_exists(status, channel_id, account_id):
        return  # re-pair, not a new add
    try:
        await ctx.tier_limits.check_count("channels", _count_channel_accounts(status))
    except LimitError as e:
        raise RpcError(e.code, e.message)


async def handle_channels_pair(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.pair params must be a dict")
    channel_id = params.get("channel") or params.get("channelId")
    if not channel_id:
        raise RpcError("INVALID_REQUEST", "channels.pair: channel required")
    credentials = params.get("credentials") or {}
    account_id = params.get("accountId")
    agent_id = params.get("agentId") or params.get("agent_id")
    # Per-tier cap (D7) + the pair, under one lock so the count-then-pair window
    # can't be raced. Re-pairing an existing account is always allowed.
    async with _CHANNEL_PAIR_LOCK:
        await _enforce_channel_cap(ctx, channel_id, account_id)
        try:
            return await ctx.channels.pair(
                channel_id, credentials, account_id=account_id, agent_id=agent_id
            )
        except ChannelsError as e:
            raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.pair"] = handle_channels_pair


async def handle_channels_logout(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.logout params must be a dict")
    channel_id = params.get("channel") or params.get("channelId")
    if not channel_id:
        raise RpcError("INVALID_REQUEST", "channels.logout: channel required")
    account_id = params.get("accountId")
    agent_id = params.get("agentId") or params.get("agent_id")
    try:
        return await ctx.channels.logout(
            channel_id, account_id=account_id, agent_id=agent_id
        )
    except ChannelsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.logout"] = handle_channels_logout


async def handle_channels_get_access(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.getAccess params must be a dict")
    channel_id = params.get("channel") or params.get("channelId")
    if not channel_id:
        raise RpcError("INVALID_REQUEST", "channels.getAccess: channel required")
    try:
        return await ctx.channels.get_access(
            channel_id,
            account_id=params.get("accountId"),
            agent_id=params.get("agentId") or params.get("agent_id"),
        )
    except ChannelsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.getAccess"] = handle_channels_get_access


async def handle_channels_set_access(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.setAccess params must be a dict")
    channel_id = params.get("channel") or params.get("channelId")
    if not channel_id:
        raise RpcError("INVALID_REQUEST", "channels.setAccess: channel required")
    allow_from = params.get("allowFrom")
    if not isinstance(allow_from, list):
        raise RpcError("INVALID_REQUEST", "channels.setAccess: allowFrom must be a list")
    try:
        return await ctx.channels.set_access(
            channel_id,
            allow_from=allow_from,
            group_allow_from=params.get("groupAllowFrom"),
            account_id=params.get("accountId"),
            agent_id=params.get("agentId") or params.get("agent_id"),
        )
    except ChannelsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.setAccess"] = handle_channels_set_access


async def handle_channels_upsert_binding(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.upsertBinding params must be a dict")
    binding = params.get("binding") or params
    try:
        return await ctx.channels.upsert_binding(binding)
    except ChannelsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.upsertBinding"] = handle_channels_upsert_binding


async def handle_channels_delete_binding(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "channels.deleteBinding params must be a dict")
    try:
        return await ctx.channels.delete_binding(params)
    except ChannelsError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["channels.deleteBinding"] = handle_channels_delete_binding


# -----------------------------------------------------------------
# WhatsApp per-agent QR pairing (web.login.start / web.login.wait)
# -----------------------------------------------------------------
# The Hermes pip wheel ships no WhatsApp QR flow (web.login.* were OpenClaw
# gateway RPCs). AgentBuff implements them here on top of the baked Baileys
# bridge (docker/hermes-bridge/whatsapp-bridge) + wa_pairing.WaPairingManager.
# account_id defaults to agent_id → one WhatsApp number per agent.


def _require_wa_pairing():
    mgr = _WA_PAIRING_REGISTRY.get("mgr")
    if mgr is None:
        raise RpcError("UNAVAILABLE", "WhatsApp pairing belum siap")
    return mgr


async def handle_web_login_start(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        params = {}
    mgr = _require_wa_pairing()
    # Per-tier cap (D7): WhatsApp bypasses channels.pair, so gate it here too —
    # block opening the QR if a NEW whatsapp account would exceed the cap. A
    # force re-login of an existing account is allowed (re-pair).
    wa_account = (
        params.get("accountId")
        or params.get("agentId")
        or params.get("agent_id")
    )
    async with _CHANNEL_PAIR_LOCK:
        await _enforce_channel_cap(ctx, "whatsapp", wa_account)
    try:
        return await mgr.start(
            account_id=params.get("accountId"),
            agent_id=params.get("agentId") or params.get("agent_id"),
            force=bool(params.get("force")),
        )
    except WaPairingError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["web.login.start"] = handle_web_login_start


async def handle_web_login_wait(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        params = {}
    mgr = _require_wa_pairing()
    allow_from = params.get("allowFrom")
    try:
        return await mgr.wait(
            account_id=params.get("accountId"),
            agent_id=params.get("agentId") or params.get("agent_id"),
            allow_from=allow_from if isinstance(allow_from, list) else None,
        )
    except WaPairingError as e:
        raise RpcError(e.code, e.message)


METHOD_HANDLERS["web.login.wait"] = handle_web_login_wait


# -----------------------------------------------------------------
# Config — RFC 7396 merge-patch wrapper over Hermes config.set
# -----------------------------------------------------------------


# SECURITY: never return raw secrets to any client. config.get/patch responses
# are redacted so API keys / tokens never travel back over the wire or land in
# any log. Field names matched case-insensitively by substring.
def _redact_secrets(obj: Any) -> Any:
    import re as _r
    pat = _r.compile(r"(apikey|api_key|secret|token|password|passwd|privatekey|private_key|bearer|credential|clientsecret|client_secret)", _r.IGNORECASE)
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and pat.search(k.replace("-", "").replace("_", "")) and isinstance(v, (str, int, float)) and str(v):
                out[k] = "__SET__"  # presence flag only — never the value
            else:
                out[k] = _redact_secrets(v)
        return out
    if isinstance(obj, list):
        return [_redact_secrets(x) for x in obj]
    return obj


async def handle_config_get(params: dict, ctx: DispatchContext) -> dict:
    key_path = (params or {}).get("key") if isinstance(params, dict) else None
    try:
        value = await ctx.config.get(key_path)
    except ConfigError as e:
        raise RpcError("CONFIG_ERROR", str(e))
    return {"value": _redact_secrets(value)}


METHOD_HANDLERS["config.get"] = handle_config_get


async def handle_config_patch(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "config.patch params must be a dict")
    # `restart` is a control flag (not config). Pull it out BEFORE resolving the
    # patch so it can never leak into the written config tree. The AgentBuff
    # Settings page sends {patch, restart:true} so user-facing config changes
    # (personality/approvals/memory/tts/…) take effect immediately — plain
    # config.patch does NOT restart the engine (only providers/channels do).
    want_restart = bool(params.get("restart"))
    if "patch" in params:
        patch = params.get("patch")
    else:
        # params IS the patch — strip our control key so it isn't persisted.
        patch = {k: v for k, v in params.items() if k != "restart"}
    try:
        updated = await ctx.config.patch(patch)
    except ConfigError as e:
        raise RpcError("CONFIG_ERROR", str(e))
    res = {"ok": True, "config": _redact_secrets(updated)}
    if want_restart:
        res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["config.patch"] = handle_config_patch


# -----------------------------------------------------------------
# Providers — BYOK provider catalog, model discovery, credential pool, OAuth
# (providers_handler.py — pure bridge, no engine source modification)
# -----------------------------------------------------------------


async def handle_providers_catalog(params: dict, ctx: DispatchContext) -> dict:
    return providers_handler.get_catalog()


METHOD_HANDLERS["providers.catalog"] = handle_providers_catalog


async def handle_providers_discover(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.discover params must be a dict")
    provider = params.get("provider")
    if not provider:
        raise RpcError("INVALID_REQUEST", "provider required")
    return await providers_handler.discover_models(
        provider, params.get("baseUrl"), params.get("apiKey"),
    )


METHOD_HANDLERS["providers.discover"] = handle_providers_discover
# alias under models.* for symmetry with models.list / models.authStatus
METHOD_HANDLERS["models.discover"] = handle_providers_discover


async def _restart_engine(ctx: DispatchContext) -> bool:
    """Schedule a NON-BLOCKING restart of the Hermes chat engine subprocess so a
    freshly-written .env key / model is picked up. Returns immediately (the
    restart runs in the background, ~10s) so the RPC doesn't block / time out.
    The key is already on disk + in authStatus, so the badge flips instantly;
    the engine finishes adopting it a few seconds later."""
    app = ctx.bridge_app
    if app is None or not hasattr(app, "_restart_hermes_subprocess"):
        return False

    async def _bg() -> None:
        try:
            await app._restart_hermes_subprocess()
        except Exception:  # noqa: BLE001 — restart failure must not lose the key
            log.exception("provider key save: background engine restart failed")

    try:
        asyncio.create_task(_bg())
        return True
    except Exception:  # noqa: BLE001
        log.exception("provider key save: could not schedule engine restart")
        return False


async def handle_providers_set_key(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.setKey params must be a dict")
    provider = params.get("provider")
    api_key = params.get("apiKey")
    if not provider or not api_key:
        raise RpcError("INVALID_REQUEST", "provider and apiKey required")
    res = providers_handler.set_key(provider, api_key)
    if not res.get("ok"):
        raise RpcError("SET_KEY_FAILED", res.get("error") or "set key failed")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.setKey"] = handle_providers_set_key


async def handle_providers_set_custom(params: dict, ctx: DispatchContext) -> dict:
    """Register a Custom (OpenAI-compatible) endpoint as a first-class provider.

    Writes config.yaml `providers.custom = {name, base_url, key_env, model}` so
    the engine's `model.options` lists it (→ it appears in the per-agent model
    picker) and routes chats through `base_url`. The API key stays in .env
    (CUSTOM_API_KEY) — config only references it via key_env, so the secret
    never lands in config.yaml. Verified shape 2026-06-03: model.options then
    returns `slug=custom user_defined=true models=[<model>]`."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.setCustom params must be a dict")
    base_url = (params.get("baseUrl") or "").strip()
    if not base_url:
        raise RpcError("INVALID_REQUEST", "baseUrl required")
    # SEC1 — SSRF guard: this base_url is stored + used as a chat-time endpoint
    # with the user's key; reject private/loopback/metadata hosts before write.
    _ssrf = providers_handler.validate_external_url(base_url)
    if _ssrf:
        raise RpcError("INVALID_REQUEST", _ssrf)
    api_key = (params.get("apiKey") or "").strip()
    model = (params.get("model") or "").strip()
    name = (params.get("name") or "Custom endpoint").strip()
    # Secret to .env (also drives the authStatus badge); config references it.
    if api_key:
        kr = providers_handler.set_key("custom", api_key)
        if not kr.get("ok"):
            raise RpcError("SET_KEY_FAILED", kr.get("error") or "set key failed")
    # Two SCOPED writes (verified 2026-06-03 — must NOT touch the global
    # `model.base_url`, which would route the ACTIVE model through this endpoint
    # and break it, e.g. gemini reported an 8192 ctx window from a local server):
    #  1. providers.custom (keyed v12 schema) → makes the model appear in
    #     `model.options`, i.e. the per-agent model picker.
    #  2. custom_providers (legacy LIST) → the runtime credential source that
    #     `agent.auxiliary_client` / `resolve_custom_provider` read at chat time
    #     when a session resolves to provider=custom. SCOPED to the custom
    #     provider only — selecting a non-custom model is unaffected.
    # api_key inline (config.get redacts the "api_key" field on the wire). We do
    # NOT set model.default/provider — registering ≠ activating; the per-agent
    # picker selects the custom model when the user wants it.
    keyed: dict = {"name": name, "base_url": base_url, "key_env": "CUSTOM_API_KEY"}
    legacy: dict = {"name": name, "base_url": base_url}
    if api_key:
        keyed["api_key"] = api_key
        legacy["api_key"] = api_key
    if model:
        keyed["model"] = model
        legacy["model"] = model
    try:
        await ctx.config.patch({
            "providers": {"custom": keyed},
            "custom_providers": [legacy],
        })
    except ConfigError as e:
        raise RpcError("CONFIG_ERROR", str(e))
    restarted = await _restart_engine(ctx)
    return {"ok": True, "baseUrl": base_url, "model": model or None, "restarted": restarted}


METHOD_HANDLERS["providers.setCustom"] = handle_providers_set_custom


async def handle_providers_delete_key(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.deleteKey params must be a dict")
    provider = params.get("provider")
    if not provider:
        raise RpcError("INVALID_REQUEST", "provider required")
    res = providers_handler.delete_key(provider)
    if not res.get("ok"):
        raise RpcError("DELETE_KEY_FAILED", res.get("error") or "delete key failed")
    # For custom, ALSO drop the registered provider entry (RFC 7396 null = delete)
    # so it disappears from model.options + the agent picker.
    if provider == "custom":
        try:
            await ctx.config.patch({"providers": {"custom": None}, "custom_providers": None})
        except ConfigError:
            log.exception("providers.deleteKey: failed to remove custom provider config")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.deleteKey"] = handle_providers_delete_key


async def handle_providers_set_model(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.setModel params must be a dict")
    model = (params.get("model") or "").strip()
    if not model:
        raise RpcError("INVALID_REQUEST", "model required")
    # Hermes reads `model.default` (NOT the OpenClaw-era agents.defaults.model.primary).
    patch: dict = {"model": {"default": model}}
    base_url = (params.get("baseUrl") or "").strip()
    if base_url:
        patch["model"]["base_url"] = base_url
    try:
        await ctx.config.patch(patch)
    except ConfigError as e:
        raise RpcError("CONFIG_ERROR", str(e))
    restarted = await _restart_engine(ctx)
    return {"ok": True, "model": model, "restarted": restarted}


METHOD_HANDLERS["providers.setModel"] = handle_providers_set_model


async def handle_providers_pool_list(params: dict, ctx: DispatchContext) -> dict:
    provider = (params or {}).get("provider") if isinstance(params, dict) else None
    return await asyncio.to_thread(providers_handler.pool_list, provider)


METHOD_HANDLERS["providers.pool.list"] = handle_providers_pool_list


async def handle_providers_pool_add(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.pool.add params must be a dict")
    res = await asyncio.to_thread(
        providers_handler.pool_add,
        params.get("provider"), params.get("apiKey"), params.get("label"),
    )
    if not res.get("ok"):
        raise RpcError("POOL_ADD_FAILED", res.get("error") or "add failed")
    return res


METHOD_HANDLERS["providers.pool.add"] = handle_providers_pool_add


async def handle_providers_pool_remove(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.pool.remove params must be a dict")
    res = await asyncio.to_thread(
        providers_handler.pool_remove,
        params.get("provider"), params.get("selector"),
    )
    if not res.get("ok"):
        raise RpcError("POOL_REMOVE_FAILED", res.get("error") or "remove failed")
    return res


METHOD_HANDLERS["providers.pool.remove"] = handle_providers_pool_remove


async def handle_providers_oauth_start(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.oauth.start params must be a dict")
    provider = params.get("provider")
    if not provider:
        raise RpcError("INVALID_REQUEST", "provider required")
    try:
        timeout = int(params.get("timeout") or 300)
    except (TypeError, ValueError):
        timeout = 300
    try:
        return await providers_handler.OAUTH_MANAGER.start(provider, timeout)
    except RuntimeError as e:
        raise RpcError("OAUTH_START_FAILED", str(e))
    except ValueError as e:
        raise RpcError("INVALID_REQUEST", str(e))


METHOD_HANDLERS["providers.oauth.start"] = handle_providers_oauth_start


async def handle_providers_oauth_poll(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.oauth.poll params must be a dict")
    flow_id = params.get("flowId")
    if not flow_id:
        raise RpcError("INVALID_REQUEST", "flowId required")
    try:
        cursor = int(params.get("cursor") or 0)
    except (TypeError, ValueError):
        cursor = 0
    return providers_handler.OAUTH_MANAGER.poll(flow_id, cursor)


METHOD_HANDLERS["providers.oauth.poll"] = handle_providers_oauth_poll


async def handle_providers_oauth_cancel(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.oauth.cancel params must be a dict")
    flow_id = params.get("flowId")
    if not flow_id:
        raise RpcError("INVALID_REQUEST", "flowId required")
    return providers_handler.OAUTH_MANAGER.cancel(flow_id)


METHOD_HANDLERS["providers.oauth.cancel"] = handle_providers_oauth_cancel


async def handle_providers_oauth_relay(params: dict, ctx: DispatchContext) -> dict:
    """Loopback OAuth completion — user pastes the redirect URL/code; bridge
    replays it to the in-container callback server."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.oauth.relay params must be a dict")
    flow_id = params.get("flowId")
    pasted = params.get("input") or params.get("code") or params.get("redirectUrl")
    if not flow_id or not pasted:
        raise RpcError("INVALID_REQUEST", "flowId and input required")
    res = providers_handler.OAUTH_MANAGER.relay(flow_id, pasted)
    if not res.get("ok"):
        raise RpcError("OAUTH_RELAY_FAILED", res.get("error") or "relay failed")
    return res


METHOD_HANDLERS["providers.oauth.relay"] = handle_providers_oauth_relay


# ── Engine-canonical mirror (anti-drift) — /app/providers reads these so it
# always matches the engine /env page exactly ──────────────────────────────
async def handle_providers_oauth_list(params: dict, ctx: DispatchContext) -> dict:
    """The 6 canonical OAuth providers (engine _OAUTH_PROVIDER_CATALOG) + live
    status. Mirrors the engine /env "Provider Logins (OAuth)" section."""
    return providers_handler.engine_oauth_list()


METHOD_HANDLERS["providers.oauthList"] = handle_providers_oauth_list


async def handle_providers_env_catalog(params: dict, ctx: DispatchContext) -> dict:
    """Every LLM-provider env var the engine recognizes (OPTIONAL_ENV_VARS
    category=provider) + is_set/redacted. Mirrors /env "Provider LLM API"."""
    return providers_handler.engine_env_catalog()


METHOD_HANDLERS["providers.envCatalog"] = handle_providers_env_catalog


async def handle_providers_test_key(params: dict, ctx: DispatchContext) -> dict:
    """Validate a saved provider key by probing the provider's /models endpoint
    (engine has no native validity RPC). Reads the key from .env server-side."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.testKey params must be a dict")
    key = params.get("key")
    if not key:
        raise RpcError("INVALID_REQUEST", "key required")
    return await providers_handler.test_key(str(key))


METHOD_HANDLERS["providers.testKey"] = handle_providers_test_key


async def handle_providers_set_env(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.setEnv params must be a dict")
    key = params.get("key")
    value = params.get("value")
    if not key or value is None:
        raise RpcError("INVALID_REQUEST", "key and value required")
    res = providers_handler.set_env(str(key), str(value))
    if not res.get("ok"):
        raise RpcError("SET_ENV_FAILED", res.get("error") or "set env failed")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.setEnv"] = handle_providers_set_env


async def handle_providers_delete_env(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.deleteEnv params must be a dict")
    key = params.get("key")
    if not key:
        raise RpcError("INVALID_REQUEST", "key required")
    res = providers_handler.delete_env(str(key))
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.deleteEnv"] = handle_providers_delete_env


async def handle_providers_qwen_creds(params: dict, ctx: DispatchContext) -> dict:
    """qwen-oauth (external): write the user-pasted Qwen CLI oauth_creds.json so
    the engine can read it, then restart so it's adopted."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.qwenCreds params must be a dict")
    raw = params.get("json") or params.get("creds")
    if not raw:
        raise RpcError("INVALID_REQUEST", "json (qwen oauth_creds.json content) required")
    res = providers_handler.write_qwen_creds(str(raw))
    if not res.get("ok"):
        raise RpcError("QWEN_CREDS_FAILED", res.get("error") or "write failed")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.qwenCreds"] = handle_providers_qwen_creds


async def handle_providers_claude_creds(params: dict, ctx: DispatchContext) -> dict:
    """claude-code (external): write ~/.claude/.credentials.json from the
    user-pasted setup-token / credentials JSON, then restart to adopt."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.claudeCreds params must be a dict")
    raw = params.get("token") or params.get("json") or params.get("creds")
    if not raw:
        raise RpcError("INVALID_REQUEST", "token or json required")
    res = providers_handler.write_claude_creds(str(raw))
    if not res.get("ok"):
        raise RpcError("CLAUDE_CREDS_FAILED", res.get("error") or "write failed")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.claudeCreds"] = handle_providers_claude_creds


async def handle_providers_oauth_disconnect(params: dict, ctx: DispatchContext) -> dict:
    """Disconnect an OAuth provider (delete creds / remove pooled credential),
    then restart so the engine drops it."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "providers.oauthDisconnect params must be a dict")
    pid = params.get("id") or params.get("provider")
    if not pid:
        raise RpcError("INVALID_REQUEST", "id required")
    res = providers_handler.disconnect_oauth(str(pid))
    if not res.get("ok"):
        raise RpcError("OAUTH_DISCONNECT_FAILED", res.get("error") or "disconnect failed")
    res["restarted"] = await _restart_engine(ctx)
    return res


METHOD_HANDLERS["providers.oauthDisconnect"] = handle_providers_oauth_disconnect


# ── Kanban (Papan Tugas) — agentic task board, mirrors engine /kanban ───────
import kanban_handler  # noqa: E402


async def handle_kanban_boards(params: dict, ctx: DispatchContext) -> dict:
    return await asyncio.to_thread(kanban_handler.list_boards)


METHOD_HANDLERS["kanban.boards"] = handle_kanban_boards


async def handle_kanban_tasks(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.list_tasks, p.get("board"), bool(p.get("includeArchived"))
    )


METHOD_HANDLERS["kanban.tasks"] = handle_kanban_tasks


async def handle_kanban_task_detail(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    task_id = p.get("taskId") or p.get("id")
    if not task_id:
        raise RpcError("INVALID_REQUEST", "taskId required")
    return await asyncio.to_thread(kanban_handler.task_detail, p.get("board"), str(task_id))


METHOD_HANDLERS["kanban.taskDetail"] = handle_kanban_task_detail


async def handle_kanban_create(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    title = (p.get("title") or "").strip()
    if not title:
        raise RpcError("INVALID_REQUEST", "title required")
    return await asyncio.to_thread(
        kanban_handler.create_task,
        p.get("board"),
        title,
        p.get("body"),
        p.get("assignee"),
        int(p.get("priority") or 0),
        bool(p.get("triage")),
        p.get("skills"),
        p.get("initialStatus"),
        p.get("maxRuntimeSeconds"),
        p.get("tenant"),
        p.get("maxRetries"),
    )


METHOD_HANDLERS["kanban.createTask"] = handle_kanban_create


_KANBAN_TASK_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _kanban_task_id(p: dict) -> str:
    tid = p.get("taskId") or p.get("id")
    if not tid:
        raise RpcError("INVALID_REQUEST", "taskId required")
    tid = str(tid)
    # Guard the trust boundary: task_id is concatenated into a filesystem path
    # for worker-log reads (<logs>/<task_id>.log). Reject traversal/separators so
    # a crafted id like "../../config" cannot escape the logs dir. Real ids are
    # "t_<hex8>", well within this allowlist.
    if ".." in tid or not _KANBAN_TASK_ID_RE.match(tid):
        raise RpcError("INVALID_REQUEST", "invalid taskId")
    return tid


async def handle_kanban_move(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    to_status = p.get("toStatus") or p.get("status")
    if not to_status:
        raise RpcError("INVALID_REQUEST", "toStatus required")
    return await asyncio.to_thread(
        kanban_handler.move_task, p.get("board"), _kanban_task_id(p), str(to_status)
    )


METHOD_HANDLERS["kanban.moveTask"] = handle_kanban_move


async def handle_kanban_action(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    action = (p.get("action") or "").strip()
    board = p.get("board")
    tid = _kanban_task_id(p)
    fn = {
        "complete": kanban_handler.complete,
        "block": kanban_handler.block,
        "unblock": kanban_handler.unblock,
        "promote": kanban_handler.promote,
        "archive": kanban_handler.archive,
        "delete": kanban_handler.delete,
    }.get(action)
    if fn is None:
        raise RpcError("INVALID_REQUEST", f"unknown action {action!r}")
    return await asyncio.to_thread(fn, board, tid)


METHOD_HANDLERS["kanban.action"] = handle_kanban_action


async def handle_kanban_comment(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    body = (p.get("body") or "").strip()
    if not body:
        raise RpcError("INVALID_REQUEST", "body required")
    return await asyncio.to_thread(
        kanban_handler.add_comment, p.get("board"), _kanban_task_id(p), body
    )


METHOD_HANDLERS["kanban.addComment"] = handle_kanban_comment


async def handle_kanban_reassign(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.reassign, p.get("board"), _kanban_task_id(p), p.get("assignee")
    )


METHOD_HANDLERS["kanban.reassign"] = handle_kanban_reassign


async def handle_kanban_schedule(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.schedule, p.get("board"), _kanban_task_id(p)
    )


METHOD_HANDLERS["kanban.schedule"] = handle_kanban_schedule


async def handle_kanban_edit(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.edit_task,
        p.get("board"),
        _kanban_task_id(p),
        p.get("title"),
        p.get("body"),
        p.get("assignee"),
    )


METHOD_HANDLERS["kanban.editTask"] = handle_kanban_edit


async def handle_kanban_decompose(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(kanban_handler.decompose, p.get("board"), _kanban_task_id(p))


METHOD_HANDLERS["kanban.decompose"] = handle_kanban_decompose


async def handle_kanban_reclaim(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.reclaim, p.get("board"), _kanban_task_id(p), p.get("reason")
    )


METHOD_HANDLERS["kanban.reclaim"] = handle_kanban_reclaim


async def handle_kanban_context(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(kanban_handler.worker_context, p.get("board"), _kanban_task_id(p))


METHOD_HANDLERS["kanban.context"] = handle_kanban_context


async def handle_kanban_diagnostics(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(kanban_handler.diagnostics, p.get("board"))


METHOD_HANDLERS["kanban.diagnostics"] = handle_kanban_diagnostics


async def handle_kanban_swarm(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    goal = (p.get("goal") or "").strip()
    if not goal:
        raise RpcError("INVALID_REQUEST", "goal required")
    return await asyncio.to_thread(
        kanban_handler.create_swarm,
        p.get("board"),
        goal,
        p.get("workers") or [],
        p.get("verifier") or "default",
        p.get("synthesizer") or "default",
        int(p.get("priority") or 0),
    )


METHOD_HANDLERS["kanban.swarm"] = handle_kanban_swarm


async def handle_kanban_assignees(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(kanban_handler.known_assignees, p.get("board"))


METHOD_HANDLERS["kanban.assignees"] = handle_kanban_assignees


async def handle_kanban_create_board(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    slug = (p.get("slug") or "").strip()
    if not slug:
        raise RpcError("INVALID_REQUEST", "slug required")
    return await asyncio.to_thread(
        kanban_handler.create_board,
        slug,
        p.get("name"),
        p.get("description"),
        p.get("icon"),
        p.get("color"),
    )


METHOD_HANDLERS["kanban.createBoard"] = handle_kanban_create_board


async def handle_kanban_set_board(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    slug = (p.get("slug") or "").strip()
    if not slug:
        raise RpcError("INVALID_REQUEST", "slug required")
    return await asyncio.to_thread(kanban_handler.set_board, slug)


METHOD_HANDLERS["kanban.setBoard"] = handle_kanban_set_board


async def handle_kanban_remove_board(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    slug = (p.get("slug") or "").strip()
    if not slug:
        raise RpcError("INVALID_REQUEST", "slug required")
    return await asyncio.to_thread(kanban_handler.remove_board, slug)


METHOD_HANDLERS["kanban.removeBoard"] = handle_kanban_remove_board


async def handle_kanban_worker_log(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(
        kanban_handler.worker_log, p.get("board"), _kanban_task_id(p)
    )


METHOD_HANDLERS["kanban.workerLog"] = handle_kanban_worker_log


async def handle_kanban_link(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    parent = p.get("parentId")
    child = p.get("childId")
    if not parent or not child:
        raise RpcError("INVALID_REQUEST", "parentId and childId required")
    return await asyncio.to_thread(kanban_handler.link_task, p.get("board"), str(parent), str(child))


METHOD_HANDLERS["kanban.linkTask"] = handle_kanban_link


async def handle_kanban_unlink(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    parent = p.get("parentId")
    child = p.get("childId")
    if not parent or not child:
        raise RpcError("INVALID_REQUEST", "parentId and childId required")
    return await asyncio.to_thread(kanban_handler.unlink_task, p.get("board"), str(parent), str(child))


METHOD_HANDLERS["kanban.unlinkTask"] = handle_kanban_unlink


async def handle_kanban_notify_add(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    platform = p.get("platform")
    chat_id = p.get("chatId")
    if not platform or not chat_id:
        raise RpcError("INVALID_REQUEST", "platform and chatId required")
    return await asyncio.to_thread(
        kanban_handler.notify_add, p.get("board"), _kanban_task_id(p), str(platform), str(chat_id), p.get("threadId")
    )


METHOD_HANDLERS["kanban.notifyAdd"] = handle_kanban_notify_add


async def handle_kanban_notify_remove(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    platform = p.get("platform")
    chat_id = p.get("chatId")
    if not platform or not chat_id:
        raise RpcError("INVALID_REQUEST", "platform and chatId required")
    return await asyncio.to_thread(
        kanban_handler.notify_remove, p.get("board"), _kanban_task_id(p), str(platform), str(chat_id), p.get("threadId")
    )


METHOD_HANDLERS["kanban.notifyRemove"] = handle_kanban_notify_remove


_KANBAN_ORCH_KEYS = (
    "dispatch_in_gateway",
    "orchestrator_profile",
    "default_assignee",
    "auto_decompose",
    "auto_decompose_per_tick",
)


async def handle_kanban_orchestration(params: dict, ctx: DispatchContext) -> dict:
    cfg = {}
    try:
        raw = await ctx.config.get("kanban")
        if isinstance(raw, dict):
            cfg = {k: raw.get(k) for k in _KANBAN_ORCH_KEYS}
    except Exception:  # noqa: BLE001
        pass
    profiles = await asyncio.to_thread(kanban_handler.list_profiles_meta)
    return {"config": cfg, "profiles": profiles.get("profiles", [])}


METHOD_HANDLERS["kanban.orchestration"] = handle_kanban_orchestration


async def handle_kanban_set_orchestration(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    patch = {}
    for k in _KANBAN_ORCH_KEYS:
        if k in p:
            patch[k] = p[k]
    if not patch:
        raise RpcError("INVALID_REQUEST", "no orchestration keys provided")
    try:
        await ctx.config.patch({"kanban": patch})
        return {"ok": True, "applied": patch}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


METHOD_HANDLERS["kanban.setOrchestration"] = handle_kanban_set_orchestration


async def handle_kanban_set_profile_desc(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    name = (p.get("name") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "name required")
    return await asyncio.to_thread(
        kanban_handler.set_profile_description, name, p.get("description") or ""
    )


METHOD_HANDLERS["kanban.setProfileDescription"] = handle_kanban_set_profile_desc


async def handle_kanban_auto_describe(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    name = (p.get("name") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "name required")
    return await asyncio.to_thread(kanban_handler.auto_describe_profile, name)


METHOD_HANDLERS["kanban.autoDescribeProfile"] = handle_kanban_auto_describe


async def handle_kanban_nudge(params: dict, ctx: DispatchContext) -> dict:
    p = params if isinstance(params, dict) else {}
    return await asyncio.to_thread(kanban_handler.nudge_dispatcher, p.get("board"))


METHOD_HANDLERS["kanban.nudge"] = handle_kanban_nudge


# -----------------------------------------------------------------
# Skills — direct forward to Hermes
# -----------------------------------------------------------------


async def handle_skills_install(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "skills.install params must be a dict")
    hermes_params = dict(params)
    hermes_params["action"] = "install"
    try:
        result = await ctx.hermes.call("skills.manage", hermes_params, timeout=300.0)
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    return result if isinstance(result, dict) else {"raw": result}


METHOD_HANDLERS["skills.install"] = handle_skills_install


async def handle_skills_uninstall(params: dict, ctx: DispatchContext) -> dict:
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "skills.uninstall params must be a dict")
    hermes_params = dict(params)
    hermes_params["action"] = "remove"
    try:
        result = await ctx.hermes.call("skills.manage", hermes_params, timeout=120.0)
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    return result if isinstance(result, dict) else {"raw": result}


METHOD_HANDLERS["skills.uninstall"] = handle_skills_uninstall


async def handle_skills_delete_agent_created(params: dict, ctx: DispatchContext) -> dict:
    """skills.deleteAgentCreated — hard-delete an AGENT-AUTHORED skill.

    Safety: refuses to delete anything that isn't agent-created (bundled /
    hub-installed skills are protected). Removes the skill directory from
    ~/.hermes/skills/<dir> and forgets its usage record. Engine re-scans on the
    next config reload, so it drops out of skills.status immediately.
    """
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "params must be a dict")
    name = str(params.get("name") or params.get("skillKey") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "name required")
    # Guard: only AGENT-AUTHORED skills (not in the builtin baseline) may be
    # deleted — bundled/seeded skills are protected. Use the same baseline file
    # skills_extras uses so the guard agrees with what the UI shows.
    import os as _os
    import json as _json
    from pathlib import Path as _Path
    home = _os.environ.get("HERMES_HOME") or _os.path.expanduser("~/.hermes")
    baseline_path = _Path(home) / "skills" / ".agentbuff_builtin_baseline.json"
    try:
        baseline = set(_json.loads(baseline_path.read_text(encoding="utf-8")))
    except Exception:
        baseline = set()
    if name in baseline:
        raise RpcError(
            "FORBIDDEN",
            "skill bawaan dilindungi — cuma skill buatan agen yang bisa dihapus",
        )
    try:
        from tools.skill_usage import _find_skill_dir, forget
    except Exception as exc:
        raise RpcError("ENGINE_DOWN", f"skill_usage unavailable: {exc}")
    removed_dir = False
    try:
        skill_dir = _find_skill_dir(name)
    except Exception:
        skill_dir = None
    if skill_dir is not None:
        try:
            import shutil
            from pathlib import Path as _Path
            p = _Path(skill_dir)
            if p.exists() and p.is_dir():
                shutil.rmtree(p)
                removed_dir = True
        except Exception as exc:
            raise RpcError("IO_ERROR", f"gagal hapus folder skill: {exc}")
    try:
        forget(name)
    except Exception as exc:
        log.warning("forget usage record for %r failed: %s", name, exc)
    return {"ok": True, "name": name, "removedDir": removed_dir}


METHOD_HANDLERS["skills.deleteAgentCreated"] = handle_skills_delete_agent_created


async def handle_skills_status(params: dict, ctx: DispatchContext) -> dict:
    """skills.status — rich per-skill entry matching UI's SkillStatusReport.

    Reads agent profile.yaml::skills (when agentId given) to enrich each
    entry with `blockedByAllowlist`.
    """
    agent_id = (params or {}).get("agentId") or (params or {}).get("id")
    from skills_extras import build_skills_status
    return await build_skills_status(ctx.hermes, ctx.agents, agent_id=agent_id)


METHOD_HANDLERS["skills.status"] = handle_skills_status


# -----------------------------------------------------------------
# Cron — forward with action discriminator
# -----------------------------------------------------------------


async def handle_cron_list(params: dict, ctx: DispatchContext) -> dict:
    return await _do_cron_list(ctx)


async def _do_cron_list(ctx: DispatchContext) -> dict:
    """cron.list — forward Hermes' cron.manage list + transform raw shape
    into the rich UI-expected shape (CronJob with nested state object,
    payload object, delivery object, ms-epoch timestamps, dedupe by id).

    Without transform the UI crashes:
      - humanizePayload(job.payload) → TypeError because job has `prompt`
        not `payload`
      - job.state.runningAtMs → TypeError because state is string "scheduled"
        not an object
    """
    try:
        result = await ctx.hermes.call("cron.manage", {"action": "list"})
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    if not isinstance(result, dict):
        result = {"jobs": result if isinstance(result, list) else []}
    raw_jobs = result.get("jobs") if isinstance(result.get("jobs"), list) else []
    # The engine's cron.manage list strips agent_id (via _format_job), so the
    # per-agent binding only survives in jobs.json — re-attach it here so the
    # Rutinitas per-agent filter actually works.
    agent_map = _cron_agent_map()
    raw_map = _cron_raw_map()
    transformed: list[dict] = []
    seen_ids: set[str] = set()
    for raw in raw_jobs:
        if not isinstance(raw, dict):
            continue
        job = _transform_cron_job(raw)
        if not job.get("agentId") and agent_map.get(job.get("name")):
            job["agentId"] = agent_map[job["name"]]
        _reattach_cron_fields(job, raw_map.get(job.get("name")))
        jid = job.get("id")
        # Dedupe by id — Hermes occasionally emits the same job twice during
        # reload windows (in-memory scheduler + jobs.json on-disk both flush).
        if isinstance(jid, str) and jid:
            if jid in seen_ids:
                continue
            seen_ids.add(jid)
        transformed.append(job)

    # Merge in jobs that exist in jobs.json but aren't (yet) in the in-memory
    # scheduler list — covers the window right after an add+augment before the
    # scheduler reloads, so a freshly-created routine never vanishes from the UI.
    seen_names = {j.get("name") for j in transformed}
    for nm, raw_file in raw_map.items():
        if nm in seen_names:
            continue
        job = _transform_cron_job(raw_file)
        if not job.get("agentId") and agent_map.get(nm):
            job["agentId"] = agent_map[nm]
        _reattach_cron_fields(job, raw_file)
        transformed.append(job)

    return {
        "jobs": transformed,
        "total": len(transformed),
        "hasMore": False,
    }


METHOD_HANDLERS["cron.list"] = handle_cron_list


# Hermes raw cron job shape → UI's rich CronJob shape (helpers.ts:110-127).
def _transform_cron_job(raw: dict) -> dict:
    """Map Hermes' jobs.json record to the rich UI CronJob.

    Hermes raw fields (per jobs.json + tools/cronjob_tools.py):
      id, name, prompt, skill, model, provider, base_url, script, no_agent,
      context_from, schedule {kind, expr, display}, schedule_display,
      repeat {times, completed}, enabled, state (string),
      paused_at, paused_reason, created_at (ISO), next_run_at (ISO),
      last_run_at (ISO|null), last_status, last_error, last_delivery_error,
      deliver, origin, enabled_toolsets, workdir
    """
    # Hermes' cron.manage action=list serializes schedule as a STRING
    # (the cron expression), while raw jobs.json stores it as a dict.
    # Handle both shapes.
    sched_raw = raw.get("schedule")
    if isinstance(sched_raw, str):
        schedule = _parse_schedule_string(sched_raw)
    elif isinstance(sched_raw, dict):
        schedule = {"kind": str(sched_raw.get("kind") or "cron")}
        sk = schedule["kind"]
        if sk == "cron":
            schedule["expr"] = str(sched_raw.get("expr") or sched_raw.get("display") or "")
            if sched_raw.get("tz"):
                schedule["tz"] = str(sched_raw["tz"])
        elif sk == "at":
            schedule["at"] = str(sched_raw.get("at") or sched_raw.get("display") or "")
        elif sk == "every":
            every = sched_raw.get("everyMs") or sched_raw.get("every_ms") or 0
            schedule["everyMs"] = int(every) if isinstance(every, (int, float)) else 0
            if sched_raw.get("anchorMs") or sched_raw.get("anchor_ms"):
                schedule["anchorMs"] = int(sched_raw.get("anchorMs") or sched_raw.get("anchor_ms"))
    else:
        schedule = {"kind": "cron", "expr": ""}

    # state — Hermes encodes as STRING (scheduled/paused/running). Re-pack
    # into the object the UI expects, with timestamps in milliseconds.
    state_str = str(raw.get("state") or "").lower()
    state_obj: dict = {
        "nextRunAtMs": _iso_to_ms(raw.get("next_run_at")),
        "lastRunAtMs": _iso_to_ms(raw.get("last_run_at")),
    }
    if state_str == "running":
        # Hermes doesn't always expose started-at timestamp; use last known
        # next_run as a proxy when present so UI can show running indicator.
        state_obj["runningAtMs"] = _iso_to_ms(raw.get("started_at")) or _iso_to_ms(raw.get("next_run_at")) or int(_time.time() * 1000)
    if raw.get("last_status"):
        state_obj["lastRunStatus"] = str(raw["last_status"]).lower()
    if raw.get("last_error"):
        state_obj["lastError"] = str(raw["last_error"])
    if raw.get("last_delivery_error"):
        state_obj["lastDeliveryError"] = str(raw["last_delivery_error"])
    consec = raw.get("consecutive_errors")
    if isinstance(consec, (int, float)):
        state_obj["consecutiveErrors"] = int(consec)
    last_duration = raw.get("last_duration_ms")
    if isinstance(last_duration, (int, float)):
        state_obj["lastDurationMs"] = int(last_duration)

    # payload — Hermes flat fields → CronPayload object. cron.manage list
    # serializes prompt as `prompt_preview` (truncated); jobs.json uses
    # `prompt` (full). Accept either.
    prompt_text = raw.get("prompt") or raw.get("prompt_preview")
    payload: dict
    if prompt_text:
        payload = {"kind": "agentTurn", "message": str(prompt_text)}
        if raw.get("model"):
            payload["model"] = str(raw["model"])
        if isinstance(raw.get("fallbacks"), list):
            payload["fallbacks"] = [str(x) for x in raw["fallbacks"] if x]
        if raw.get("thinking"):
            payload["thinking"] = str(raw["thinking"])
        if isinstance(raw.get("timeout_seconds"), (int, float)):
            payload["timeoutSeconds"] = int(raw["timeout_seconds"])
    else:
        # Hermes "no_agent" jobs emit system events (no LLM turn)
        payload = {"kind": "systemEvent", "text": str(raw.get("script") or "")}

    # delivery — Hermes `deliver` is a string (local/announce/webhook).
    deliver = raw.get("deliver")
    delivery: dict | None = None
    if deliver:
        mode = str(deliver).lower()
        if mode == "local":
            mode = "none"
        if mode not in {"none", "announce", "webhook"}:
            mode = "none"
        delivery = {"mode": mode}
        if raw.get("channel"):
            delivery["channel"] = str(raw["channel"])
        if raw.get("to"):
            delivery["to"] = str(raw["to"])

    # Session target — Hermes uses `context_from` ("main"/"current"/etc.)
    session_target = str(raw.get("context_from") or raw.get("session_target") or "main")

    # cron.manage list uses `job_id`; jobs.json uses `id`. Accept either.
    job_id = str(raw.get("job_id") or raw.get("id") or "")
    job: dict = {
        "id": job_id,
        "name": str(raw.get("name") or "(no name)"),
        "enabled": bool(raw.get("enabled", True)),
        "createdAtMs": _iso_to_ms(raw.get("created_at")) or 0,
        "updatedAtMs": _iso_to_ms(raw.get("updated_at")) or _iso_to_ms(raw.get("created_at")) or 0,
        "schedule": schedule,
        "sessionTarget": session_target,
        "wakeMode": str(raw.get("wake_mode") or "now"),
        "payload": payload,
        "state": state_obj,
    }
    if delivery is not None:
        job["delivery"] = delivery
    if raw.get("description"):
        job["description"] = str(raw["description"])
    if raw.get("agent_id") or raw.get("agentId"):
        job["agentId"] = str(raw.get("agent_id") or raw.get("agentId"))
    if raw.get("session_key") or raw.get("sessionKey"):
        job["sessionKey"] = str(raw.get("session_key") or raw.get("sessionKey"))
    if raw.get("delete_after_run") or raw.get("deleteAfterRun"):
        job["deleteAfterRun"] = bool(raw.get("delete_after_run") or raw.get("deleteAfterRun"))
    # Surface the engine-honored advanced fields so the UI can show + edit them.
    if raw.get("model"):
        job["model"] = str(raw["model"])
    if raw.get("provider"):
        job["provider"] = str(raw["provider"])
    if raw.get("base_url") or raw.get("baseUrl"):
        job["baseUrl"] = str(raw.get("base_url") or raw.get("baseUrl"))
    sk = raw.get("skills")
    if isinstance(sk, list) and sk:
        job["skills"] = [str(s) for s in sk]
    elif raw.get("skill"):
        job["skills"] = [str(raw["skill"])]
    ts = raw.get("enabled_toolsets") or raw.get("enabledToolsets")
    if isinstance(ts, list) and ts:
        job["enabledToolsets"] = [str(s) for s in ts]
    rep = raw.get("repeat")
    if isinstance(rep, int) and rep > 0:
        job["repeat"] = rep
    cf = raw.get("context_from") or raw.get("contextFrom")
    if cf:
        job["contextFrom"] = cf if isinstance(cf, list) else str(cf)
    return job


def _parse_schedule_string(s: str) -> dict:
    """Hermes' cron.manage list serializes schedule as a plain string.

    Forms seen:
      - "0 0 1 1 *"           → cron expression (5-field)
      - "every 1h" / "every 30m" → interval
      - "at 2026-12-25T09:00" → one-shot ISO timestamp
      - "*/15 * * * *"        → cron expression
    """
    s = (s or "").strip()
    if not s:
        return {"kind": "cron", "expr": ""}
    lower = s.lower()
    if lower.startswith("every "):
        rest = s.split(" ", 1)[1].strip()
        ms = _parse_duration_to_ms(rest)
        if ms is not None:
            return {"kind": "every", "everyMs": ms}
        # Fall through — treat as cron
    if lower.startswith("at "):
        rest = s.split(" ", 1)[1].strip()
        return {"kind": "at", "at": rest}
    # Default: treat as cron expression
    return {"kind": "cron", "expr": s}


def _parse_duration_to_ms(s: str) -> int | None:
    """Parse '1h' / '30m' / '2h30m' / '45s' → milliseconds."""
    import re as _re
    s = (s or "").strip().lower()
    if not s:
        return None
    total_ms = 0
    pattern = _re.compile(r"(\d+)\s*(d|h|m|s)")
    matches = pattern.findall(s)
    if not matches:
        # bare number → assume seconds
        try:
            return int(float(s) * 1000)
        except ValueError:
            return None
    units = {"d": 86_400_000, "h": 3_600_000, "m": 60_000, "s": 1_000}
    for num, unit in matches:
        total_ms += int(num) * units[unit]
    return total_ms if total_ms > 0 else None


def _iso_to_ms(value) -> int | None:
    """Convert an ISO-8601 timestamp string → epoch milliseconds. None safe."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        # Heuristic: > 1e12 already ms, else seconds
        return int(v if v > 1e12 else v * 1000)
    if not isinstance(value, str) or not value.strip():
        return None
    from datetime import datetime, timezone as _tz
    try:
        # Hermes writes "2027-01-01T00:00:00+00:00" — fromisoformat handles
        # ISO with offset on 3.11+.
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


# ── Cron CRUD — maps the UI's add/remove/update/run/runs onto Hermes' REAL
#    cron.manage surface (list|add|remove|pause|resume ONLY) + jobs.json
#    augmentation for fields the engine add RPC drops (agentId/model/...).
#    The engine has NO create/delete/run/update/runs actions — the old handlers
#    sent action="create"/"delete" which the engine rejected, so every Rutinitas
#    button was dead. Fixed 2026-05-30 (P0#3). jobs.json shape: {"jobs":[...]}
#    (cron/jobs.py save_jobs); metadata.agent_id survives engine saves.

def _cron_jobs_path() -> str:
    import os
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "cron", "jobs.json")


def _cron_slug(text: str) -> str:
    import re as _re_slug
    base = _re_slug.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return base[:32] or "routine"


def _read_cron_file() -> Optional[dict]:
    import json
    try:
        with open(_cron_jobs_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        return {"jobs": data if isinstance(data, list) else []}
    except FileNotFoundError:
        return None
    except Exception:
        log.exception("cron: jobs.json read failed")
        return None


def _write_cron_file(data: dict) -> bool:
    import json
    import os
    try:
        path = _cron_jobs_path()
        tmp = path + ".bridge.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except Exception:
        log.exception("cron: jobs.json write failed")
        return False


def _augment_cron_job(name: str, fields: dict) -> bool:
    """Merge fields onto a job in jobs.json that the engine add RPC can't set
    (metadata.agent_id, model, context_from, deliver, schedule, prompt)."""
    data = _read_cron_file()
    if not data:
        return False
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        return False
    target = next(
        (j for j in jobs if isinstance(j, dict) and j.get("name") == name), None
    )
    if target is None:
        return False
    agent_id = fields.get("agentId") or fields.get("agent_id")
    if agent_id:
        meta = target.get("metadata")
        if not isinstance(meta, dict):
            meta = {}
            target["metadata"] = meta
        meta["agent_id"] = str(agent_id)
        target["agent_id"] = str(agent_id)
    for src, dst in (
        ("model", "model"),
        ("provider", "provider"),
        ("baseUrl", "base_url"),
        ("sessionTarget", "context_from"),
        ("session_target", "context_from"),
        ("contextFrom", "context_from"),
        ("deliver", "deliver"),
        ("schedule", "schedule"),
        ("prompt", "prompt"),
        # Engine-honored fields (cron/jobs.py create signature) written straight
        # into jobs.json so the scheduler picks them up on reload:
        #   skills            → only these skills are loaded before the run
        #   enabled_toolsets  → restrict the agent to these toolsets (token saving)
        #   repeat            → run N times then auto-remove (None/0 = forever)
        ("skills", "skills"),
        ("enabledToolsets", "enabled_toolsets"),
        ("enabled_toolsets", "enabled_toolsets"),
        ("repeat", "repeat"),
    ):
        if src in fields and fields[src] is not None:
            val = fields[src]
            # Drop empty lists/strings so we don't pin an empty restriction.
            if isinstance(val, (list, str)) and len(val) == 0:
                continue
            if dst == "repeat":
                # Engine stores repeat as {times, completed}; accept a plain int.
                if isinstance(val, dict):
                    target["repeat"] = val
                else:
                    try:
                        n = int(val)
                        target["repeat"] = {"times": n if n > 0 else None, "completed": 0}
                    except (TypeError, ValueError):
                        pass
                continue
            target[dst] = val
    return _write_cron_file(data)


def _remove_cron_job_from_file(name: str) -> bool:
    """Authoritative removal directly from jobs.json (defense-in-depth if a
    concurrent scheduler save resurrected an entry after cron.manage remove)."""
    data = _read_cron_file()
    if not data:
        return False
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        return False
    kept = [j for j in jobs if not (isinstance(j, dict) and j.get("name") == name)]
    if len(kept) == len(jobs):
        return False
    data["jobs"] = kept
    return _write_cron_file(data)


async def _cron_reschedule(ctx: "DispatchContext", name: str, enabled: bool) -> None:
    """Force the running scheduler to re-read jobs.json after a file augment so
    model/schedule edits take effect at the next fire. Best-effort."""
    try:
        action = "resume" if enabled else "pause"
        await ctx.hermes.call("cron.manage", {"action": action, "name": name})
    except Exception:
        log.debug("cron: reschedule (%s) best-effort failed", name, exc_info=True)


def _cron_agent_map() -> dict:
    """Read {job_name: agent_id} from jobs.json. The engine's cron.manage list
    runs jobs through _format_job which STRIPS agent_id/metadata, so the only
    place per-agent binding survives is the raw file. Used to re-attach agentId
    onto list/find results (drives the Rutinitas per-agent filter + cron.run)."""
    data = _read_cron_file()
    out: dict = {}
    if not data:
        return out
    for j in data.get("jobs") or []:
        if not isinstance(j, dict):
            continue
        nm = j.get("name")
        if not nm:
            continue
        meta = j.get("metadata") if isinstance(j.get("metadata"), dict) else {}
        aid = meta.get("agent_id") or j.get("agent_id") or j.get("agentId")
        if aid:
            out[nm] = str(aid)
    return out


def _cron_raw_map() -> dict:
    """Read {job_name: raw_job} from jobs.json. The engine's cron.manage list
    strips the advanced fields (skills/enabled_toolsets/model/provider/repeat/
    context_from) via _format_job, so they only survive in the raw file. Used to
    re-attach them onto list/find results so the UI can display + edit them."""
    data = _read_cron_file()
    out: dict = {}
    if not data:
        return out
    for j in data.get("jobs") or []:
        if isinstance(j, dict) and j.get("name"):
            out[str(j["name"])] = j
    return out


def _reattach_cron_fields(job: dict, raw_file: Optional[dict]) -> None:
    """Merge the engine-honored advanced fields from the raw jobs.json entry onto
    a transformed cron job (in place). No-op when the raw entry is missing."""
    if not isinstance(raw_file, dict):
        return
    if not job.get("model") and raw_file.get("model"):
        job["model"] = str(raw_file["model"])
    if not job.get("provider") and raw_file.get("provider"):
        job["provider"] = str(raw_file["provider"])
    if not job.get("baseUrl") and (raw_file.get("base_url") or raw_file.get("baseUrl")):
        job["baseUrl"] = str(raw_file.get("base_url") or raw_file.get("baseUrl"))
    if not job.get("skills"):
        sk = raw_file.get("skills")
        if isinstance(sk, list) and sk:
            job["skills"] = [str(s) for s in sk]
        elif raw_file.get("skill"):
            job["skills"] = [str(raw_file["skill"])]
    if not job.get("enabledToolsets"):
        ts = raw_file.get("enabled_toolsets") or raw_file.get("enabledToolsets")
        if isinstance(ts, list) and ts:
            job["enabledToolsets"] = [str(s) for s in ts]
    if not job.get("repeat"):
        rep = raw_file.get("repeat")
        if isinstance(rep, dict):
            t = rep.get("times")
            if isinstance(t, int) and t > 0:
                job["repeat"] = t
        elif isinstance(rep, int) and rep > 0:
            job["repeat"] = rep
    if not job.get("contextFrom"):
        cf = raw_file.get("context_from") or raw_file.get("contextFrom")
        if cf:
            job["contextFrom"] = cf if isinstance(cf, list) else str(cf)


async def _cron_find(ctx: "DispatchContext", name: str) -> Optional[dict]:
    try:
        result = await ctx.hermes.call("cron.manage", {"action": "list"})
        agent_map = _cron_agent_map()
        raw_map = _cron_raw_map()
        for j in (result.get("jobs") or []) if isinstance(result, dict) else []:
            if isinstance(j, dict) and (j.get("name") == name or j.get("id") == name):
                job = _transform_cron_job(j)
                if not job.get("agentId") and agent_map.get(job.get("name")):
                    job["agentId"] = agent_map[job["name"]]
                _reattach_cron_fields(job, raw_map.get(job.get("name")))
                return job
    except Exception:
        log.debug("cron: find %s failed", name, exc_info=True)
    return None


def _cron_schedule_to_str(schedule: Any) -> str:
    """Normalize the UI's schedule (string OR {kind,expr/at/everyMs}) into the
    engine's accepted string form. cron-create-wizard sends an object; the flat
    caller sends a string."""
    if isinstance(schedule, str):
        return schedule.strip()
    if not isinstance(schedule, dict):
        return ""
    kind = str(schedule.get("kind") or "cron").lower()
    if kind == "cron":
        return str(schedule.get("expr") or schedule.get("display") or "").strip()
    if kind == "at":
        at = str(schedule.get("at") or schedule.get("display") or "").strip()
        return at if at.lower().startswith("at ") else (f"at {at}" if at else "")
    if kind == "every":
        ms = schedule.get("everyMs") or schedule.get("every_ms") or 0
        try:
            ms = int(ms)
        except (TypeError, ValueError):
            ms = 0
        if ms <= 0:
            return ""
        for unit_ms, suffix in ((86_400_000, "d"), (3_600_000, "h"), (60_000, "m"), (1000, "s")):
            if ms % unit_ms == 0:
                return f"every {ms // unit_ms}{suffix}"
        return f"every {max(1, ms // 60_000)}m"
    return ""


def _cron_delivery_to_str(delivery: Any) -> Optional[str]:
    """Encode the UI's CronDelivery object into the engine's `deliver` string.

    Engine accepts: "local" | "origin" | "<platform>" | "<platform>:<target>"
    (cron/scheduler.py::_resolve_single_delivery_target).
      - mode "none"     -> "local"  (run, do not announce)
      - mode "announce" -> channel "last"/"current"/"origin"/"" -> "origin";
                           real platform + recipient -> "<platform>:<target>";
                           real platform alone       -> "<platform>" (home chan)
      - mode "webhook"  -> None. The engine has no generic webhook cron sender
                           (no Platform.WEBHOOK; _send_via_adapter has no webhook
                           adapter), so a webhook deliver would silently fail at
                           fire time. The /app wizard no longer offers webhook;
                           legacy jobs fall back to local (no announce) here.

    NOTE: accountId is intentionally not encoded — engine cron delivery routes
    via a platform's single home channel, not per-account, so there is no faithful
    way to honor it. Dropping it is correct rather than pretending it works.
    """
    if not isinstance(delivery, dict):
        return None
    mode = str(delivery.get("mode") or "").strip().lower()
    if mode == "none":
        return "local"
    if mode == "webhook":
        return None
    if mode == "announce":
        channel = str(delivery.get("channel") or "").strip()
        to = str(delivery.get("to") or "").strip()
        if not channel or channel.lower() in ("last", "current", "origin"):
            return "origin"
        if to:
            return f"{channel}:{to}"
        return channel
    return None


def _normalize_cron_create(params: dict) -> dict:
    """Flatten the cron-create-wizard's rich CronJobCreate into the flat fields
    handle_cron_add works with. Accepts both the rich (schedule object + nested
    payload/delivery) and flat shapes."""
    out: dict = dict(params)
    out["schedule"] = _cron_schedule_to_str(params.get("schedule"))
    payload = params.get("payload")
    if isinstance(payload, dict):
        if not out.get("prompt") and payload.get("message"):
            out["prompt"] = payload.get("message")
        if not out.get("model") and payload.get("model"):
            out["model"] = payload.get("model")
    if not out.get("deliver"):
        deliver = _cron_delivery_to_str(params.get("delivery"))
        if deliver:
            out["deliver"] = deliver
    return out


async def handle_cron_add(params: dict, ctx: DispatchContext) -> dict:
    """cron.add — create a routine. Engine add takes name/schedule/prompt only;
    agentId/model/etc are augmented into jobs.json afterwards. Accepts both the
    flat shape and the cron-create-wizard's rich CronJobCreate."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.add params must be a dict")
    params = _normalize_cron_create(params)
    schedule = str(params.get("schedule") or "").strip()
    prompt = str(params.get("prompt") or "").strip()
    if not schedule or not prompt:
        raise RpcError("INVALID_REQUEST", "schedule dan prompt wajib diisi")
    name = str(params.get("name") or "").strip()
    if not name:
        base = _cron_slug(prompt)
        existing: set = set()
        try:
            lst = await ctx.hermes.call("cron.manage", {"action": "list"})
            existing = {
                j.get("name") for j in (lst.get("jobs") or []) if isinstance(j, dict)
            }
        except Exception:
            pass
        name = base
        i = 2
        while name in existing:
            name = f"{base}-{i}"
            i += 1
    # The engine's cron.manage `add` only honors name/schedule/prompt — it does
    # NOT forward the advanced create() params (skills/enabled_toolsets/model/
    # repeat/...). So we add the basic job, then write the advanced fields into
    # jobs.json directly; the scheduler reads them on reload + at fire time.
    try:
        await ctx.hermes.call(
            "cron.manage",
            {"action": "add", "name": name, "schedule": schedule, "prompt": prompt},
        )
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))

    extra = {
        k: params.get(k)
        for k in (
            "agentId", "model", "provider", "baseUrl", "sessionTarget",
            "contextFrom", "deliver", "skills", "enabledToolsets",
            "enabled_toolsets", "repeat",
        )
        if params.get(k) is not None
    }
    if extra:
        _augment_cron_job(name, extra)

    job = await _cron_find(ctx, name)
    # Return the job at the TOP LEVEL (not wrapped in {ok, job}). The create
    # wizard reads res.data.id / res.data.name for its success toast — under the
    # old wrapper those were undefined ('Rutinitas "undefined" dibuat'). The
    # client call() already conveys ok via its own envelope. (Audit C3.)
    return job or {"id": name, "name": name}


METHOD_HANDLERS["cron.add"] = handle_cron_add
METHOD_HANDLERS["cron.create"] = handle_cron_add  # back-compat alias


async def handle_cron_remove(params: dict, ctx: DispatchContext) -> dict:
    """cron.remove — delete a routine. UI sends {id}; engine keys by name."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.remove params must be a dict")
    name = str(params.get("id") or params.get("name") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "id routine wajib diisi")
    try:
        await ctx.hermes.call("cron.manage", {"action": "remove", "name": name})
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    except HermesProcessError as e:
        raise RpcError("ENGINE_DOWN", str(e))
    if await _cron_find(ctx, name):
        _remove_cron_job_from_file(name)
    return {"ok": True, "removed": name}


METHOD_HANDLERS["cron.remove"] = handle_cron_remove
METHOD_HANDLERS["cron.delete"] = handle_cron_remove  # back-compat alias


async def handle_cron_update(params: dict, ctx: DispatchContext) -> dict:
    """cron.update — {id, patch}. enabled → engine pause/resume. schedule/prompt/
    model/agentId → jobs.json edit + reschedule (engine has no in-place edit)."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.update params must be a dict")
    name = str(params.get("id") or params.get("name") or "").strip()
    patch = params.get("patch")
    if not name or not isinstance(patch, dict):
        raise RpcError("INVALID_REQUEST", "cron.update butuh id + patch")

    current = await _cron_find(ctx, name)
    enabled = bool(current.get("enabled", True)) if current else True

    if "enabled" in patch and isinstance(patch["enabled"], bool):
        enabled = patch["enabled"]
        try:
            await ctx.hermes.call(
                "cron.manage",
                {"action": "resume" if enabled else "pause", "name": name},
            )
        except HermesRpcError as e:
            raise RpcError(_map_hermes_code(e.code), e.message)

    # schedule may arrive as the rich object form — normalize before storing.
    edit_fields: dict = {}
    for k in (
        "prompt", "model", "provider", "baseUrl", "agentId", "deliver",
        "sessionTarget", "contextFrom", "skills", "enabledToolsets",
        "enabled_toolsets", "repeat",
    ):
        if k in patch and patch[k] is not None:
            edit_fields[k] = patch[k]
    # Edit drawer sends the task text inside payload.message — flatten it.
    payload = patch.get("payload")
    if isinstance(payload, dict) and payload.get("message") and "prompt" not in edit_fields:
        edit_fields["prompt"] = payload["message"]
    # Edit drawer sends delivery as the rich CronDelivery object — encode it to
    # the engine's `deliver` string (same path as create). Without this an edited
    # announce target was silently dropped (only a raw `deliver` key was honored).
    if "deliver" not in edit_fields:
        deliver = _cron_delivery_to_str(patch.get("delivery"))
        if deliver:
            edit_fields["deliver"] = deliver
    if patch.get("schedule") is not None:
        sched = _cron_schedule_to_str(patch["schedule"])
        if sched:
            edit_fields["schedule"] = sched
    if edit_fields:
        if not _augment_cron_job(name, edit_fields):
            raise RpcError("NOT_FOUND", f"routine {name!r} tidak ditemukan")
        await _cron_reschedule(ctx, name, enabled=enabled)

    job = await _cron_find(ctx, name)
    return {"ok": True, "job": job or {"id": name, "name": name}}


METHOD_HANDLERS["cron.update"] = handle_cron_update


async def handle_cron_run(params: dict, ctx: DispatchContext) -> dict:
    """cron.run — run a routine NOW. The engine's CLI `cron run` only marks the
    job to fire on the next scheduler tick (it doesn't run immediately), so we
    run the routine's prompt through its bound agent in a fresh session (persona
    + model applied per P0#2). The agent's tools fire for real and the run is
    visible in /app chat. Scheduled fires still run headless via the engine."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.run params must be a dict")
    name = str(params.get("id") or params.get("name") or "").strip()
    if not name:
        raise RpcError("INVALID_REQUEST", "id routine wajib diisi")

    job = await _cron_find(ctx, name)
    if not job:
        raise RpcError("NOT_FOUND", f"routine {name!r} tidak ditemukan")
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
    prompt = str(payload.get("message") or "").strip()
    if not prompt:
        raise RpcError("INVALID_REQUEST", "routine ini tidak punya perintah untuk dijalankan")
    agent_id = (str(job.get("agentId") or "").strip()) or "default"
    model = str(payload.get("model") or "").strip()

    if ctx.energy is not None:
        try:
            await ctx.energy.check()
        except EnergyError as e:
            raise RpcError(e.code, e.message)

    try:
        created = await ctx.hermes.call("session.create", {})
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)
    sid = (created.get("session_id") or created.get("id")) if isinstance(created, dict) else None
    if not sid:
        raise RpcError("ENGINE_ERROR", "gagal membuat sesi untuk menjalankan routine")

    try:
        soul = await ctx.agents.get_soul_content(agent_id)
    except Exception:
        soul = ""
    try:
        await _apply_session_persona(
            ctx, sid, agent_id, {"model": {"primary": model}}, soul,
        )
    except Exception:
        log.debug("cron.run: persona apply best-effort failed", exc_info=True)

    try:
        await ctx.hermes.call(
            "prompt.submit", {"session_id": sid, "text": prompt}, timeout=300.0,
        )
    except HermesRpcError as e:
        raise RpcError(_map_hermes_code(e.code), e.message)

    return {
        "ok": True,
        "ran": True,
        "sessionKey": canonicalize_session_key(agent_id, sid),
        "agentId": agent_id,
    }


METHOD_HANDLERS["cron.run"] = handle_cron_run


def _cron_run_entry(job_name: str, st: dict):
    """Build a single run-history entry from a job's augmented state, or None."""
    last_ms = st.get("lastRunAtMs") if isinstance(st, dict) else None
    if not last_ms:
        return None
    status = str(st.get("lastRunStatus") or "unknown").lower()
    return {
        "id": f"{job_name}-last",
        "jobId": job_name,
        # `ts` is the field the runs strip + history drawer actually read; keep
        # startedAt too for back-compat. (Audit HIGH — stub wrote only startedAt.)
        "ts": int(last_ms),
        "startedAt": int(last_ms),
        "status": "ok" if status in ("ok", "success", "completed") else status,
        "durationMs": st.get("lastRunDurationMs") or st.get("lastDurationMs"),
        "summary": st.get("lastRunSummary"),
    }


async def handle_cron_runs(params: dict, ctx: DispatchContext) -> dict:
    """cron.runs — run history. Hermes keeps only last_run/last_status per job
    (no run log), so we surface that single most-recent run per job. With an id
    we return that job's last run; with no id (scope='all', the cross-job runs
    strip) we aggregate EVERY job's last run."""
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "cron.runs params must be a dict")
    name = str(params.get("id") or params.get("name") or "").strip()
    runs: list = []
    if name:
        job = await _cron_find(ctx, name)
        st = job.get("state") if isinstance(job, dict) and isinstance(job.get("state"), dict) else {}
        entry = _cron_run_entry(name, st)
        if entry:
            runs.append(entry)
    else:
        # scope='all' — aggregate every job's last run. The old code only
        # resolved a single named job, so an empty name → job=None → runs=[]
        # ALWAYS, leaving the cross-job runs strip permanently empty. (Audit HIGH.)
        try:
            lst = await ctx.hermes.call("cron.manage", {"action": "list"})
            raw_jobs = (lst.get("jobs") or []) if isinstance(lst, dict) else []
        except Exception:
            raw_jobs = []
        for rj in raw_jobs:
            if not isinstance(rj, dict):
                continue
            jn = str(rj.get("name") or "").strip()
            if not jn:
                continue
            aug = await _cron_find(ctx, jn)
            st = aug.get("state") if isinstance(aug, dict) and isinstance(aug.get("state"), dict) else {}
            entry = _cron_run_entry(jn, st)
            if entry:
                runs.append(entry)
        runs.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    return {"runs": runs, "entries": runs, "total": len(runs), "hasMore": False}


METHOD_HANDLERS["cron.runs"] = handle_cron_runs


# -----------------------------------------------------------------
# Health / identity — bridge-internal
# -----------------------------------------------------------------


async def handle_health(params: dict, ctx: DispatchContext) -> dict:
    return {
        "ok": True,
        "hermesAlive": ctx.hermes.is_alive,
    }


METHOD_HANDLERS["health"] = handle_health


async def handle_gateway_identity_get(params: dict, ctx: DispatchContext) -> dict:
    return {
        "name": "agentbuff-hermes-bridge",
        "version": "1.0.0",
        "engine": "hermes-agent",
        # Hermes version is set at container build; expose via env or read from package
        "engineVersion": None,
    }


METHOD_HANDLERS["gateway.identity.get"] = handle_gateway_identity_get


async def handle_agent_identity_get(params: dict, ctx: DispatchContext) -> dict:
    """Return identity of agent associated with current session_key."""
    session_key_raw = (params or {}).get("sessionKey") or "main"
    session_key = canonicalize_session_key(session_key_raw)
    try:
        profile = await ctx.agents.resolve_agent_for_session(session_key)
    except AgentsError as e:
        raise RpcError(e.code, e.message)
    return {
        "id": profile.get("id"),
        "name": profile.get("name"),
        "identity": profile.get("identity", {}),
    }


METHOD_HANDLERS["agent.identity.get"] = handle_agent_identity_get


# -----------------------------------------------------------------
# System / engine update RPC methods (new — auto-update support)
# -----------------------------------------------------------------


async def handle_system_engine_status(params: dict, ctx: DispatchContext) -> dict:
    updater = _UPDATER_REGISTRY.get("updater")
    if updater is None:
        raise RpcError("UNAVAILABLE", "engine updater is not initialized")
    try:
        return await updater.get_status()
    except Exception as e:
        raise RpcError("INTERNAL_ERROR", f"{type(e).__name__}: {e}")


METHOD_HANDLERS["system.engine.status"] = handle_system_engine_status


async def handle_system_engine_update(params: dict, ctx: DispatchContext) -> dict:
    """Trigger immediate Hermes update check + install if newer.

    Admin-only by convention — operator scope required (auth already enforces).
    """
    updater = _UPDATER_REGISTRY.get("updater")
    if updater is None:
        raise RpcError("UNAVAILABLE", "engine updater is not initialized")
    try:
        return await updater.trigger_update()
    except Exception as e:
        log.exception("system.engine.update failed")
        raise RpcError("UPDATE_FAILED", f"{type(e).__name__}: {e}")


METHOD_HANDLERS["system.engine.update"] = handle_system_engine_update


async def handle_system_engine_pin(params: dict, ctx: DispatchContext) -> dict:
    """Pin Hermes to a specific version (or clear pin with null)."""
    updater = _UPDATER_REGISTRY.get("updater")
    if updater is None:
        raise RpcError("UNAVAILABLE", "engine updater is not initialized")
    if not isinstance(params, dict):
        raise RpcError("INVALID_REQUEST", "system.engine.pin params must be a dict")
    version = params.get("version")  # None to clear
    try:
        return await updater.pin_version(version)
    except Exception as e:
        # HermesUpdaterError carries a code, but it's not imported here to avoid
        # circular dep. Map by attribute lookup.
        code = getattr(e, "code", None) or "INTERNAL_ERROR"
        message = getattr(e, "message", None) or str(e)
        raise RpcError(code, message)


METHOD_HANDLERS["system.engine.pin"] = handle_system_engine_pin


# -----------------------------------------------------------------
# System profiles enumeration RPC (multi-profile reform 2026-05-28)
# -----------------------------------------------------------------
#
# Each agent in AgentBuff maps 1:1 to a Hermes profile (own HERMES_HOME,
# config.yaml, .env, gateway PID). This RPC enumerates all profiles in
# the container so the portal can render a per-profile dashboard and
# spawn/stop/restart per-profile gateway subprocesses.
#
# Source of truth:
#   - "default" = ~/.hermes/ (root)
#   - named profiles = ~/.hermes/profiles/<name>/
#
# Reads ONLY local filesystem — does NOT shell out to `hermes profile list`
# (which would require subprocess; we already have direct dir access).
#
# Per-profile gateway status comes from gateway_runtime.GatewayPool if
# available (FASE 1 deliverable); for now we report best-effort from PID
# files on disk + process existence check.

import os as _os_for_profiles


def _scan_hermes_profiles() -> list[dict]:
    """Enumerate all Hermes profiles in the container.

    Returns list of dicts with shape:
        {
          "id": "default" | "<name>",
          "dir": "/home/hermes/.hermes" | "/home/hermes/.hermes/profiles/<name>",
          "is_default": bool,
          "identity": {name, emoji, theme} or None (from agentbuff.yaml),
          "model": "google/gemini-..." or None,
          "has_env": bool (channels credentials configured),
          "gateway": {
              "pid": int or None,
              "running": bool,
              "alive": bool (process actually exists in /proc),
          }
        }
    """
    from pathlib import Path as _Path
    import yaml as _yaml

    hermes_home_root = _Path(_os_for_profiles.environ.get("HERMES_HOME") or
                              _Path.home() / ".hermes")
    profiles_dir = hermes_home_root / "profiles"

    results: list[dict] = []

    def _read_profile_metadata(profile_dir: _Path, profile_id: str, is_default: bool) -> dict:
        out: dict = {
            "id": profile_id,
            "dir": str(profile_dir),
            "is_default": is_default,
            "identity": None,
            "model": None,
            "has_env": False,
            "gateway": {"pid": None, "running": False, "alive": False},
        }

        # Identity from agentbuff.yaml (named profiles) — root uses default agentbuff.yaml too
        ab_yaml = profile_dir / "agentbuff.yaml"
        if ab_yaml.is_file():
            try:
                data = _yaml.safe_load(ab_yaml.read_text(encoding="utf-8")) or {}
                ident = data.get("identity") if isinstance(data, dict) else None
                if isinstance(ident, dict):
                    out["identity"] = {
                        "name": ident.get("name") or data.get("name"),
                        "emoji": ident.get("emoji"),
                        "theme": ident.get("theme"),
                    }
                elif isinstance(data, dict) and data.get("name"):
                    out["identity"] = {"name": data["name"]}
            except Exception:
                log.warning("profile %s: agentbuff.yaml parse failed", profile_id)

        # Model from config.yaml — profile may override or inherit
        cfg_yaml = profile_dir / "config.yaml"
        if cfg_yaml.is_file():
            try:
                cfg = _yaml.safe_load(cfg_yaml.read_text(encoding="utf-8")) or {}
                if isinstance(cfg, dict):
                    model_blk = cfg.get("model")
                    if isinstance(model_blk, dict):
                        out["model"] = model_blk.get("primary") or model_blk.get("default")
            except Exception:
                log.warning("profile %s: config.yaml parse failed", profile_id)

        # .env presence (have channel credentials?)
        env_file = profile_dir / ".env"
        if env_file.is_file():
            try:
                content = env_file.read_text(encoding="utf-8", errors="ignore")
                # Strip empty + comment lines
                lines = [ln for ln in content.splitlines() if ln.strip() and not ln.strip().startswith("#")]
                out["has_env"] = len(lines) > 0
            except Exception:
                pass

        # Gateway PID from gateway.pid file. Hermes 0.14 writes JSON shape:
        #   {"pid": 27, "kind": "hermes-gateway", "argv": [...], "start_time": ...}
        # Older or alternate runtimes may write bare integer text. Handle both.
        pid_file = profile_dir / "gateway.pid"
        if pid_file.is_file():
            try:
                import json as _json
                pid_text = pid_file.read_text(encoding="utf-8").strip()
                pid: int | None = None
                if pid_text.startswith("{"):
                    parsed = _json.loads(pid_text)
                    if isinstance(parsed, dict):
                        candidate = parsed.get("pid")
                        if isinstance(candidate, int):
                            pid = candidate
                else:
                    first_line = pid_text.splitlines()[0] if pid_text else ""
                    if first_line.isdigit():
                        pid = int(first_line)
                if pid:
                    out["gateway"]["pid"] = pid
                    out["gateway"]["running"] = True
                    # Verify process actually exists in /proc — defends against
                    # stale pid file after crash without cleanup.
                    proc_dir = _Path("/proc") / str(pid)
                    out["gateway"]["alive"] = proc_dir.is_dir()
            except Exception:
                log.warning("profile %s: gateway.pid parse failed", profile_id)

        return out

    # Root = "default" profile
    if hermes_home_root.is_dir():
        results.append(_read_profile_metadata(hermes_home_root, "default", True))

    # Named profiles under ~/.hermes/profiles/
    if profiles_dir.is_dir():
        for profile_path in sorted(profiles_dir.iterdir()):
            if not profile_path.is_dir():
                continue
            if profile_path.name.startswith("."):
                continue
            results.append(_read_profile_metadata(profile_path, profile_path.name, False))

    return results


async def handle_system_profiles_list(params: dict, ctx: DispatchContext) -> dict:
    """List all Hermes profiles in the container.

    Returns the inventory the portal renders as "list of agents" — each
    profile = one agent with its own identity, model, channels (.env),
    and gateway subprocess.

    Read-only — does not mutate any state.
    """
    try:
        profiles = _scan_hermes_profiles()
    except Exception as e:
        log.exception("system.profiles.list failed")
        raise RpcError("INTERNAL_ERROR", f"{type(e).__name__}: {e}")
    return {"profiles": profiles, "count": len(profiles)}


METHOD_HANDLERS["system.profiles.list"] = handle_system_profiles_list


# ── Claw3D (Office 3D) compatibility methods ────────────────────────────────
# The Claw3D office UI calls a couple of gateway methods that the native Hermes
# engine doesn't expose. Provide compatible responses so the 3D office loads
# fully (no "method not supported" errors) and can infer agent run state.

async def handle_exec_approvals_get(params: dict, ctx: DispatchContext) -> dict:
    # No interactive exec-approval queue in this engine — report none pending.
    return {"approvals": [], "pending": []}


METHOD_HANDLERS["exec.approvals.get"] = handle_exec_approvals_get


async def handle_sessions_preview(params: dict, ctx: DispatchContext) -> dict:
    # Claw3D uses this to infer an agent's run state from recent history.
    # Delegate to sessions.get (full session + messages); on any failure return
    # an empty preview so the 3D office degrades gracefully instead of erroring.
    try:
        return await handle_sessions_get(params, ctx)
    except Exception:  # noqa: BLE001
        p = params if isinstance(params, dict) else {}
        return {
            "sessionKey": p.get("sessionKey") or p.get("key") or p.get("id"),
            "messages": [],
            "claudeMessages": [],
        }


METHOD_HANDLERS["sessions.preview"] = handle_sessions_preview


# -------------------------------------------------------------------------
# Dispatch entry point
# -------------------------------------------------------------------------


class RpcError(Exception):
    """Raised by handlers to produce a portal-style error response."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


async def dispatch(
    method: str,
    params: dict,
    ctx: DispatchContext,
) -> Any:
    """Route a portal RPC request to its handler.

    Returns the result payload on success.
    Raises RpcError on validation/dispatch/handler failure.
    """
    if not isinstance(method, str) or not method:
        raise RpcError("INVALID_REQUEST", "method must be a non-empty string")

    handler = METHOD_HANDLERS.get(method)
    if handler is None:
        log.warning("rpc_router: unknown method=%s (auth=%s)", method, ctx.auth.client_id)
        raise RpcError("METHOD_NOT_FOUND", f"method {method!r} is not supported")

    if isinstance(handler, HermesForward):
        # Generic forward path (not currently used, but reserved for future)
        translated_params = params
        if handler.translate_params:
            translated_params = await handler.translate_params(params, ctx)
        try:
            result = await ctx.hermes.call(
                handler.hermes_method,
                translated_params,
                timeout=300.0 if handler.long_timeout else None,
            )
        except HermesRpcError as e:
            raise RpcError(_map_hermes_code(e.code), e.message)
        except HermesProcessError as e:
            raise RpcError("ENGINE_DOWN", str(e))
        if handler.translate_result:
            result = await handler.translate_result(result, ctx)
        return _deep_scrub(result, protect_prose=method.startswith("sessions."))

    # Direct callable handler
    try:
        result = await handler(params, ctx)
        # Chokepoint scrub on RPC responses — every method. protect_prose keeps
        # user/assistant chat text + session titles/previews verbatim for
        # session methods, while scrubbing tool/catalog/skill/config/cron/error
        # surfaces here and across every other method.
        return _deep_scrub(result, protect_prose=method.startswith("sessions."))
    except RpcError:
        raise
    except Exception as e:
        log.exception("rpc_router: handler crashed for method=%s", method)
        raise RpcError("INTERNAL_ERROR", f"{type(e).__name__}: {e}")


# -------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------


def _map_hermes_code(hermes_code: int) -> str:
    """Map JSON-RPC numeric error codes to portal-friendly string codes."""
    return {
        -32700: "PARSE_ERROR",
        -32600: "INVALID_REQUEST",
        -32601: "METHOD_NOT_FOUND",
        -32602: "INVALID_PARAMS",
        -32603: "INTERNAL_ERROR",
        -32000: "SERVER_ERROR",
    }.get(hermes_code, "ENGINE_ERROR")
