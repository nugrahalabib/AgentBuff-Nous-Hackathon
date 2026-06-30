"""
agents_describer.py — LLM-based auto-describe for AgentBuff agents.

Reads SOUL.md + USER.md + identity from agent's profile.yaml, asks the
Hermes auxiliary LLM client to summarize the agent's role in 1-2
sentences. Result written back to profile.yaml::description (+ flag
`description_auto: True` so manual edits aren't overwritten).

Reads the REAL Hermes-native profile files via agents_handler (SOUL.md +
memories/USER.md + identity sidecar), not a phantom overlay. A defensive
brand scrub runs before persist so the engine name never leaks.

RPC surface:
    agents.describe(agentId, overwrite?)
        → { ok, description, reason?, autoFlag }
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("bridge.agents_describer")


# Mirror profile_describer's system prompt voice, adapted for AgentBuff
_SYSTEM_PROMPT = (
    "You are an expert at describing AI agents in short, accurate one-liners "
    "that help users (and orchestrator agents) decide when to route work to "
    "each agent. Write in Bahasa Indonesia mixed with gaming/hustler voice "
    "appropriate to the AgentBuff product (Indonesian mass market). "
    "Output ONE sentence (max 2 if absolutely needed), under 240 characters, "
    "describing what this agent does and when to use it. No preamble, no "
    "'This agent...', no quotes — just the description. "
    "NEVER mention any underlying engine, model, provider, or company name "
    "(e.g. Hermes, Nous, OpenClaw, Claw, Claude, Gemini, OpenAI). Describe only "
    "what the agent does for the user."
)

_USER_TEMPLATE = (
    "Agent name: {name}\n"
    "Identity emoji: {emoji}\n"
    "Default model: {model}\n"
    "Available skills: {skills}\n"
    "Tool profile: {tool_profile}\n"
    "\n"
    "SOUL.md (persona definition):\n"
    "{soul}\n"
    "\n"
    "USER.md (user profile for this agent):\n"
    "{user}\n"
)

_MAX_DESC_CHARS = 280


async def describe_agent(
    agents_handler: Any,
    agent_id: str,
    overwrite: bool = False,
) -> dict:
    """Generate + persist a one-line description via Hermes auxiliary LLM."""
    from agents_handler import AgentsError, _validate_agent_id  # type: ignore
    _validate_agent_id(agent_id)

    try:
        profile = await agents_handler.get_agent(agent_id)
    except AgentsError as e:
        return {"ok": False, "reason": e.message}

    # Respect manual descriptions unless explicit overwrite
    existing = (profile.get("description") or "").strip()
    is_auto = bool(profile.get("description_auto"))
    if existing and not is_auto and not overwrite:
        return {
            "ok": False,
            "reason": "manual_description_present",
            "description": existing,
            "autoFlag": False,
        }

    # Pull REAL Hermes-native files: <root>/SOUL.md + <root>/memories/USER.md
    soul_content = ""
    user_content = ""
    try:
        s = await agents_handler.get_file(agent_id, "SOUL.md")
        soul_content = (s.get("content") if isinstance(s, dict) else "") or ""
    except Exception:
        pass
    try:
        u = await agents_handler.get_file(agent_id, "memories/USER.md")
        user_content = (u.get("content") if isinstance(u, dict) else "") or ""
    except Exception:
        pass

    identity = profile.get("identity") or {}
    name = identity.get("name") or profile.get("name") or agent_id
    emoji = identity.get("emoji") or ""
    model = (profile.get("model") or {}).get("primary") or "(default)"
    skills = profile.get("skills") or []
    skills_str = ", ".join(str(s) for s in skills[:10]) or "(no allowlist — all global skills allowed)"
    skill_count_total = profile.get("skillCount") or len(skills)

    user_msg = _USER_TEMPLATE.format(
        name=name,
        emoji=emoji,
        model=model,
        skills=skills_str,
        tool_profile=f"{skill_count_total} skills available",
        soul=(soul_content[:1800] or "(SOUL.md kosong)"),
        user=(user_content[:1200] or "(USER.md kosong)"),
    )

    # Try Hermes auxiliary client
    try:
        from agent.auxiliary_client import (  # type: ignore
            get_text_auxiliary_client,
            get_auxiliary_extra_body,
        )
    except ImportError as e:
        log.warning("auxiliary_client import failed: %s", e)
        return {"ok": False, "reason": "llm_unavailable"}

    try:
        client, model_id = get_text_auxiliary_client("agentbuff_describer")
    except Exception as e:
        log.warning("get_text_auxiliary_client failed: %s", e)
        return {"ok": False, "reason": "llm_unavailable"}

    if client is None or not model_id:
        return {"ok": False, "reason": "no_llm_provider"}

    try:
        extra = get_auxiliary_extra_body() or None
        resp = client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=300,
            timeout=45,
            extra_body=extra,
        )
        text = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.warning("llm describe call failed: %s", e)
        return {"ok": False, "reason": f"llm_call_failed: {type(e).__name__}"}

    if not text:
        return {"ok": False, "reason": "llm_empty_response"}

    # Strip quotes the model loves to add
    text = text.strip().strip('"').strip("'").strip()
    # Defensive brand scrub — this description is user-visible (roster card) +
    # fed to the orchestrator routing hint, and the aux LLM occasionally leaks
    # the engine name despite the system-prompt prohibition. Hard-replace the
    # same brand tokens the SOUL generator scrubs (P1 fix 2026-05-30).
    for _old, _new in (
        ("Hermes Agent", "AgentBuff"),
        ("Hermes-Agent", "AgentBuff"),
        ("hermes-agent", "agentbuff"),
        ("Nous Research", "AgentBuff"),
        ("Hermes", "AgentBuff"),
        ("hermes", "agentbuff"),
        ("OpenClaw", "AgentBuff"),
        ("openclaw", "agentbuff"),
    ):
        text = text.replace(_old, _new)
    text = text.strip()
    if len(text) > _MAX_DESC_CHARS:
        text = text[:_MAX_DESC_CHARS].rsplit(" ", 1)[0] + "…"

    # Persist
    patch = {"description": text, "description_auto": True}
    try:
        merged = await agents_handler.update_agent(agent_id, patch)
    except AgentsError as e:
        return {"ok": False, "reason": f"persist_failed: {e.message}", "description": text}

    return {
        "ok": True,
        "description": text,
        "autoFlag": True,
        "profile": merged,
    }
