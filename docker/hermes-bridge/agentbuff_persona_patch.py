"""agentbuff_persona_patch.py — per-session agent persona for /app chat.

THE PROBLEM
-----------
AgentBuff lets a user pick WHICH agent to talk to per /app chat session (the
Command Center dropdown). Each agent is a Hermes PROFILE under
``~/.hermes/profiles/<id>/`` with its own SOUL.md + model. But the Hermes TUI
gateway (``tui_gateway/server.py``) builds EVERY session's agent from the SINGLE
GLOBAL config (``agent.system_prompt`` + ``model.default``) — it has no notion
of per-session personas. The only per-session levers it exposes
(``/personality``, ``/model`` via slash.exec) route through a worker that WRITES
CONFIG GLOBALLY → picking an agent contaminated the default agent + every other
surface (chief caught this: his "Buff" replied with a test agent's marker).

THE FIX (this file)
-------------------
Monkey-patch — applied IN the gateway process by ``bootstrap_tui_gateway.py``
BEFORE ``tui_gateway.entry`` runs, so NO Hermes source file is edited:

  1. Wrap ``@method("session.create")``: when the portal passes ``agentId``,
     remember sid → agentId in a process-local map. (Portal already sends it.)
  2. Wrap ``_make_agent(sid, key, ...)``: if that sid has a bound agent, read
     the agent's profile SOUL.md + model from disk and build the agent with
     ``ephemeral_system_prompt = <agent SOUL>`` (per-AGENT-OBJECT, per-session)
     + ``skip_context_files=True`` (suppress the GLOBAL SOUL so the persona is
     PURE — sesi kiwi == 100% kiwi, not kiwi+Buff) + the agent's model.

``ephemeral_system_prompt`` lives on the per-session agent object
(``run_agent.AIAgent``), and ``conversation_loop.py`` injects it at API-call
time. ``skip_context_files`` (agent_init.py) stops the global SOUL.md from being
auto-injected. Net: each /app session runs as its bound agent, fully isolated,
with ZERO writes to global config. Exact channel-pattern equivalent, plugin-side.

The DEFAULT agent (no agentId / "default" / "main") is untouched — it keeps the
normal global path. Every failure is swallowed → chat never breaks; worst case a
session falls back to the default agent (the pre-fix behavior).

Idempotent: install_persona_patch() no-ops if already applied.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger("agentbuff.persona_patch")

_DEFAULT_IDS = {"", "main", "default", None}
_SOUL_MAX = 64 * 1024  # mirror engine CONTEXT_FILE_MAX_CHARS intent

# sid -> agent_id (process-local; the gateway is one-per-container)
_session_agent: dict[str, str] = {}


def _hermes_home() -> Path:
    h = os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _profile_dir(agent_id: str) -> Path:
    root = _hermes_home()
    if agent_id in _DEFAULT_IDS:
        return root
    return root / "profiles" / agent_id


def _read_persona(agent_id: str) -> dict:
    """Read {soul, model, provider} for an agent straight from its profile dir.
    No global config access — purely the agent's own files."""
    pdir = _profile_dir(agent_id)
    soul = ""
    try:
        sp = pdir / "SOUL.md"
        if sp.is_file():
            soul = sp.read_text(encoding="utf-8").strip()[:_SOUL_MAX]
    except Exception:
        soul = ""
    model = ""
    provider = ""
    try:
        import yaml
        cfg_path = pdir / "config.yaml"
        if cfg_path.is_file():
            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            mblk = data.get("model") if isinstance(data, dict) else None
            if isinstance(mblk, dict):
                model = str(mblk.get("default") or mblk.get("primary") or "").strip()
                provider = str(mblk.get("provider") or "").strip()
            elif isinstance(mblk, str):
                model = mblk.strip()
    except Exception:
        pass
    return {"soul": soul, "model": model, "provider": provider}


def _read_enabled_toolsets(agent_id: str):
    """Per-agent enabled-toolset list from the profile's OWN config.yaml
    (``platform_toolsets.cli`` — what the Kemampuan-tab ``tools.toggle`` RPC
    writes). Returns a non-empty list when the user restricted this agent, else
    None (= no restriction = global default). Pure read of the agent's own file;
    never the global config."""
    pdir = _profile_dir(agent_id)
    try:
        import yaml
        cfg = pdir / "config.yaml"
        if cfg.is_file():
            data = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
            pt = data.get("platform_toolsets") if isinstance(data, dict) else None
            if isinstance(pt, dict):
                raw = pt.get("cli")
                if isinstance(raw, list):
                    cleaned = [str(x).strip() for x in raw
                               if isinstance(x, str) and x.strip()]
                    return cleaned or None
    except Exception:
        pass
    return None


def _tool_name(t) -> str:
    if isinstance(t, dict):
        fn = t.get("function") if isinstance(t.get("function"), dict) else None
        nm = (fn or t).get("name")
        if isinstance(nm, str):
            return nm
    return ""


