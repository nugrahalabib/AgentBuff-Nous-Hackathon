"""routing.py — the pre_gateway_dispatch hook that makes per-agen real.

THIS IS THE CRUX (spike-verified 2026-05-30). When a message arrives on a
synthetic platform (e.g. telegram__cs), the engine fires pre_gateway_dispatch
BEFORE auth + agent build, passing (event, gateway, session_store). Here we:

  1. Detect the synthetic platform → (base_channel, account_id).
  2. Resolve which AGENT (Hermes profile) handles this account, considering
     bindings[] for fine-grained peer/group routing, else the account's
     default agent_id from config.extra.
  3. Load that agent's persona (SOUL.md), model (config.yaml::model.default),
     and skills (agentbuff.yaml::skills_allowlist) from its profile dir.
  4. Stamp the MessageEvent: channel_prompt = SOUL text, auto_skill = skills.
  5. Set gateway._session_model_overrides[session_key] = {model, provider, ...}
     so the agent runs on that agent's model. Evict cached agent so the
     override takes effect this turn.

Returns None (allow) — never skips/rewrites text. All failures are swallowed
(return None) so a routing hiccup never drops a user's message.

NO engine source modification — uses only the public hook + documented-private
gateway fields (_session_model_overrides, _session_key_for_source,
_evict_cached_agent) that the /model command itself uses (run.py:9376).
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from .account_config import parse_synthetic_name

logger = logging.getLogger("agentbuff.multichannel.routing")


def _message_time_line() -> str:
    """Wall-clock time THIS message was received, in the configured timezone.

    The engine injects only a day-level DATE into the cached system prompt and
    strips per-message timestamps before the model (run.py:607). To give the
    agent real-time awareness, we add the exact receive time as ephemeral
    per-message context (channel_prompt). Timezone-agnostic offset (UTC+07:00)
    so it stays correct if the container/user timezone changes."""
    try:
        try:
            from hermes_time import now as _hn  # engine's own, respects tz
            n = _hn()
        except Exception:
            from zoneinfo import ZoneInfo
            n = datetime.now(
                ZoneInfo(os.environ.get("HERMES_TIMEZONE", "Asia/Jakarta"))
            )
        off = n.strftime("%z") or "+0000"
        off_fmt = f"UTC{off[:3]}:{off[3:]}"
        return (
            f"[Konteks waktu] Pesan ini diterima pada "
            f"{n.strftime('%A, %Y-%m-%d %H:%M')} ({off_fmt}). "
            f"Anggap ini sebagai waktu sekarang (real-time)."
        )
    except Exception:
        logger.debug("message time line failed", exc_info=True)
        return ""


def _inject_message_time(event) -> None:
    """Append the per-message receive time to event.channel_prompt (ephemeral
    per-turn context — does NOT pollute the user's text or the cached system
    prompt). Safe for ALL platforms; runs before the synthetic early-return."""
    try:
        note = _message_time_line()
        if not note:
            return
        existing = getattr(event, "channel_prompt", None)
        event.channel_prompt = (existing + "\n\n" + note) if existing else note
    except Exception:
        logger.debug("inject message time failed", exc_info=True)


# ── Profile resolution ──────────────────────────────────────────────────────


def _hermes_home() -> Path:
    h = os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _profile_dir(agent_id: str) -> Path:
    """Resolve agent_id → profile dir. 'default' = root ~/.hermes."""
    root = _hermes_home()
    if agent_id in ("default", "", None):
        return root
    return root / "profiles" / agent_id


def _read_yaml(path: Path) -> dict:
    try:
        import yaml
        if not path.is_file():
            return {}
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _profile_mtime_key(agent_id: str) -> float:
    """Aggregate mtime of the 3 profile files we read, for cache invalidation."""
    pdir = _profile_dir(agent_id)
    total = 0.0
    for fn in ("SOUL.md", "config.yaml", "agentbuff.yaml"):
        p = pdir / fn
        try:
            total += p.stat().st_mtime
        except OSError:
            pass
    return total


# Cache persona payloads keyed by (agent_id, mtime_key) so edits invalidate.
@lru_cache(maxsize=64)
def _load_persona_cached(agent_id: str, _mtime_key: float) -> dict:
    pdir = _profile_dir(agent_id)

    soul_path = pdir / "SOUL.md"
    soul = ""
    try:
        if soul_path.is_file():
            soul = soul_path.read_text(encoding="utf-8")
    except Exception:
        soul = ""

    cfg = _read_yaml(pdir / "config.yaml")
    model_blk = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    model = model_blk.get("default") or model_blk.get("primary")
    provider = model_blk.get("provider")
    api_key = model_blk.get("api_key")
    base_url = model_blk.get("base_url")

    ab = _read_yaml(pdir / "agentbuff.yaml")
    skills = ab.get("skills_allowlist")
    skills = skills if isinstance(skills, list) and skills else None

    return {
        "soul": soul,
        "model": model,
        "provider": provider,
        "api_key": api_key,
        "base_url": base_url,
        "skills": skills,
    }


def load_persona(agent_id: str) -> dict:
    return _load_persona_cached(agent_id, _profile_mtime_key(agent_id))


# ── Bindings (top-level config.yaml, mtime-cached) ──────────────────────────


def _root_config_path() -> Path:
    return _hermes_home() / "config.yaml"


@lru_cache(maxsize=1)
def _read_bindings_at(_mtime: float) -> tuple:
    """Read top-level config.yaml::bindings[]. Returns a tuple (hashable for
    lru_cache) of binding dicts. Cached by config.yaml mtime."""
    cfg = _read_yaml(_root_config_path())
    raw = cfg.get("bindings")
    if not isinstance(raw, list):
        return ()
    return tuple(b for b in raw if isinstance(b, dict))


def _read_bindings_cached() -> list:
    try:
        mtime = _root_config_path().stat().st_mtime
    except OSError:
        return []
    return list(_read_bindings_at(mtime))


@lru_cache(maxsize=32)
def _account_agent_id_at(synthetic: str, _mtime: float) -> Optional[str]:
    """Read gateway.platforms.<synthetic>.extra.agent_id (or top-level
    platforms.<synthetic>) from config.yaml. Cached by mtime."""
    cfg = _read_yaml(_root_config_path())
    gw = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    platforms = gw.get("platforms") if isinstance(gw.get("platforms"), dict) else {}
    if synthetic not in platforms and isinstance(cfg.get("platforms"), dict):
        platforms = cfg["platforms"]
    block = platforms.get(synthetic) if isinstance(platforms, dict) else None
    if not isinstance(block, dict):
        return None
    extra = block.get("extra") if isinstance(block.get("extra"), dict) else {}
    cand = extra.get("agent_id") or extra.get("agentId")
    return cand.strip() if isinstance(cand, str) and cand.strip() else None


def _read_account_agent_id_cached(synthetic: str) -> Optional[str]:
    try:
        mtime = _root_config_path().stat().st_mtime
    except OSError:
        return None
    return _account_agent_id_at(synthetic, mtime)


# ── Agent resolution (bindings → account default) ───────────────────────────


def _resolve_agent_for(
    base_channel: str,
    account_id: str,
    *,
    peer_id: Optional[str],
    peer_kind: Optional[str],
    gateway: Any,
) -> str:
    """Decide which agent handles this inbound. Order:
      1. bindings[] match on (synthetic channel, account, peer)
      2. account's configured agent_id (config.extra.agent_id)
      3. "default"
    """
    synthetic = f"{base_channel}__{account_id}"

    # 1. bindings[] — top-level config.yaml key (AgentBuff convention; the
    #    Hermes engine itself never reads it, GatewayConfig has NO bindings
    #    field, so we read the file directly + cache by mtime).
    try:
        raw_bindings = _read_bindings_cached()
        if raw_bindings:
            best = _match_binding(
                raw_bindings, synthetic, base_channel, account_id, peer_id, peer_kind
            )
            if best:
                return best
    except Exception:
        logger.debug("binding resolve failed", exc_info=True)

    # 2a. account default from LIVE gateway config (fast path when available).
    try:
        cfg = getattr(gateway, "config", None)
        platforms = getattr(cfg, "platforms", None)
        if platforms:
            from gateway.config import Platform
            pcfg = platforms.get(Platform(synthetic)) if synthetic else None
            if pcfg is not None:
                extra = getattr(pcfg, "extra", {}) or {}
                cand = extra.get("agent_id") or extra.get("agentId")
                if isinstance(cand, str) and cand.strip():
                    return cand.strip()
    except Exception:
        logger.debug("account-default (live) resolve failed", exc_info=True)

    # 2b. fallback — read agent_id straight from config.yaml file. Bulletproof
    #     against gateway.config being unavailable/stale at hook-fire time.
    try:
        cand = _read_account_agent_id_cached(synthetic)
        if cand:
            return cand
    except Exception:
        logger.debug("account-default (file) resolve failed", exc_info=True)

    return "default"


def _match_binding(
    bindings: list,
    synthetic: str,
    base_channel: str,
    account_id: str,
    peer_id: Optional[str],
    peer_kind: Optional[str],
) -> Optional[str]:
    """Find highest-specificity matching binding's agent_id, or None.

    Binding shape (config.yaml::bindings[]):
      { type?: route, agentId/agent_id, match: { channel, account_id?,
        peer?: {kind,id} } }
    channel matches either the synthetic name OR the base channel.
    """
    matched: list[tuple[int, str]] = []
    for b in bindings:
        if not isinstance(b, dict):
            continue
        btype = b.get("type")
        if btype is not None and btype != "route":
            continue
        agent = b.get("agentId") or b.get("agent_id")
        if not isinstance(agent, str) or not agent:
            continue
        m = b.get("match") or {}
        if not isinstance(m, dict):
            continue
        ch = m.get("channel")
        if ch not in (synthetic, base_channel):
            continue
        macc = m.get("account_id") or m.get("accountId")
        if macc and macc != account_id:
            continue
        score = 0
        if macc:
            score += 5
        peer = m.get("peer") if isinstance(m.get("peer"), dict) else None
        if peer:
            if peer.get("kind") and peer.get("kind") != peer_kind:
                continue
            if peer.get("id"):
                if str(peer.get("id")) != str(peer_id):
                    continue
                score += 100
            elif peer.get("kind"):
                score += 10
        matched.append((score, agent))
    if not matched:
        return None
    matched.sort(key=lambda t: t[0], reverse=True)
    return matched[0][1]


# ── The hook ────────────────────────────────────────────────────────────────


def _persist_env_line(key: str, value: str) -> None:
    """Best-effort upsert of KEY=value into ~/.hermes/.env (atomic rename)."""
    try:
        env_path = _hermes_home() / ".env"
        env_path.parent.mkdir(parents=True, exist_ok=True)
        lines: list[str] = []
        if env_path.exists():
            with open(env_path, encoding="utf-8-sig", errors="replace") as f:
                lines = f.readlines()
        seen = False
        for i, line in enumerate(lines):
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.split("=", 1)[0].strip() == key:
                lines[i] = f"{key}={value}\n"
                seen = True
                break
        if not seen:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.append(f"{key}={value}\n")
        tmp = env_path.with_suffix(".env.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.writelines(lines)
        os.replace(tmp, env_path)
    except Exception:
        logger.debug("auto-sethome: .env persist failed", exc_info=True)


def _auto_sethome(source, platform_value: str) -> None:
    """Silently designate the first inbound chat as the platform's home channel.

    Hermes (gateway/run.py:8717) shows a one-time "No home channel is set…
    /sethome" onboarding notice on the first message when <PLATFORM>_HOME_CHANNEL
    is unset. That dev-onboarding prompt confuses mass-market users. We mirror
    the engine's OWN native auto-sethome (it does this for Yuanbao) for every
    channel: set the env BEFORE the prompt check runs, so it never fires, and
    cron/notification delivery has a real target. Honors a value the user set
    via /sethome (we only fill when unset).
    """
    try:
        chat_id = getattr(source, "chat_id", None)
        if not chat_id:
            return
        # Derive the env-var EXACTLY like the engine's sethome check does
        # (run.py:8717 → _home_target_env_var) — it uppercases WITHOUT replacing
        # hyphens, so `whatsapp__default-1` → `WHATSAPP__DEFAULT-1_HOME_CHANNEL`.
        # Our earlier re.sub turned the hyphen into "_" → key mismatch → the
        # prompt was never suppressed. Use the engine's own function so the key
        # always matches; fall back to a literal upper() (NOT re.sub).
        try:
            from gateway.run import _home_target_env_var
            env_key = _home_target_env_var(platform_value)
        except Exception:
            env_key = platform_value.upper() + "_HOME_CHANNEL"
        if os.environ.get(env_key):
            return  # already set (engine config load or a prior auto-sethome)
        # Live set suppresses the prompt for this message + the rest of the
        # process (the hook fires before run.py:8717 on EVERY message, including
        # the first after a restart), so persistence is a bonus, not required.
        os.environ[env_key] = str(chat_id)
        # Only persist SAFE env keys to ~/.hermes/.env. Synthetic platforms can
        # produce hyphenated keys (WHATSAPP__DEFAULT-1_HOME_CHANNEL) — writing
        # those could corrupt the dotenv file that also holds channel tokens, so
        # we skip the file write for them and rely on the per-boot live set.
        if re.match(r"^[A-Z_][A-Z0-9_]*$", env_key):
            _persist_env_line(env_key, str(chat_id))
        logger.info("auto-sethome: %s = %s (silent)", env_key, chat_id)
    except Exception:
        logger.debug("auto-sethome failed", exc_info=True)


def on_pre_gateway_dispatch(event=None, gateway=None, session_store=None, **kwargs):
    """pre_gateway_dispatch hook. Returns None (allow) always."""
    try:
        if event is None or gateway is None:
            return None
        source = getattr(event, "source", None)
        platform = getattr(source, "platform", None) if source else None
        platform_value = getattr(platform, "value", None) if platform else None
        if not platform_value:
            return None

        # Instant realtime: a channel message just arrived. Poke the bridge so
        # /app flips this session to "working" + pulls the new turn immediately
        # (don't wait for the watcher's idle poll). Best-effort; never blocks.
        try:
            from .activity_poke import poke_activity
            poke_activity()
        except Exception:
            pass

        # Suppress the engine's "/sethome" onboarding prompt for ALL channels
        # (native + synthetic) by auto-designating the first chat as home. Runs
        # BEFORE the synthetic early-return below so native Telegram is covered.
        _auto_sethome(source, platform_value)

        # Per-message real-time: give the agent the exact send/receive time of
        # THIS message. Runs for ALL platforms (native + synthetic) BEFORE the
        # early-return below. Appends to channel_prompt (ephemeral per-turn).
        _inject_message_time(event)

        ident = parse_synthetic_name(platform_value)
        if ident is None:
            # Native (non-synthetic) channel — routes to the launch/default
            # agent. Mark it working so /app animates the default agent's card
            # for this off-web turn (the DB can't show an in-flight turn).
            try:
                from .activity_poke import mark_turn_start
                mark_turn_start("default")
            except Exception:
                pass
            return None  # not our synthetic platform — leave untouched

        # Peer info for binding match
        peer_id = getattr(source, "chat_id", None)
        chat_type = getattr(source, "chat_type", None)
        peer_kind = (
            "group" if chat_type in ("group", "channel") else "direct"
        )

        agent_id = _resolve_agent_for(
            ident.base_channel,
            ident.account_id,
            peer_id=peer_id,
            peer_kind=peer_kind,
            gateway=gateway,
        )

        # Mark this agent working so /app animates its card for the duration of
        # this channel turn (cleared when the reply goes out — see
        # mark_reply_sent in the outbound send wrapper).
        try:
            from .activity_poke import mark_turn_start
            mark_turn_start(agent_id)
        except Exception:
            pass

        persona = load_persona(agent_id)

        # 1. Persona (SOUL) → channel_prompt (per-message ephemeral system prompt).
        # PRESERVE the time note already injected above (prepend soul to it).
        if persona.get("soul"):
            try:
                existing = getattr(event, "channel_prompt", None)
                event.channel_prompt = (
                    persona["soul"] + "\n\n" + existing
                    if existing
                    else persona["soul"]
                )
            except Exception:
                pass

        # 2. Skills → auto_skill
        if persona.get("skills"):
            try:
                event.auto_skill = persona["skills"]
            except Exception:
                pass

        # 3. Model → per-session override
        model = persona.get("model")
        if model:
            try:
                session_key = gateway._session_key_for_source(source)
                if session_key:
                    override = {"model": model}
                    if persona.get("provider"):
                        override["provider"] = persona["provider"]
                    if persona.get("api_key"):
                        override["api_key"] = persona["api_key"]
                    if persona.get("base_url"):
                        override["base_url"] = persona["base_url"]
                    existing = gateway._session_model_overrides.get(session_key)
                    if existing != override:
                        gateway._session_model_overrides[session_key] = override
                        # Evict cached agent so new model takes effect this turn
                        evict = getattr(gateway, "_evict_cached_agent", None)
                        if callable(evict):
                            try:
                                evict(session_key)
                            except Exception:
                                pass
            except Exception:
                logger.debug("model override set failed", exc_info=True)

        # 4. Per-agent SKILL RESTRICTION + TOOLS at channel runtime.
        # auto_skill (#2) only AUTO-LOADS the agent's skills — it does NOT
        # restrict, and toolsets still resolve from the launch profile. Bind
        # HERMES_HOME to THIS agent's profile so the engine resolves the skill
        # index + skill_view (get_skills_dir / get_disabled_skill_names) AND the
        # agent's toolsets (_get_platform_tools reads the profile config) from the
        # bound agent's profile for the build + turn that follow — the SAME native
        # lever tui_gateway uses (server.py:690 build / :4502 per-turn),
        # cron/scheduler.py:280, and the dashboard.
        #
        # SAFE because invoke_hook runs this callback INLINE (hermes_cli/
        # plugins.py:1562 — no copy_context), so the override lives in THIS
        # message's asyncio task context: it persists through the agent build +
        # run_conversation, then dies when the per-message task ends (task-local
        # ContextVar) → no cross-message / cross-account leak. Default/launch
        # agent → no override (root resolves to the launch profile anyway).
        home_bound = False
        try:
            agent_dir = _profile_dir(agent_id)
            root = _hermes_home()
            if (
                agent_id not in ("default", "", None)
                and agent_dir.is_dir()
                and agent_dir.resolve() != root.resolve()
            ):
                from hermes_constants import set_hermes_home_override
                set_hermes_home_override(str(agent_dir))
                home_bound = True
        except Exception:
            logger.debug("per-agent home bind (channel) failed", exc_info=True)

        logger.info(
            "routing: %s → agent=%s model=%s skills=%s home_bound=%s",
            platform_value, agent_id, model,
            len(persona.get("skills") or []), home_bound,
        )
    except Exception:
        logger.exception("on_pre_gateway_dispatch crashed (non-fatal)")
    return None
