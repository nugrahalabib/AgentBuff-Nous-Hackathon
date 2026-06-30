"""
channels_handler.py — Custom RPCs for channel pairing, status, and logout.

WHY THIS EXISTS
---------------
Hermes does NOT expose channel pairing or channel state through its
public RPC surface. Channel setup happens via interactive CLI:
    hermes gateway setup --platform=telegram

That CLI is a wizard that asks for bot token, writes to config, and
restarts the gateway adapter. None of that is reachable programmatically
by the AgentBuff portal.

This handler implements the AgentBuff portal contract on top of
Hermes' filesystem config:

  channels.status        — Read config.yaml + runtime probes, return dashboard payload
  channels.pair          — Write token/credentials to config.yaml + restart gateway
  channels.logout        — Remove account from config + restart
  channels.list-bindings — Return current routing table
  channels.upsert-binding— Add or modify a routing rule
  channels.delete-binding— Remove routing rule

TWO PAIRING MODES
-----------------
1. NATIVE (default agent's primary account). agent_id None/"default" AND
   account_id None/"default". Writes `channels.<channel>` (top-level) +
   `~/.hermes/.env` + restart. This is Hermes' built-in single-account
   path — chief's existing Telegram/WhatsApp live here, untouched.

2. SYNTHETIC (per-agen multi-account). agent_id is a named profile OR
   account_id is given. Writes top-level
   `platforms.<base>__<account>: {enabled, extra:{base_channel, account_id,
   agent_id, <creds>}}`. The agentbuff-multichannel plugin registers each
   synthetic platform name, spawns its own library client, and routes
   inbound to `extra.agent_id`. N accounts of one channel type coexist in
   ONE gateway process. Supported bases: telegram, whatsapp, discord, slack.

   Engine integration verified 2026-05-30 (zero engine modification):
   `load_gateway_config()` merges top-level `platforms` + calls
   `discover_plugins()` before `GatewayConfig.from_dict`, so
   `Platform("telegram__cs")` resolves via `platform_registry` →
   `PlatformConfig.extra` carries the creds → `_create_adapter` checks the
   registry first → the plugin adapter connects.

ROUTING (bindings)
------------------
Each binding tells the gateway: "when message arrives at channel X
account Y from peer Z, route to agent A". Stored as `bindings: [...]` at
the root of config.yaml. The multichannel plugin's pre_gateway_dispatch
hook consults them for fine-grained peer/group routing (the engine itself
never reads `bindings`).

POLICY DEFAULTS
---------------
For mass-market UX, pairing sets open policies (dmPolicy=open,
allowFrom=["*"], ...) on native channels and relies on the global
`GATEWAY_ALLOW_ALL_USERS=true` env (shared by synthetic platforms) so no
per-user CLI approval is ever required.

PER-CHANNEL SCHEMA VARIATION
----------------------------
- telegram, discord, slack, whatsapp: dmPolicy + allowFrom + groupPolicy + groupAllowFrom
- google_chat: NO dmPolicy/allowFrom (audience-based; allow-all via env)
- email, sms, homeassistant, webhook: different fields entirely

Canonicalized via PER_CHANNEL_PAIR_SCHEMA below.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from config_handler import ConfigHandler


# -------------------------------------------------------------------------
# Hermes env file (~/.hermes/.env) writer
# -------------------------------------------------------------------------
# Channel credentials for NATIVE channels live in ~/.hermes/.env per Hermes
# convention (`hermes_cli.config.save_env_value`). Without writing here,
# `hermes gateway run` reports "Telegram: not configured" even when
# config.yaml has the bot token. SYNTHETIC channels do NOT use env — their
# adapters read credentials straight from `platforms.<synthetic>.extra`.

_ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")


def _hermes_home_dir() -> Path:
    hermes_home = os.environ.get("HERMES_HOME")
    return Path(hermes_home) if hermes_home else Path.home() / ".hermes"


def _hermes_env_path() -> Path:
    return _hermes_home_dir() / ".env"


def _wa_self_info(account_id: str) -> dict:
    """Read the linked WhatsApp account's own phone + display name from the
    Baileys session creds. Returns {phone, displayName} (digits only for phone,
    no '+'); empty dict if not linked / unreadable. Pure filesystem read — the
    bridge never surfaces this otherwise so the UI shows 'NOMOR —'.

    Session layout (whatsapp-bridge): `wa-sessions/<account_id>/creds.json`
    with `me.id = "<e164>:<device>@s.whatsapp.net"` + `me.name`.
    """
    try:
        acc = account_id or "default"
        creds_path = _hermes_home_dir() / "wa-sessions" / acc / "creds.json"
        if not creds_path.exists():
            return {}
        with open(creds_path, encoding="utf-8", errors="replace") as f:
            creds = json.load(f)
        me = creds.get("me") if isinstance(creds.get("me"), dict) else {}
        raw_id = str(me.get("id") or "")
        # "6285167029779:10@s.whatsapp.net" -> "6285167029779"
        phone = raw_id.split(":", 1)[0].split("@", 1)[0]
        phone = re.sub(r"\D", "", phone)
        name = me.get("name")
        out: dict = {}
        if phone:
            out["phone"] = phone
        if isinstance(name, str) and name.strip():
            out["displayName"] = name.strip()
        return out
    except Exception:  # noqa: BLE001 — status must never throw
        return {}


def _detect_known_groups(channel_id: str) -> list[dict]:
    """Best-effort list of groups the bot is known to be in, for the cron
    "Kirim ke" picker. The engine keeps no group directory, so we infer:
      - WhatsApp: distinct group JIDs (<id>@g.us) from the Baileys session's
        sender-key files (a group leaves sender-key-<jid>@g.us--*.json behind).
      - Telegram: the configured home channel(s) when they're a group/channel
        (negative chat id). No group NAMES are stored anywhere, so labels are
        the raw id — honest, not faked.
    Returns [{id, label}]. Fail-open to []."""
    out: list[dict] = []
    seen: set[str] = set()
    try:
        if channel_id == "whatsapp":
            wa_root = _hermes_home_dir() / "wa-sessions"
            if wa_root.is_dir():
                for acc_dir in wa_root.iterdir():
                    if not acc_dir.is_dir():
                        continue
                    for f in acc_dir.glob("sender-key-*@g.us--*"):
                        m = re.search(r"(\d+)@g\.us", f.name)
                        if m:
                            jid = m.group(1) + "@g.us"
                            if jid not in seen:
                                seen.add(jid)
                                out.append({"id": jid, "label": f"Grup WhatsApp …{m.group(1)[-5:]}"})
        elif channel_id == "telegram":
            # Home channel(s) live in ~/.hermes/.env (the bridge process does not
            # load them into os.environ), so read the dotenv file directly.
            env_path = _hermes_env_path()
            pairs: dict[str, str] = {}
            if env_path.exists():
                with open(env_path, encoding="utf-8-sig", errors="replace") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, _, v = line.partition("=")
                        pairs[k.strip()] = v.strip()
            for k, v in pairs.items():
                if "TELEGRAM" in k and k.endswith("_HOME_CHANNEL"):
                    val = str(v or "").strip()
                    # Negative chat id = group/supergroup/channel (not a DM).
                    if val.startswith("-") and val not in seen:
                        seen.add(val)
                        out.append({"id": val, "label": f"Grup Telegram {val}"})
    except Exception:
        return []
    return out


def _telegram_bot_id(bot_token: Optional[str]) -> Optional[str]:
    """Numeric bot id is the prefix of a Telegram token ('<id>:<secret>').
    Cheap, offline identifier so the UI shows something concrete instead of a
    bare 'Bot' label (the @username needs a getMe network call we skip here)."""
    if not isinstance(bot_token, str) or ":" not in bot_token:
        return None
    head = bot_token.split(":", 1)[0].strip()
    return head if head.isdigit() else None


def _attach_account_identity(
    acc_obj: dict, base_channel: str, account_id: str, cfg_or_extra: dict
) -> None:
    """Enrich an account dict (in place) with a human-facing identity so the UI
    renders the actual account instead of a bare placeholder ('NOMOR —', 'Bot').

    Adds (when derivable, never raises):
      - phone        WhatsApp E.164 digits (from session creds)
      - displayName  WhatsApp pushname / generic label
      - botId        Telegram numeric bot id (token prefix)

    Best-effort + offline. Works for both native and synthetic accounts since
    they share the same on-disk session / token layout, keyed by account_id.
    """
    try:
        if base_channel == "whatsapp":
            info = _wa_self_info(account_id)
            if info.get("phone"):
                acc_obj["phone"] = info["phone"]
            if info.get("displayName"):
                acc_obj["displayName"] = info["displayName"]
        elif base_channel == "telegram":
            token = cfg_or_extra.get("bot_token") or cfg_or_extra.get("botToken")
            bot_id = _telegram_bot_id(token)
            if bot_id:
                acc_obj["botId"] = bot_id
    except Exception:  # noqa: BLE001 — status must never throw
        pass


def _profile_exists(agent_id: Optional[str]) -> bool:
    """True if `agent_id` names an existing Hermes profile (or is default)."""
    if agent_id in (None, "", "default"):
        return True
    return (_hermes_home_dir() / "profiles" / agent_id).is_dir()


def _write_env_values(updates: dict[str, str]) -> None:
    """Set or update keys in ~/.hermes/.env. Atomic via temp + rename.

    Preserves any pre-existing keys (other channel tokens, provider keys).
    Imported by agentbuff_bridge.py for GEMINI_API_KEY seeding — keep the
    single-dict signature stable.
    """
    for k in updates.keys():
        if not _ENV_KEY_RE.match(k):
            raise ValueError(f"Invalid env key: {k!r}")
    env_path = _hermes_env_path()
    env_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    if env_path.exists():
        with open(env_path, encoding="utf-8-sig", errors="replace") as f:
            lines = f.readlines()

    seen: set[str] = set()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            lines[i] = f"{key}={updates[key]}\n"
            seen.add(key)

    for k, v in updates.items():
        if k not in seen:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] = lines[-1] + "\n"
            lines.append(f"{k}={v}\n")

    tmp_path = env_path.with_suffix(".env.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, env_path)
    try:
        env_path.chmod(0o600)
    except OSError:
        pass


def _remove_env_values(keys: list[str]) -> None:
    """Remove keys from ~/.hermes/.env. Safe no-op if file or keys missing."""
    env_path = _hermes_env_path()
    if not env_path.exists():
        return
    with open(env_path, encoding="utf-8-sig", errors="replace") as f:
        lines = f.readlines()
    keep: list[str] = []
    targets = set(keys)
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            keep.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in targets:
            continue
        keep.append(line)
    tmp_path = env_path.with_suffix(".env.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.writelines(keep)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, env_path)


def _read_env_values(keys: list[str]) -> dict[str, str]:
    """Read selected keys from ~/.hermes/.env. Missing keys absent from result.

    Used by channels.getAccess to reflect the CURRENT allowlist back to the UI
    so editing post-pairing shows what's actually enforced (env is the gate —
    config.channels.<id>.allowFrom is NOT, see config.py:1003 `not os.getenv`).
    """
    env_path = _hermes_env_path()
    if not env_path.exists():
        return {}
    targets = set(keys)
    out: dict[str, str] = {}
    with open(env_path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            k, _, v = stripped.partition("=")
            k = k.strip()
            if k in targets:
                out[k] = v.strip()
    return out


log = logging.getLogger("bridge.channels_handler")


# -------------------------------------------------------------------------
# Per-channel pairing schemas
# -------------------------------------------------------------------------
# required_fields: keys that MUST be in pair payload
# token_field:     credential field name in config (for redaction/presence)
# default_policies: extra fields auto-set on NATIVE pair (mass-market UX)
# env_keys:        credential field → ~/.hermes/.env variable (NATIVE only)
# auto_env:        extra static env on NATIVE pair (open allowlists)
PER_CHANNEL_PAIR_SCHEMA: dict[str, dict] = {
    "telegram": {
        "required_fields": ["botToken"],
        "token_field": "botToken",
        "default_policies": {
            "enabled": True,
            "dmPolicy": "open",
            "allowFrom": ["*"],
            "groupPolicy": "open",
            "groupAllowFrom": ["*"],
        },
        "env_keys": {
            "botToken": "TELEGRAM_BOT_TOKEN",
        },
        "auto_env": {
            "TELEGRAM_ALLOWED_USERS": "*",
            "GATEWAY_ALLOW_ALL_USERS": "true",
        },
    },
    "discord": {
        "required_fields": ["token"],
        "token_field": "token",
        "default_policies": {
            "enabled": True,
            "dmPolicy": "open",
            "allowFrom": ["*"],
            "groupPolicy": "open",
            "groupAllowFrom": ["*"],
        },
        "env_keys": {
            "token": "DISCORD_BOT_TOKEN",
        },
        "auto_env": {
            "DISCORD_ALLOWED_USERS": "*",
            "GATEWAY_ALLOW_ALL_USERS": "true",
        },
    },
    "slack": {
        "required_fields": ["botToken", "signingSecret"],
        "token_field": "botToken",
        "default_policies": {
            "enabled": True,
            "dmPolicy": "open",
            "allowFrom": ["*"],
            "groupPolicy": "open",
            "groupAllowFrom": ["*"],
        },
        "env_keys": {
            "botToken": "SLACK_BOT_TOKEN",
            "appToken": "SLACK_APP_TOKEN",
            "signingSecret": "SLACK_SIGNING_SECRET",
        },
        "auto_env": {
            "SLACK_ALLOWED_USERS": "*",
            "GATEWAY_ALLOW_ALL_USERS": "true",
        },
    },
    "whatsapp": {
        "required_fields": [],  # QR-based, no token in pair payload
        "token_field": None,
        "default_policies": {
            "enabled": True,
            "dmPolicy": "open",
            "allowFrom": ["*"],
            "groupPolicy": "open",
            "groupAllowFrom": ["*"],
        },
        "env_keys": {},  # WA uses QR-based session in filesystem
        "auto_env": {
            "WHATSAPP_ENABLED": "true",
            "GATEWAY_ALLOW_ALL_USERS": "true",
        },
    },
    "google_chat": {
        "required_fields": ["serviceAccountJson", "subscriptionName"],
        "token_field": "serviceAccountJson",
        "default_policies": {
            "enabled": True,
            # Google Chat has no dmPolicy/allowFrom — audience-based
        },
        "env_keys": {
            "serviceAccountJson": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON",
            "projectId": "GOOGLE_CHAT_PROJECT_ID",
            "subscriptionName": "GOOGLE_CHAT_SUBSCRIPTION_NAME",
        },
        # Mass-market open access. The GC adapter's audience gate reads
        # GOOGLE_CHAT_ALLOW_ALL_USERS from env (not config.extra), so a bot
        # ignores everyone unless this is set — same "self-chat" bug class as WA.
        "auto_env": {
            "GOOGLE_CHAT_ALLOW_ALL_USERS": "true",
        },
    },
    "matrix": {
        "required_fields": ["homeserverUrl", "username", "password"],
        "token_field": "password",
        "default_policies": {
            "enabled": True,
        },
    },
    "email": {
        "required_fields": ["emailAddress", "emailPassword", "imapHost", "smtpHost"],
        "token_field": "emailPassword",
        "default_policies": {
            "enabled": True,
        },
    },
    "sms": {
        "required_fields": ["twilioAccountSid", "twilioAuthToken", "fromNumber"],
        "token_field": "twilioAuthToken",
        "default_policies": {
            "enabled": True,
        },
    },
    "homeassistant": {
        "required_fields": ["url", "token"],
        "token_field": "token",
        "default_policies": {
            "enabled": True,
        },
    },
    "webhook": {
        "required_fields": [],  # Generic webhook, no creds required at pair
        "token_field": None,
        "default_policies": {
            "enabled": True,
        },
    },
}

# Slug validator for account_id / agent_id (lowercase alnum + internal hyphens, 1-40)
_ACCOUNT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$")


# -------------------------------------------------------------------------
# Synthetic platform naming — per-agen multi-account (plugin-driven)
# -------------------------------------------------------------------------
# A "synthetic platform" runs ONE channel account as its own registered
# Hermes Platform so N accounts of the same channel type coexist in one
# gateway process. The agentbuff-multichannel plugin (in
# hermes_multichannel_plugin/) registers these names + routes each to the
# agent recorded in its `extra.agent_id`.
#
# Naming convention MUST stay in lock-step with
# hermes_multichannel_plugin/account_config.py (DELIM, regex, base set).
SYNTHETIC_DELIM = "__"
SYNTHETIC_SUPPORTED = frozenset(
    {"telegram", "whatsapp", "discord", "slack", "google_chat", "email"}
)

# Map portal credential field names → the snake_case `extra` keys the
# plugin's concrete adapters read (adapter_telegram/discord/slack.py).
SYNTHETIC_CRED_MAP: dict[str, dict[str, str]] = {
    "telegram": {"botToken": "bot_token"},
    "discord": {"token": "bot_token", "botToken": "bot_token"},
    "slack": {
        "botToken": "bot_token",
        "appToken": "app_token",
        "signingSecret": "signing_secret",
    },
    "whatsapp": {},  # QR-based; adapter derives port + session from account_id
    "google_chat": {
        "serviceAccountJson": "service_account_json",
        "projectId": "project_id",
        "subscriptionName": "subscription_name",
    },
    # Email (IMAP/SMTP, outbound poll — no public webhook). UI field → extra key
    # (consumed by adapter_email's per-account cred override).
    "email": {
        "emailAddress": "email_address",
        "emailPassword": "email_password",
        "imapHost": "imap_host",
        "imapPort": "imap_port",
        "smtpHost": "smtp_host",
        "smtpPort": "smtp_port",
    },
}

# Channel-specific env that the SYNTHETIC (per-agen) path must ALSO set because
# some native adapters read an access gate from the process environment rather
# than config.extra. Google Chat's audience check reads GOOGLE_CHAT_ALLOW_ALL_USERS
# from env — without it the bot silently ignores every inbound message. Global
# env is fine: all GC accounts in this container share open-audience semantics.
# NOTE: Google Chat's GOOGLE_CHAT_ALLOW_ALL_USERS is now managed by the
# allowlist write (_allowlist_env_updates handles the ALLOW_ALL companion based
# on whether the user chose an email allowlist or open access), so it's no
# longer force-set to "true" here. Left empty; populate only for channels that
# need a STATIC extra env not covered by the allowlist path.
SYNTHETIC_EXTRA_ENV: dict[str, dict[str, str]] = {}


# Per-channel env var(s) that hold the sender allowlist read by the engine's
# run.py::_is_user_authorized (verified against hermes-agent 0.15.2,
# gateway/run.py:6443). Semantics that make the per-channel allowlist a HARD
# gate (not cosmetic):
#   - If the channel's *_ALLOWED_USERS env is set to concrete IDs (non-empty,
#     no "*"), _is_user_authorized restricts to exactly those IDs and does NOT
#     fall back to the global GATEWAY_ALLOW_ALL_USERS flag (the fallback only
#     fires when ALL allowlists are empty — run.py:6580).
#   - "*" in the list means allow everyone for that channel.
# So writing this env from the pair payload's allowFrom is sufficient to limit
# who may chat the bot, without touching the global allow-all gate (which other
# channels / synthetic accounts in the same container still rely on).
_CHANNEL_ALLOW_ENV: dict[str, dict[str, str]] = {
    "telegram": {
        "dm": "TELEGRAM_ALLOWED_USERS",
        "group": "TELEGRAM_GROUP_ALLOWED_USERS",
    },
    "discord": {"dm": "DISCORD_ALLOWED_USERS"},
    "slack": {"dm": "SLACK_ALLOWED_USERS"},
    "whatsapp": {"dm": "WHATSAPP_ALLOWED_USERS"},
    # Google Chat: allowlist is EMAIL addresses, gated by the GC plugin adapter
    # (plugins/platforms/google_chat/adapter.py registers allowed_users_env +
    # allow_all_env). ALLOW_ALL is checked FIRST in _is_user_authorized, so an
    # allowlist requires ALLOW_ALL=false; an open bot uses ALLOW_ALL=true +
    # empty list. Container-global (one env for all GC accounts).
    "google_chat": {
        "dm": "GOOGLE_CHAT_ALLOWED_USERS",
        "allow_all": "GOOGLE_CHAT_ALLOW_ALL_USERS",
    },
}


def _normalize_allow_list(value: Any) -> str:
    """Map a pair-payload allowFrom value -> CSV env string.

    Returns "*" (allow everyone) when the list is missing, empty, or already
    contains "*". Otherwise returns a comma-joined, de-duplicated, trimmed CSV
    of the explicit IDs. Order preserved for human-readable env files.
    """
    if not isinstance(value, list):
        return "*"
    seen: set[str] = set()
    ids: list[str] = []
    for raw in value:
        s = str(raw).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        ids.append(s)
    if not ids or "*" in seen:
        return "*"
    return ",".join(ids)


def _allowlist_env_updates(channel_id: str, credentials: dict) -> dict[str, str]:
    """Translate a pair payload's allowFrom/groupAllowFrom into the per-channel
    *_ALLOWED_USERS env var(s). Empty dict for channels with no env-based gate
    (those rely on config.extra / audience semantics instead)."""
    mapping = _CHANNEL_ALLOW_ENV.get(channel_id)
    if not mapping:
        return {}
    out: dict[str, str] = {}
    dm_csv: Optional[str] = None
    if "dm" in mapping:
        dm_csv = _normalize_allow_list(credentials.get("allowFrom"))
    if "allow_all" in mapping:
        # Channels with a separate ALLOW_ALL flag (Google Chat): the flag is
        # checked before the allowlist, so an allowlist needs it false. When
        # open, clear the list (a literal "*" isn't a valid email token) and
        # let the flag govern.
        is_open = dm_csv is None or dm_csv == "*"
        out[mapping["allow_all"]] = "true" if is_open else "false"
        if "dm" in mapping:
            out[mapping["dm"]] = "" if is_open else dm_csv  # type: ignore[assignment]
    elif "dm" in mapping:
        out[mapping["dm"]] = dm_csv  # type: ignore[assignment]
    if "group" in mapping:
        group_val = credentials.get("groupAllowFrom", credentials.get("allowFrom"))
        out[mapping["group"]] = _normalize_allow_list(group_val)
    return out


def _synthetic_allow_env(synthetic_name: str) -> str:
    """Per-synthetic-platform allowlist env var name.

    Multi-account (synthetic) platforms register with this env name as their
    PlatformEntry.allowed_users_env so the engine's _is_user_authorized gates
    each account independently. The derivation MUST stay byte-for-byte in sync
    with hermes_multichannel_plugin (it computes the same name at register time
    so the engine reads the env this bridge writes). Formula: uppercase the
    synthetic name, replace every non-alnum char with "_", append
    "_ALLOWED_USERS". e.g. "telegram__cs" -> "TELEGRAM__CS_ALLOWED_USERS".
    """
    safe = re.sub(r"[^A-Z0-9]", "_", synthetic_name.upper())
    return f"{safe}_ALLOWED_USERS"


def _make_synthetic_name(base_channel: str, account_id: str) -> str:
    return f"{base_channel}{SYNTHETIC_DELIM}{account_id}"


def _parse_synthetic_name(name: str) -> Optional[tuple[str, str]]:
    """Reverse _make_synthetic_name → (base_channel, account_id) or None."""
    if not isinstance(name, str) or SYNTHETIC_DELIM not in name:
        return None
    base, _, acc = name.partition(SYNTHETIC_DELIM)
    base = base.strip().lower()
    acc = acc.strip().lower()
    if base not in SYNTHETIC_SUPPORTED:
        return None
    if not _ACCOUNT_ID_RE.match(acc):
        return None
    return (base, acc)


class ChannelsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class ChannelsHandler:
    """Channel pairing + status + logout via config.yaml manipulation."""

    def __init__(
        self,
        config_handler: ConfigHandler,
        gateway_restart_callback,  # callable: async () -> None
    ) -> None:
        self._config = config_handler
        self._restart_gateway = gateway_restart_callback

    # -----------------------------------------------------------------
    # channels.status
    # -----------------------------------------------------------------

    async def status(self) -> dict:
        """Aggregate channel state. Returns dashboard-ready payload.

        Keys:
          channels      — NATIVE channels (default agent's primary accounts),
                          mirrors the legacy shape the portal already renders.
          bindings      — routing table (serialized).
          agentChannels — SYNTHETIC accounts grouped by agent_id:
                          { "<agent>": { "channels": { "telegram": {
                            "accounts": [ {account_id, synthetic_platform,
                            enabled, configured, ...} ] } } } }.
        """
        cfg = await self._config.get() or {}
        configured = cfg.get("channels") or {}
        bindings = cfg.get("bindings") or []

        channels = {}
        for channel_id in PER_CHANNEL_PAIR_SCHEMA.keys():
            channel_cfg = configured.get(channel_id, {})
            accounts = self._extract_accounts(channel_id, channel_cfg)
            channels[channel_id] = {
                "configured": bool(channel_cfg),
                "enabled": bool(channel_cfg.get("enabled", False)),
                "running": bool(channel_cfg.get("enabled", False)),
                "accounts": accounts,
                "routedAgentId": _resolve_default_routed_agent(channel_id, bindings),
                "lastError": None,
            }

        agent_channels = self._scan_synthetic_accounts(cfg)

        return {
            "channels": channels,
            "bindings": [
                _serialize_binding(b) for b in bindings if isinstance(b, dict)
            ],
            "agentChannels": agent_channels,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _extract_accounts(self, channel_id: str, channel_cfg: dict) -> list[dict]:
        """Normalize a NATIVE channel's config into a uniform account list."""
        accounts_ns = (
            channel_cfg.get("accounts") if isinstance(channel_cfg, dict) else None
        )
        result = []
        schema = PER_CHANNEL_PAIR_SCHEMA.get(channel_id, {})
        token_field = schema.get("token_field")

        if isinstance(accounts_ns, dict) and accounts_ns:
            for acc_id, acc_cfg in accounts_ns.items():
                if not isinstance(acc_cfg, dict):
                    continue
                has_cred = bool(token_field and acc_cfg.get(token_field))
                acc_obj = {
                    "account_id": acc_id,
                    "configured": has_cred,
                    "enabled": bool(acc_cfg.get("enabled", True)),
                    "running": bool(acc_cfg.get("enabled", True)),
                    "lastError": None,
                    "dmPolicy": acc_cfg.get("dmPolicy"),
                    "hasCredential": has_cred,
                }
                _attach_account_identity(acc_obj, channel_id, acc_id, acc_cfg)
                result.append(acc_obj)
        else:
            has_cred = bool(token_field and channel_cfg.get(token_field))
            if has_cred or channel_cfg.get("enabled"):
                acc_obj = {
                    "account_id": "default",
                    "configured": has_cred,
                    "enabled": bool(channel_cfg.get("enabled", True)),
                    "running": bool(channel_cfg.get("enabled", True)),
                    "lastError": None,
                    "dmPolicy": channel_cfg.get("dmPolicy"),
                    "hasCredential": has_cred,
                }
                _attach_account_identity(acc_obj, channel_id, "default", channel_cfg)
                result.append(acc_obj)
        return result

    def _scan_synthetic_accounts(self, cfg: dict) -> dict:
        """Group synthetic-platform accounts by agent_id.

        Reads top-level `platforms.<base>__<account>` entries (skips
        non-synthetic platforms like api_server) and buckets each under its
        `extra.agent_id` for the per-agen Saluran matrix.
        """
        platforms = cfg.get("platforms") if isinstance(cfg.get("platforms"), dict) else {}
        out: dict = {}
        for name, block in platforms.items():
            parsed = _parse_synthetic_name(name)
            if parsed is None:
                continue
            base, acc = parsed
            if not isinstance(block, dict):
                continue
            extra = block.get("extra") if isinstance(block.get("extra"), dict) else {}
            agent_id = extra.get("agent_id") or extra.get("agentId") or "default"
            has_cred = bool(
                extra.get("bot_token") or extra.get("app_token") or base == "whatsapp"
            )
            enabled = bool(block.get("enabled", False))
            agent_bucket = out.setdefault(agent_id, {"channels": {}})
            ch_bucket = agent_bucket["channels"].setdefault(base, {"accounts": []})
            acc_obj = {
                "account_id": acc,
                "synthetic_platform": name,
                "enabled": enabled,
                "running": enabled,
                "configured": has_cred,
                "hasCredential": has_cred,
                "lastError": None,
            }
            _attach_account_identity(acc_obj, base, acc, extra)
            ch_bucket["accounts"].append(acc_obj)
        return out

    # -----------------------------------------------------------------
    # channels.pair
    # -----------------------------------------------------------------

    async def pair(
        self,
        channel_id: str,
        credentials: dict,
        *,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict:
        """Pair a channel. Dispatches NATIVE vs SYNTHETIC (per-agen).

        NATIVE (agent_id None/"default" AND account_id None/"default"):
            writes `channels.<channel>` + ~/.hermes/.env + restart. Chief's
            primary Telegram/WhatsApp path — unchanged.

        SYNTHETIC (agent_id named OR account_id given):
            writes `platforms.<base>__<account>.extra` + ensures the
            multichannel plugin is enabled + restart. Routes to agent_id.
        """
        schema = PER_CHANNEL_PAIR_SCHEMA.get(channel_id)
        if schema is None:
            raise ChannelsError(
                "UNSUPPORTED",
                f"channel {channel_id!r} is not in the supported list "
                f"({sorted(PER_CHANNEL_PAIR_SCHEMA.keys())})",
            )
        if not isinstance(credentials, dict):
            raise ChannelsError("INVALID_REQUEST", "credentials must be a dict")
        for field in schema["required_fields"]:
            if not credentials.get(field):
                raise ChannelsError(
                    "INVALID_REQUEST",
                    f"missing required field {field!r} for channel {channel_id}",
                )

        account_id = self._normalize_slug(account_id, "account_id")
        agent_id = self._normalize_slug(agent_id, "agent_id")

        is_synthetic = (
            (agent_id not in (None, "default"))
            or (account_id not in (None, "default"))
            # Email is ALWAYS synthetic, even for the default agent: the native
            # EmailAdapter reads creds from ENV (EMAIL_ADDRESS/...), but our
            # adapter_email reads them from config.extra. Routing default-agent
            # email through _pair_native would write config without the ENV the
            # native adapter needs (silent breakage). Synthetic path uses
            # adapter_email (config.extra) uniformly → email__default works.
            or (channel_id == "email")
        )
        if is_synthetic:
            return await self._pair_synthetic(
                channel_id, credentials, account_id, agent_id
            )
        return await self._pair_native(channel_id, credentials, schema)

    @staticmethod
    def _normalize_slug(value: Optional[str], label: str) -> Optional[str]:
        if value is None:
            return None
        norm = str(value).strip().lower()
        if not norm:
            return None
        if norm == "default":
            return "default"
        if not _ACCOUNT_ID_RE.match(norm):
            raise ChannelsError(
                "INVALID_REQUEST",
                f"{label} must be lowercase alphanumeric + hyphens, 1-40 chars, "
                f"no leading/trailing hyphen (got {value!r})",
            )
        return norm

    async def _pair_native(
        self, channel_id: str, credentials: dict, schema: dict
    ) -> dict:
        new_cfg = dict(schema["default_policies"])
        new_cfg.update(credentials)
        paired_at = datetime.now(timezone.utc).isoformat()
        new_cfg["paired_at"] = paired_at

        await self._config.patch({"channels": {channel_id: new_cfg}})

        env_updates: dict[str, str] = {}
        for cred_field, env_key in (schema.get("env_keys") or {}).items():
            val = credentials.get(cred_field)
            if isinstance(val, str) and val:
                env_updates[env_key] = val
        for k, v in (schema.get("auto_env") or {}).items():
            env_updates.setdefault(k, v)
        # Override the auto_env open default ("*") with the explicit allowlist
        # from the pair payload. This is what makes the access-control UI a real
        # gate: concrete IDs here cause the engine to reject everyone else.
        for k, v in _allowlist_env_updates(channel_id, credentials).items():
            env_updates[k] = v
        if env_updates:
            try:
                _write_env_values(env_updates)
                log.info(
                    "channels_handler: native pair wrote %d env key(s) for %s",
                    len(env_updates), channel_id,
                )
            except Exception:
                log.exception(
                    "channels_handler: native env write failed for %s", channel_id
                )

        await self._restart_gateway()
        log.info("channels_handler: paired native channel=%s", channel_id)
        return {
            "ok": True,
            "channel": channel_id,
            "account_id": "default",
            "agent_id": "default",
            "mode": "native",
            "paired_at": paired_at,
        }

    async def _pair_synthetic(
        self,
        channel_id: str,
        credentials: dict,
        account_id: Optional[str],
        agent_id: Optional[str],
    ) -> dict:
        if channel_id not in SYNTHETIC_SUPPORTED:
            raise ChannelsError(
                "UNSUPPORTED",
                f"channel {channel_id!r} belum mendukung multi-account per-agen "
                f"(didukung: {sorted(SYNTHETIC_SUPPORTED)})",
            )
        resolved_agent = agent_id or "default"
        resolved_account = account_id or resolved_agent
        if not _ACCOUNT_ID_RE.match(resolved_account):
            raise ChannelsError(
                "INVALID_REQUEST",
                f"account_id {resolved_account!r} invalid (derived from agent_id; "
                f"pass an explicit accountId)",
            )
        if resolved_agent != "default" and not _profile_exists(resolved_agent):
            raise ChannelsError(
                "AGENT_NOT_FOUND",
                f"profile '{resolved_agent}' tidak ada — buat dulu via agents.create",
            )

        synthetic = _make_synthetic_name(channel_id, resolved_account)

        extra: dict[str, Any] = {
            "base_channel": channel_id,
            "account_id": resolved_account,
            "agent_id": resolved_agent,
        }
        for cred_field, extra_key in SYNTHETIC_CRED_MAP.get(channel_id, {}).items():
            val = credentials.get(cred_field)
            if isinstance(val, str) and val:
                extra[extra_key] = val
        # Mass-market default: an agent in a GROUP chat must stay silent unless
        # @-mentioned / replied-to / commanded — otherwise it spams every message
        # (chief's complaint 2026-05-30). Every native adapter reads
        # config.extra["require_mention"]; WhatsApp + Telegram default it to FALSE
        # (respond-to-all), which is wrong for us. DMs are NEVER gated by this —
        # require_mention only affects groups. Honor an explicit override from the
        # pair payload (the per-agent "free response" toggle), else default True.
        rm = credentials.get("require_mention")
        extra["require_mention"] = bool(rm) if rm is not None else True
        paired_at = datetime.now(timezone.utc).isoformat()
        extra["paired_at"] = paired_at

        block = {"enabled": True, "extra": extra}
        await self._config.patch({"platforms": {synthetic: block}})

        await self._ensure_multichannel_plugin_enabled()

        # Global allow-all stays true as a back-compat floor (only consulted
        # when a platform has NO allowlist set). Synthetic platforms register a
        # per-platform allowed_users_env (see hermes_multichannel_plugin), so
        # writing that env from allowFrom gives each ACCOUNT its own gate.
        try:
            _write_env_values({"GATEWAY_ALLOW_ALL_USERS": "true"})
        except Exception:
            log.exception("synthetic pair: GATEWAY_ALLOW_ALL_USERS write failed")
        # Allowlist for sender-gated channels.
        if channel_id in _CHANNEL_ALLOW_ENV:
            try:
                mapping = _CHANNEL_ALLOW_ENV[channel_id]
                if "allow_all" in mapping:
                    # Global-env channel (Google Chat): the adapter reads ONE
                    # GOOGLE_CHAT_ALLOWED_USERS for all accounts, not a per-acct
                    # env. Write the global mapping (incl. ALLOW_ALL companion).
                    _write_env_values(_allowlist_env_updates(channel_id, credentials))
                else:
                    # True per-account synthetic env (telegram/discord/slack).
                    _write_env_values(
                        {_synthetic_allow_env(synthetic): _normalize_allow_list(
                            credentials.get("allowFrom"))}
                    )
            except Exception:
                log.exception(
                    "synthetic pair: per-account allowlist env write failed for %s",
                    synthetic,
                )
        # Some adapters (Google Chat) read an env-based audience gate that the
        # global GATEWAY_ALLOW_ALL_USERS does NOT cover.
        extra_env = SYNTHETIC_EXTRA_ENV.get(channel_id)
        if extra_env:
            try:
                _write_env_values(dict(extra_env))
            except Exception:
                log.exception(
                    "synthetic pair: extra env write failed for %s", channel_id
                )

        await self._restart_gateway()
        log.info(
            "channels_handler: paired synthetic platform=%s agent=%s",
            synthetic, resolved_agent,
        )
        return {
            "ok": True,
            "channel": channel_id,
            "account_id": resolved_account,
            "agent_id": resolved_agent,
            "synthetic_platform": synthetic,
            "mode": "synthetic",
            "paired_at": paired_at,
        }

    async def _ensure_multichannel_plugin_enabled(self) -> None:
        """Append 'agentbuff-multichannel' to config.yaml::plugins.enabled.

        Idempotent. RFC 7396 treats lists as REPLACE, so we read → append-
        if-missing → write the merged list (preserving other plugins).
        """
        try:
            current = await self._config.get("plugins")
            enabled = current.get("enabled") if isinstance(current, dict) else None
            merged = list(enabled) if isinstance(enabled, list) else []
            if "agentbuff-multichannel" not in merged:
                merged.append("agentbuff-multichannel")
                await self._config.patch({"plugins": {"enabled": merged}})
                log.info(
                    "channels_handler: enabled agentbuff-multichannel plugin (list=%s)",
                    merged,
                )
        except Exception:
            log.exception("channels_handler: ensure multichannel plugin enabled failed")

    # -----------------------------------------------------------------
    # channels.logout
    # -----------------------------------------------------------------

    async def logout(
        self,
        channel_id: str,
        *,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict:
        """Remove a channel account. Dispatches NATIVE vs SYNTHETIC."""
        account_id = self._normalize_slug(account_id, "account_id")
        agent_id = self._normalize_slug(agent_id, "agent_id")
        is_synthetic = (
            (agent_id not in (None, "default"))
            or (account_id not in (None, "default"))
            # Email is ALWAYS synthetic (see pair()): even the default agent's
            # email lives at platforms.email__default, not channels.email. Route
            # logout to _logout_synthetic so Putuskan actually removes it.
            or (channel_id == "email")
        )
        if is_synthetic:
            return await self._logout_synthetic(channel_id, account_id, agent_id)
        return await self._logout_native(channel_id)

    async def _logout_native(self, channel_id: str) -> dict:
        cfg = await self._config.get() or {}
        channel_cfg = (cfg.get("channels") or {}).get(channel_id)
        if not channel_cfg:
            raise ChannelsError(
                "NOT_FOUND", f"channel {channel_id!r} belum dikonfigurasi"
            )

        filtered_bindings = [
            b for b in (cfg.get("bindings") or [])
            if not _binding_matches_channel(b, channel_id, account_id=None)
        ]
        await self._config.patch(
            {"channels": {channel_id: None}, "bindings": filtered_bindings}
        )

        schema = PER_CHANNEL_PAIR_SCHEMA.get(channel_id, {})
        env_keys: list[str] = []
        env_keys.extend((schema.get("env_keys", {}) or {}).values())
        env_keys.extend((schema.get("auto_env", {}) or {}).keys())
        # Also drop the per-channel allowlist env vars (incl. the GROUP variant,
        # which is not part of auto_env) so a logout leaves no stale allowlist.
        env_keys.extend(_CHANNEL_ALLOW_ENV.get(channel_id, {}).values())
        # NEVER drop the global allow-all gate — synthetic platforms + other
        # channels depend on it. Only drop channel-specific keys.
        env_keys = [k for k in env_keys if k != "GATEWAY_ALLOW_ALL_USERS"]
        if env_keys:
            try:
                _remove_env_values(env_keys)
            except Exception:
                log.exception(
                    "channels_handler: native env remove failed for %s", channel_id
                )

        await self._restart_gateway()
        log.info("channels_handler: logged out native channel=%s", channel_id)
        return {
            "ok": True,
            "channel": channel_id,
            "account_id_removed": None,
            "wiped_whole_channel": True,
            "mode": "native",
        }

    async def _logout_synthetic(
        self,
        channel_id: str,
        account_id: Optional[str],
        agent_id: Optional[str],
    ) -> dict:
        resolved_agent = agent_id or "default"
        resolved_account = account_id or resolved_agent
        synthetic = _make_synthetic_name(channel_id, resolved_account)

        cfg = await self._config.get() or {}
        platforms = cfg.get("platforms") or {}
        if synthetic not in platforms:
            raise ChannelsError(
                "NOT_FOUND", f"akun {synthetic!r} belum di-pair"
            )

        bindings = cfg.get("bindings") or []
        filtered = [
            b for b in bindings
            if not _binding_matches_channel(b, channel_id, account_id=resolved_account)
            and not _binding_matches_channel(b, synthetic, account_id=None)
        ]
        await self._config.patch(
            {"platforms": {synthetic: None}, "bindings": filtered}
        )
        # Drop the per-account allowlist env (no-op if the channel isn't
        # sender-gated). Leaves no stale allowlist behind on logout.
        if channel_id in _CHANNEL_ALLOW_ENV:
            try:
                _remove_env_values([_synthetic_allow_env(synthetic)])
            except Exception:
                log.exception(
                    "channels_handler: synthetic allowlist env remove failed for %s",
                    synthetic,
                )
        await self._restart_gateway()
        log.info(
            "channels_handler: logged out synthetic platform=%s agent=%s",
            synthetic, resolved_agent,
        )
        return {
            "ok": True,
            "channel": channel_id,
            "account_id_removed": resolved_account,
            "agent_id": resolved_agent,
            "synthetic_platform": synthetic,
            "wiped_whole_channel": False,
            "mode": "synthetic",
        }

    # -----------------------------------------------------------------
    # channels.getAccess / channels.setAccess — edit who-may-chat AFTER
    # pairing, without re-entering the token. The gate is the env var
    # (*_ALLOWED_USERS); config.channels.<id>.allowFrom is NOT enforced once
    # the env is set (engine config.py:1003 guards `not os.getenv(...)`), so
    # we read/write the env directly here.
    # -----------------------------------------------------------------

    def _resolve_access_env(
        self,
        channel_id: str,
        account_id: Optional[str],
        agent_id: Optional[str],
    ) -> tuple[Optional[str], bool]:
        """(env_name, is_synthetic) for this account's allowlist env, or
        (None, _) if the channel isn't sender-gated."""
        mapping = _CHANNEL_ALLOW_ENV.get(channel_id)
        if not mapping or "dm" not in mapping:
            return None, False
        # WhatsApp + Google Chat are global-env channels: WA's Node Baileys
        # bridge reads the GLOBAL WHATSAPP_ALLOWED_USERS at spawn (not per-acct,
        # not engine _is_user_authorized); GC's plugin adapter reads the global
        # GOOGLE_CHAT_ALLOWED_USERS. So their allowlist is container-global
        # across all accounts. Always use the global env; restart re-applies it.
        if channel_id in ("whatsapp", "google_chat"):
            return mapping["dm"], False
        is_synthetic = (
            (agent_id not in (None, "default"))
            or (account_id not in (None, "default"))
        )
        if is_synthetic:
            resolved_agent = agent_id or "default"
            resolved_account = account_id or resolved_agent
            synthetic = _make_synthetic_name(channel_id, resolved_account)
            return _synthetic_allow_env(synthetic), True
        return mapping["dm"], False

    async def get_access(
        self,
        channel_id: str,
        *,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict:
        account_id = self._normalize_slug(account_id, "account_id")
        agent_id = self._normalize_slug(agent_id, "agent_id")
        env_name, _is_synth = self._resolve_access_env(
            channel_id, account_id, agent_id
        )
        if env_name is None:
            return {"supported": False, "channel": channel_id}
        csv = _read_env_values([env_name]).get(env_name, "").strip()
        ids = [s.strip() for s in csv.split(",") if s.strip()]
        groups = _detect_known_groups(channel_id)
        # Empty env (falls back to global allow-all) or wildcard == "Semua orang".
        if not ids or "*" in ids:
            return {
                "supported": True,
                "channel": channel_id,
                "dmMode": "all",
                "allowlist": [],
                "groups": groups,
            }
        return {
            "supported": True,
            "channel": channel_id,
            "dmMode": "allowlist",
            "allowlist": ids,
            "groups": groups,
        }

    async def set_access(
        self,
        channel_id: str,
        *,
        allow_from: Any,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        group_allow_from: Any = None,
    ) -> dict:
        account_id = self._normalize_slug(account_id, "account_id")
        agent_id = self._normalize_slug(agent_id, "agent_id")
        if not isinstance(allow_from, list):
            raise ChannelsError("INVALID_REQUEST", "allowFrom must be a list")
        env_name, is_synthetic = self._resolve_access_env(
            channel_id, account_id, agent_id
        )
        if env_name is None:
            raise ChannelsError(
                "UNSUPPORTED",
                f"channel {channel_id!r} tidak mendukung allowlist per-sender",
            )
        csv = _normalize_allow_list(allow_from)
        if is_synthetic:
            # True per-account synthetic env (telegram/discord/slack multi-acct).
            env_updates: dict[str, str] = {env_name: csv}
        else:
            # Native/global: full mapping incl group + allow_all (GC) companion.
            env_updates = _allowlist_env_updates(
                channel_id,
                {
                    "allowFrom": allow_from,
                    "groupAllowFrom": group_allow_from
                    if isinstance(group_allow_from, list)
                    else allow_from,
                },
            )
        _write_env_values(env_updates)

        is_open = csv == "*"
        ids = [] if is_open else [s for s in csv.split(",") if s]
        # Mirror into config for display consistency (NOT the gate). Native
        # only, and skip channels without dmPolicy semantics (Google Chat).
        if not is_synthetic and channel_id != "google_chat":
            cfg_patch = {
                "dmPolicy": "open" if is_open else "allowlist",
                "allowFrom": ["*"] if is_open else list(ids),
                "groupPolicy": "open" if is_open else "allowlist",
                "groupAllowFrom": ["*"] if is_open else list(ids),
            }
            try:
                await self._config.patch({"channels": {channel_id: cfg_patch}})
            except Exception:
                log.exception(
                    "set_access: config mirror patch failed for %s", channel_id
                )

        await self._restart_gateway()
        log.info(
            "channels_handler: set_access channel=%s synthetic=%s mode=%s n=%d",
            channel_id, is_synthetic, "all" if is_open else "allowlist", len(ids),
        )
        return {
            "ok": True,
            "channel": channel_id,
            "dmMode": "all" if is_open else "allowlist",
            "allowlist": ids,
        }

    # -----------------------------------------------------------------
    # channels.list-bindings / upsert-binding / delete-binding
    # -----------------------------------------------------------------

    async def list_bindings(self) -> dict:
        cfg = await self._config.get() or {}
        bindings = cfg.get("bindings") or []
        return {
            "bindings": [
                _serialize_binding(b) for b in bindings if isinstance(b, dict)
            ]
        }

    async def upsert_binding(self, binding: dict) -> dict:
        """Add new binding or update existing one matching same channel+account+peer."""
        if not isinstance(binding, dict):
            raise ChannelsError("INVALID_REQUEST", "binding must be a dict")
        agent_id = binding.get("agent_id") or binding.get("agentId")
        if not agent_id:
            raise ChannelsError("INVALID_REQUEST", "binding.agent_id is required")

        match = binding.get("match") or {}
        if not isinstance(match, dict):
            raise ChannelsError("INVALID_REQUEST", "binding.match must be a dict")
        channel = match.get("channel")
        if not channel:
            raise ChannelsError("INVALID_REQUEST", "binding.match.channel is required")

        normalized = {
            "type": "route",
            "agent_id": agent_id,
            "match": {
                "channel": channel,
                "account_id": match.get("account_id") or match.get("accountId"),
                "peer": match.get("peer"),
                "guild_id": match.get("guild_id") or match.get("guildId"),
                "team_id": match.get("team_id") or match.get("teamId"),
                "roles": match.get("roles"),
            },
        }

        cfg = await self._config.get() or {}
        existing = cfg.get("bindings") or []

        new_key = _binding_key(normalized)
        replaced = False
        out = []
        for b in existing:
            if isinstance(b, dict) and _binding_key(b) == new_key:
                out.append(normalized)
                replaced = True
            else:
                out.append(b)
        if not replaced:
            out.append(normalized)

        await self._config.patch({"bindings": out})
        await self._restart_gateway()
        log.info(
            "channels_handler: upsert binding (key=%s replaced=%s)", new_key, replaced
        )
        return {"ok": True, "binding": normalized, "replaced": replaced}

    async def delete_binding(self, match_key: dict) -> dict:
        """Delete binding(s) matching the partial key."""
        channel = match_key.get("channel")
        account_id = match_key.get("account_id") or match_key.get("accountId")
        peer = match_key.get("peer")

        cfg = await self._config.get() or {}
        existing = cfg.get("bindings") or []
        target_key = _binding_key({
            "type": "route",
            "agent_id": "*",
            "match": {
                "channel": channel,
                "account_id": account_id,
                "peer": peer,
            },
        })

        remaining = []
        removed_count = 0
        for b in existing:
            if isinstance(b, dict) and _binding_key(b) == target_key:
                removed_count += 1
            else:
                remaining.append(b)

        if removed_count == 0:
            raise ChannelsError("NOT_FOUND", "no binding matched the given key")

        await self._config.patch({"bindings": remaining})
        await self._restart_gateway()
        log.info(
            "channels_handler: deleted %d binding(s) for channel=%s account=%s",
            removed_count, channel, account_id,
        )
        return {"ok": True, "removed": removed_count}


# -------------------------------------------------------------------------
# Free helpers (testable in isolation)
# -------------------------------------------------------------------------


def _binding_key(binding: dict) -> tuple:
    """Generate matching key for binding dedup/lookup."""
    match = binding.get("match") or {}
    peer = match.get("peer") or {}
    return (
        match.get("channel") or "",
        match.get("account_id") or match.get("accountId") or "",
        (peer.get("kind") or "", peer.get("id") or "")
        if isinstance(peer, dict)
        else ("", ""),
    )


def _binding_matches_channel(
    binding: dict,
    channel: str,
    *,
    account_id: Optional[str],
) -> bool:
    """True if binding routes for the given channel (and optional account_id)."""
    if not isinstance(binding, dict):
        return False
    match = binding.get("match") or {}
    if match.get("channel") != channel:
        return False
    if account_id is not None:
        ba = match.get("account_id") or match.get("accountId") or "default"
        if ba != account_id:
            return False
    return True


def _resolve_default_routed_agent(channel: str, bindings: list) -> Optional[str]:
    """Find the agent that handles default (catch-all) routing for a channel."""
    for b in bindings or []:
        if not isinstance(b, dict):
            continue
        match = b.get("match") or {}
        if match.get("channel") != channel:
            continue
        if match.get("peer") or match.get("guild_id") or match.get("team_id"):
            continue
        return b.get("agent_id") or b.get("agentId")
    return None


def _serialize_binding(binding: dict) -> dict:
    """Normalize binding dict for outbound RPC response (camelCase, stable shape)."""
    match = binding.get("match") or {}
    return {
        "type": binding.get("type", "route"),
        "agentId": binding.get("agent_id") or binding.get("agentId"),
        "match": {
            "channel": match.get("channel"),
            "accountId": match.get("account_id") or match.get("accountId"),
            "peer": match.get("peer"),
            "guildId": match.get("guild_id") or match.get("guildId"),
            "teamId": match.get("team_id") or match.get("teamId"),
            "roles": match.get("roles"),
        },
    }