def _scope_agent_tools(agent, toolsets) -> str:
    """Restrict THIS session's ``agent.tools`` to the agent's enabled toolsets.

    ``agent.tools`` is the literal API payload (run_agent builds the request from
    ``self.tools`` — verified at run_agent.py:4295 ``"tools": self.tools`` and
    :8735 ``tools_for_api = self.tools``), so filtering it here makes the
    per-agent tool limit REAL in /app web chat — the model only ever sees the
    permitted functions, exactly like on channels.

    We REMOVE only base-toolset tools the agent shouldn't have. Dynamically
    registered tools (MCP via ctx.register_tool, memory/LCM wrappers) are NOT in
    the base toolset universe, so a name-based remove leaves them intact — MCP
    stays workspace-global by design. Never strips the whole list (safety). Pure
    per-agent-object mutation, zero global-config write. Returns a short status
    string for logging."""
    from model_tools import get_tool_definitions

    def _names(defs):
        out = set()
        for t in defs or []:
            nm = _tool_name(t)
            if nm:
                out.add(nm)
        return out

    base = _names(get_tool_definitions(quiet_mode=True))
    allowed = _names(get_tool_definitions(enabled_toolsets=list(toolsets),
                                          quiet_mode=True))
    disallowed = base - allowed
    if not disallowed:
        return "(all)"
    cur = getattr(agent, "tools", None)
    if not isinstance(cur, list) or not cur:
        return "(all)"
    new_tools = [t for t in cur if _tool_name(t) not in disallowed]
    if not new_tools or len(new_tools) == len(cur):
        # Nothing removable, or removal would empty the list → leave untouched.
        return "(all)"
    agent.tools = new_tools
    try:
        agent.valid_tool_names = {
            _tool_name(t) for t in new_tools if _tool_name(t)
        }
    except Exception:
        pass
    return "%d/%d" % (len(new_tools), len(cur))


