"""
skills_extras.py — Skills + Models RPC handlers missing from the base bridge.

Provides:
  - skills.status — rich per-skill entry (not just category buckets)
                    matches UI's SkillStatusReport shape
  - skills.update — toggle global enabled/disabled state via config.patch
                    on `skills.disabled` list (Hermes-native config key)
  - models.authStatus — provider auth state from env scan + Hermes auth.json

Per-agent skill allowlist enforcement happens in agents_extras.set_agent_skill_allowlist
(writes profile.yaml::skills). Bridge resolve_agent_for_session reads it to
filter Hermes tool list before passing to prompt.submit.

Zero Hermes source modification.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from hermes_client import HermesClient, HermesRpcError, HermesProcessError

log = logging.getLogger("bridge.skills_extras")


_BASELINE_FILE = ".agentbuff_builtin_baseline.json"


def _builtin_baseline_names(home: str, current_names: set[str]) -> set[str]:
    """Return the set of skill names considered BUILT-IN for this volume.

    On first call we snapshot every skill that currently exists (provision-time
    baseline = all bundled/seeded skills) and persist it to
    ~/.hermes/skills/.agentbuff_builtin_baseline.json. Every later skill that is
    NOT in this snapshot is an agent-authored skill. The file is created once
    and never auto-expanded, so agent-created skills stay classified correctly
    across restarts.
    """
    import json as _json
    path = Path(home) / "skills" / _BASELINE_FILE
    try:
        if path.exists():
            data = _json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return {str(x) for x in data}
    except Exception as exc:
        log.warning("read builtin baseline failed: %s", exc)
    # First run — snapshot current set as the builtin baseline.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            _json.dumps(sorted(current_names), ensure_ascii=False),
            encoding="utf-8",
        )
        log.info("seeded builtin skill baseline (%d skills)", len(current_names))
    except Exception as exc:
        log.warning("write builtin baseline failed: %s", exc)
    return set(current_names)


def _iso_to_ms(value: Any) -> Optional[int]:
    """Parse an ISO-8601 timestamp string to epoch milliseconds, or None."""
    if not value or not isinstance(value, str):
        return None
    try:
        from datetime import datetime
        s = value.strip().replace("Z", "+00:00")
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None


# -----------------------------------------------------------------
# skills.status — rich entry list (replaces category-bucket forward)
# -----------------------------------------------------------------


async def build_skills_status(
    hermes: HermesClient,
    agents_handler: Any,
    agent_id: Optional[str] = None,
) -> dict:
    """Return rich skill status for the UI's SkillStatusReport shape.

    Reads:
      - Hermes engine: list of installed/bundled skills via Python introspection
        (we import `_find_all_skills` directly since it's the canonical source).
      - Config `skills.disabled` for global disabled state.
      - Agent profile.yaml::skills for per-agent allowlist (when agent_id given).

    Skills allowed via per-agent allowlist BUT globally disabled remain "off"
    (allowlist whitelists what an agent CAN see — it doesn't override disabled).

    Skills NOT in per-agent allowlist (when allowlist non-empty) are marked
    `blockedByAllowlist=True`.
    """
    # Load skills via Hermes engine (best path, ensures parity with engine's
    # resolution including platform gating). Fall back to skills.manage RPC.
    skills_raw: list[dict] = []
    try:
        from tools.skills_tool import _find_all_skills  # type: ignore
        skills_raw = _find_all_skills(skip_disabled=True)  # all skills, not filtered
    except Exception as exc:
        log.warning("skills_tool._find_all_skills failed (%s); falling back", exc)
        try:
            r = await hermes.call("skills.manage", {"action": "list"})
            cats = r.get("skills") if isinstance(r, dict) else {}
            for cat, names in (cats or {}).items():
                for n in (names or []):
                    skills_raw.append({"name": n, "category": cat, "description": ""})
        except Exception as exc2:
            log.warning("skills.manage list also failed: %s", exc2)

    # Load disabled set + per-agent allowlist.
    # IMPORTANT: skills.disabled is PER-PROFILE (each agent = its own profile =
    # own config.yaml). When an agent_id is given, read THAT profile's config —
    # not the global active-profile config (the old load_config() path read the
    # wrong file for non-default agents, so toggles appeared not to stick). P1
    # fix 2026-05-30.
    disabled_global: set[str] = set()
    agent_allowlist: set[str] = set()  # empty = "all skills allowed"

    if agent_id:
        try:
            # Per-profile config (authoritative for this agent).
            prof_cfg = agents_handler._read_hermes_config(agent_id) or {}
            disabled_global = set((prof_cfg.get("skills") or {}).get("disabled") or [])
        except Exception as exc:
            log.warning("read per-profile skills.disabled failed for %s: %s", agent_id, exc)
        try:
            agent_profile = await agents_handler.get_agent(agent_id)
            agent_allowlist = set((agent_profile.get("skills") or []))
        except Exception:
            pass
    else:
        # No agent context → fall back to the active-profile global config.
        try:
            from hermes_cli.config import load_config  # type: ignore
            cfg = load_config() or {}
            disabled_global = set((cfg.get("skills") or {}).get("disabled") or [])
        except Exception as exc:
            log.warning("load_config for skills.disabled failed: %s", exc)

    # Resolve workspace dir hints
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    workspace_dir = str(Path(home) / "workspace")
    managed_skills_dir = str(Path(home) / "skills")

    # Agent-created skill set + usage records. The engine marks a skill as
    # "agent-created" when it is neither bundled (in .bundled_manifest) nor
    # hub-installed — i.e. a skill an agent authored itself during a session.
    # These get their own dedicated tab in the UI (global pool; per-agent on/off
    # via the allowlist). created_by is just "agent" (engine doesn't track WHICH
    # agent), so attribution is global by design.
    # Agent-created detection — BASELINE SNAPSHOT model.
    #
    # The engine's own is_agent_created() relies on .bundled_manifest, which on
    # our images is incomplete (≈20 genuinely-bundled skills are missing from
    # it, so they'd be mis-flagged as agent-authored). Source-dir discovery has
    # its own name-mismatch gaps. So instead we snapshot the FULL skill set that
    # exists at provision time as the "builtin baseline"; anything that appears
    # LATER is, by definition, something an agent created during a session.
    # This is exactly the user-facing meaning of "skill buatan agen" and is
    # immune to manifest drift.
    all_names = {str(s.get("name") or "").strip() for s in skills_raw}
    all_names.discard("")
    builtin_baseline = _builtin_baseline_names(home, all_names)

    created_records: dict[str, dict] = {}
    try:
        from tools.skill_usage import agent_created_report  # type: ignore
        for rec in agent_created_report():
            nm = str(rec.get("name") or "")
            if nm:
                created_records[nm] = rec
    except Exception as exc:
        log.warning("agent_created usage report failed: %s", exc)

    entries: list[dict] = []
    for s in skills_raw:
        name = str(s.get("name") or "").strip()
        if not name:
            continue
        skill_key = name  # in Hermes, skill name IS the key
        is_agent_created = name not in builtin_baseline
        is_disabled = name in disabled_global
        # Agent-authored skills are gated ONLY by the engine's skills.disabled
        # list, never by the synthetic allowlist whitelist. The allowlist is a
        # bridge-side inversion (disabled = all - allowlist) that would
        # retroactively "block" any skill created AFTER the allowlist was
        # materialized — even though the engine itself has them enabled. So for
        # agent-created skills we report the REAL engine state (= !disabled).
        is_blocked_by_allowlist = (
            (not is_agent_created)
            and bool(agent_allowlist)
            and (name not in agent_allowlist)
        )
        # "always" — skills bundled-and-required, can't be off (none in
        # Hermes; we don't mark any default-always here, can be configured
        # later via a hardcoded ALWAYS_ON set if desired)
        is_always = False
        # eligible = not blocked + not disabled + (no missing requirements check)
        is_eligible = not is_disabled and not is_blocked_by_allowlist

        cat = str(s.get("category") or "general")
        rec = created_records.get(name) or {}
        entries.append({
            "name": name,
            "description": (s.get("description") or "").strip(),
            "source": cat,
            "bundled": not is_agent_created,
            # Agent-authored skill (self-improvement) vs engine-bundled. Drives
            # the dedicated "Buatan Agen" tab + the delete affordance.
            "agentCreated": is_agent_created,
            "createdAtMs": _iso_to_ms(rec.get("created_at")),
            "lastUsedAtMs": _iso_to_ms(rec.get("last_used_at")),
            "useCount": int(rec.get("use_count") or 0),
            "filePath": str(s.get("path") or ""),
            "baseDir": managed_skills_dir,
            "skillKey": skill_key,
            "primaryEnv": "",
            "emoji": str(s.get("emoji") or ""),
            "homepage": str(s.get("homepage") or ""),
            "always": is_always,
            "disabled": is_disabled,
            "blockedByAllowlist": is_blocked_by_allowlist,
            "eligible": is_eligible,
            "requirements": {"bins": [], "env": []},
            "missing": {"bins": [], "env": []},
            "configChecks": [],
            "install": [],
        })

    # Stable sort: always-on first, then by name
    entries.sort(key=lambda e: (not e["always"], e["name"]))

    return {
        "workspaceDir": workspace_dir,
        "managedSkillsDir": managed_skills_dir,
        "skills": entries,
    }


# -----------------------------------------------------------------
# skills.update — toggle a skill on/off GLOBALLY via skills.disabled list
# -----------------------------------------------------------------


async def update_skill_enabled(
    config_handler: Any,
    skill_key: str,
    enabled: bool,
) -> dict:
    """Toggle a skill's global disabled state.

    Implementation: patch `skills.disabled` list in config.yaml via
    RFC 7396 merge-patch. Hermes engine reads this list on every session
    boot + on config-reload SIGUSR1.

    Note: this is global — to scope per-agent, use agents.skills.set.
    """
    if not isinstance(skill_key, str) or not skill_key.strip():
        raise ValueError("skill_key must be a non-empty string")
    skill_key = skill_key.strip()

    # Read current disabled set
    try:
        current = await config_handler.get("skills.disabled")
    except Exception:
        current = None
    current_list: list[str] = [
        str(x) for x in (current or []) if isinstance(x, str)
    ]
    current_set = set(current_list)

    if enabled:
        # Remove from disabled
        if skill_key not in current_set:
            return {"ok": True, "noop": True, "skillKey": skill_key, "enabled": True}
        new_set = current_set - {skill_key}
    else:
        # Add to disabled
        if skill_key in current_set:
            return {"ok": True, "noop": True, "skillKey": skill_key, "enabled": False}
        new_set = current_set | {skill_key}

    new_list = sorted(new_set)
    patch = {"skills": {"disabled": new_list if new_list else None}}
    await config_handler.patch(patch)
    return {
        "ok": True,
        "noop": False,
        "skillKey": skill_key,
        "enabled": enabled,
        "disabledCount": len(new_list),
    }


# -----------------------------------------------------------------
# models.authStatus — provider auth state aggregate
# -----------------------------------------------------------------


# Known LLM providers + their canonical env-var + display name
_PROVIDER_CATALOG: list[tuple[str, list[str], str]] = [
    # (provider_id, env_var_names, display_name)
    ("openai",     ["OPENAI_API_KEY"],                "OpenAI"),
    ("anthropic",  ["ANTHROPIC_API_KEY"],             "Anthropic"),
    ("google",     ["GEMINI_API_KEY", "GOOGLE_API_KEY"], "Google · Gemini"),
    ("openrouter", ["OPENROUTER_API_KEY"],            "OpenRouter"),
    ("groq",       ["GROQ_API_KEY"],                  "Groq"),
    ("deepseek",   ["DEEPSEEK_API_KEY"],              "DeepSeek"),
    ("xai",        ["XAI_API_KEY", "GROK_API_KEY"],   "xAI · Grok"),
    ("mistral",    ["MISTRAL_API_KEY"],               "Mistral"),
    ("kimi",       ["MOONSHOT_API_KEY", "KIMI_API_KEY"], "Kimi · Moonshot"),
    ("qwen",       ["DASHSCOPE_API_KEY", "QWEN_API_KEY"], "Qwen"),
    ("minimax",    ["MINIMAX_API_KEY"],               "MiniMax"),
    ("zhipu",      ["ZHIPUAI_API_KEY", "GLM_API_KEY"], "Zhipu · GLM"),
    ("cerebras",   ["CEREBRAS_API_KEY"],              "Cerebras"),
    ("fireworks",  ["FIREWORKS_API_KEY"],             "Fireworks"),
    ("together",   ["TOGETHER_API_KEY"],              "Together"),
    ("deepgram",   ["DEEPGRAM_API_KEY"],              "Deepgram"),
    # MUST stay in sync with providers_handler.py `_CATALOG` envKeys — the key
    # grid (setKey/discover) reads that catalog, this one drives the badge
    # status. "custom" was missing here, so a saved CUSTOM_API_KEY never flipped
    # the badge off "Belum ada key" even though the key WAS persisted (2026-06-03).
    ("custom",     ["CUSTOM_API_KEY"],               "Custom (OpenAI-compatible)"),
]


def _read_dotenv(path: Path) -> dict[str, str]:
    """Tiny .env parser — KEY=VALUE per line, ignore comments + blank."""
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


def _read_auth_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


async def build_models_auth_status() -> dict:
    """models.authStatus — return per-provider auth state.

    Reads env (process env first, then `$HERMES_HOME/.env`) and
    `$HERMES_HOME/auth.json` (Nous Portal / OpenRouter OAuth refresh).
    """
    ts = int(time.time() * 1000)
    home = Path(os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes"))
    env_layer: dict[str, str] = {}
    env_layer.update({k: v for k, v in os.environ.items() if isinstance(v, str)})
    env_layer.update(_read_dotenv(home / ".env"))
    auth_json = _read_auth_json(home / "auth.json")
    # Nous Portal token may sit under auth_json["nous_portal"] / auth_json["portal"]
    nous = (
        (auth_json.get("nous_portal") if isinstance(auth_json, dict) else None)
        or (auth_json.get("portal") if isinstance(auth_json, dict) else None)
        or {}
    )
    or_oauth = auth_json.get("openrouter") if isinstance(auth_json, dict) else None

    providers: list[dict] = []
    for provider_id, env_keys, display in _PROVIDER_CATALOG:
        status = "missing"
        expiry: Optional[dict] = None

        # Direct env-key check
        for k in env_keys:
            v = env_layer.get(k)
            if v and v.strip() and not v.strip().startswith("REPLACE"):
                status = "static"
                break

        # OAuth-style overrides
        if provider_id == "openrouter" and isinstance(or_oauth, dict):
            tok = or_oauth.get("access_token")
            exp_at = or_oauth.get("expires_at")
            if isinstance(tok, str) and tok.strip():
                status = "ok"
                if isinstance(exp_at, (int, float)) and exp_at > 0:
                    remaining = int(exp_at * 1000 - ts)
                    expiry = {
                        "at": int(exp_at * 1000),
                        "remainingMs": remaining,
                        "label": _format_remaining(remaining),
                    }
                    if remaining < 0:
                        status = "expired"
                    elif remaining < 24 * 3600 * 1000:
                        status = "expiring"
        # Nous portal supplies many models (gemini, claude, etc.) — treat as openrouter-like
        if status == "missing" and isinstance(nous, dict):
            tok = nous.get("access_token") or nous.get("token")
            if isinstance(tok, str) and tok.strip():
                status = "ok"

        entry: dict = {
            "provider": provider_id,
            "displayName": display,
            "status": status,
        }
        if expiry is not None:
            entry["expiry"] = expiry
        providers.append(entry)

    # ── OAuth providers (Codex / Gemini-CLI / xAI / MiniMax) ──────────────
    # These don't use an env API key — after login their tokens land in
    # auth.json::credential_pool under a provider key. The OAuth cards need a
    # "Terhubung" badge, so report their status from the pool. (Was missing →
    # the card stayed on "Masuk" even after a successful login.)
    pool = auth_json.get("credential_pool") if isinstance(auth_json, dict) else {}
    pool = pool if isinstance(pool, dict) else {}
    pool_keys = list(pool.keys())

    def _pool_has(*candidates: str) -> bool:
        for cand in candidates:
            if cand in pool:
                return True
            # tolerate namespaced keys like "openai-codex:default"
            if any(str(pk).split(":", 1)[0] == cand for pk in pool_keys):
                return True
        return False

    _OAUTH_PROVIDERS = [
        ("openai-codex", "ChatGPT (Codex / Plus)", ("openai-codex",)),
        ("google-gemini-cli", "Gemini (langganan Google)", ("google-gemini-cli", "gemini-cli", "gemini-oauth")),
        ("xai-oauth", "xAI · Grok", ("xai-oauth",)),
        ("minimax-oauth", "MiniMax", ("minimax-oauth",)),
    ]
    for pid, display, keys in _OAUTH_PROVIDERS:
        providers.append({
            "provider": pid,
            "displayName": display,
            "status": "ok" if _pool_has(*keys) else "missing",
        })

    return {"ts": ts, "providers": providers}


def _format_remaining(ms: int) -> str:
    if ms <= 0:
        return "Expired"
    sec = ms // 1000
    if sec < 60:
        return f"{sec} detik"
    minutes = sec // 60
    if minutes < 60:
        return f"{minutes} menit"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} jam"
    days = hours // 24
    return f"{days} hari"