def install_persona_patch() -> bool:
    """Apply the wraps. Safe to call multiple times. Returns True on success."""
    try:
        import tui_gateway.server as srv
    except Exception as e:
        log.warning("persona_patch: tui_gateway.server import failed (%s) — skipped", e)
        return False

    if getattr(srv, "_agentbuff_persona_patched", False):
        return True

    # ── 1. Wrap session.create to capture sid → agentId ──────────────────
    orig_create = srv._methods.get("session.create")
    if orig_create is None:
        log.warning("persona_patch: session.create not registered yet — skipped")
        return False

    def _wrapped_create(rid, params):
        # Resolve the bound agent BEFORE building the session so we can hand the
        # gateway its NATIVE per-profile lever: the `profile` param. With it set,
        # session.create stores profile_home (tui_gateway/server.py:3004-3028)
        # and the gateway re-binds HERMES_HOME to the agent's profile for BOTH
        # the agent build (server.py:690) AND every turn (server.py:4502). That
        # makes the engine resolve skills (index + skill_view), config, model,
        # SOUL and state.db PER-AGENT natively — closing the gap where skills
        # were configured per-agent but ran global. (The _make_agent wrap below
        # still re-applies SOUL/model/tools as a model-switch safety net; with a
        # profile set it just re-applies the same per-profile values.)
        agent_id = None
        try:
            if isinstance(params, dict):
                raw = params.get("agentId") or params.get("agent_id")
                if isinstance(raw, str) and raw.strip():
                    cand = raw.strip().lower()
                    # Only a real, non-default profile dir gets the native
                    # per-profile binding; default/main/"" stay on the launch
                    # (global) home, and an unknown id falls back to global
                    # rather than pointing HERMES_HOME at a missing dir.
                    if cand not in _DEFAULT_IDS and _profile_dir(cand).is_dir():
                        agent_id = cand
                        if not str(params.get("profile") or "").strip():
                            params["profile"] = agent_id
        except Exception:
            log.debug("persona_patch: profile-inject pre-step failed", exc_info=True)

        result = orig_create(rid, params)
        try:
            if agent_id:
                # result is the JSON-RPC envelope {id, result:{session_id,...}}
                sid = None
                if isinstance(result, dict):
                    res = result.get("result")
                    if isinstance(res, dict):
                        sid = res.get("session_id") or res.get("id")
                if sid:
                    _session_agent[sid] = agent_id
                    log.info("persona_patch: session %s bound to agent %s (profile)", sid, agent_id)
        except Exception:
            log.debug("persona_patch: create-wrap bookkeeping failed", exc_info=True)
        return result

    srv._methods["session.create"] = _wrapped_create

    # ── 2. Wrap _make_agent to inject the bound agent's persona+model ────
    orig_make = srv._make_agent

    # NOTE: forward *extra/**kw verbatim. tui_gateway._make_agent's signature
    # gained a `session_db` kwarg in Hermes 0.16.0 (was (sid, key, session_id)
    # on <=0.15.2). Hard-coding the params here made the gateway call raise
    # TypeError at call time for EVERY agent build (incl the default agent) →
    # every /app chat failed silently. Passing through whatever the gateway
    # sends keeps this wrap working across the version bump.
    def _wrapped_make(sid: str, key: str, session_id: Optional[str] = None, *extra, **kw):
        agent_id = _session_agent.get(sid)
        if not agent_id or agent_id in _DEFAULT_IDS:
            return orig_make(sid, key, session_id, *extra, **kw)
        try:
            persona = _read_persona(agent_id)
            soul = persona.get("soul") or ""
            model = persona.get("model") or ""
            toolsets = _read_enabled_toolsets(agent_id)
            if not soul and not model and not toolsets:
                return orig_make(sid, key, session_id, *extra, **kw)

            # Build the agent normally, then override its per-object fields.
            # We do NOT touch global config. ephemeral_system_prompt +
            # skip_context_files are per-agent-object (this session only).
            agent = orig_make(sid, key, session_id, *extra, **kw)
            try:
                if soul:
                    agent.ephemeral_system_prompt = soul
                    # PURE persona: suppress the global SOUL.md auto-injection so
                    # the agent runs as ITS persona, not global+agent stacked.
                    agent.skip_context_files = True
                    # Invalidate any cached system prompt so the override takes.
                    if hasattr(agent, "_cached_system_prompt"):
                        agent._cached_system_prompt = None
                applied_model = "(global)"
                if model and getattr(agent, "model", None) != model:
                    # Switch model ONLY when we can resolve a COMPLETE runtime
                    # (credentials present). A half-resolved runtime (e.g. model
                    # with no usable api_key) builds an agent that 401s at call
                    # time → EMPTY reply. Persona is the core feature; the model
                    # switch is best-effort — if it can't be done safely, keep
                    # the working global runtime so the reply NEVER comes back
                    # empty. (Fail-safe after a model-switch empty-reply bug.)
                    try:
                        from hermes_cli.runtime_provider import (
                            resolve_runtime_provider,
                        )
                        rt = resolve_runtime_provider(
                            requested=persona.get("provider") or None,
                            target_model=model,
                        ) or {}
                        # A usable runtime needs SOME credential path: an
                        # api_key, OR a base_url (self-hosted/oauth), OR an
                        # acp command. Without any, do NOT switch.
                        usable = bool(
                            rt.get("api_key")
                            or rt.get("base_url")
                            or rt.get("command")
                        )
                        if usable:
                            agent.model = model
                            for attr in ("provider", "base_url", "api_key",
                                         "api_mode", "acp_command", "acp_args",
                                         "credential_pool"):
                                val = rt.get(attr if attr != "acp_command" else "command") \
                                    if attr in ("acp_command",) else rt.get(attr)
                                if val:
                                    setattr(agent, attr, val)
                            applied_model = model
                        else:
                            log.warning(
                                "persona_patch: model %s for agent %s has no usable "
                                "runtime — keeping global model (persona still applied)",
                                model, agent_id,
                            )
                    except Exception:
                        log.warning(
                            "persona_patch: model runtime resolve failed for %s "
                            "(model=%s) — keeping global model", agent_id, model,
                            exc_info=True,
                        )
                # ── per-agent TOOL scope (the kelebihan/batasan, enforced in
                # web chat too — not just channels). No-op unless the user
                # restricted this agent via the Kemampuan tab. Zero global
                # write; MCP / dynamic tools preserved. ────────────────────
                applied_tools = "(all)"
                if toolsets:
                    try:
                        applied_tools = _scope_agent_tools(agent, toolsets)
                    except Exception:
                        log.warning(
                            "persona_patch: tool scope failed for %s",
                            agent_id, exc_info=True,
                        )
                log.info(
                    "persona_patch: applied sid=%s agent=%s model=%s "
                    "soul_len=%d tools=%s",
                    sid, agent_id, applied_model, len(soul), applied_tools,
                )
            except Exception:
                log.exception("persona_patch: field override failed sid=%s", sid)
            return agent
        except Exception:
            log.exception("persona_patch: make-wrap failed sid=%s — default build", sid)
            return orig_make(sid, key, session_id, *extra, **kw)

    srv._make_agent = _wrapped_make

    # Clean the sid→agent map when a session closes (best-effort, avoid leak).
    orig_close = srv._methods.get("session.close")
    if orig_close is not None:
        def _wrapped_close(rid, params):
            try:
                if isinstance(params, dict):
                    sid = params.get("session_id")
                    if sid:
                        _session_agent.pop(sid, None)
            except Exception:
                pass
            return orig_close(rid, params)
        srv._methods["session.close"] = _wrapped_close

    srv._agentbuff_persona_patched = True
    log.info("persona_patch: installed (per-session agent persona active)")
    return True
