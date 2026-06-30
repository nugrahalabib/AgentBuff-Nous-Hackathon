"""account_config.py — synthetic-platform naming + per-account config read.

A "synthetic platform" is how AgentBuff runs N accounts of one channel type
in a single Hermes process. Each account becomes its own registered platform
name so the engine's adapter dict (keyed by Platform enum) can hold them
side by side.

Naming convention (CRITICAL — keep stable, the bridge writes config using it):

    <base_channel>__<account_id>

  e.g.  telegram__cs       telegram__sales
        whatsapp__toko1    discord__guildA

Double underscore separates base channel from account id. We pick "__" because:
  - Platform._missing_ uppercases + replaces "-"/" " with "_" for the enum
    member NAME; "__" survives as a clean, reversible delimiter in the VALUE.
  - account_id is validated lowercase alphanumeric + single hyphens, so "__"
    can never appear inside an account_id and split is unambiguous.

Config location (config.yaml):

    gateway:
      platforms:
        telegram__cs:
          enabled: true
          extra:
            base_channel: telegram
            account_id: cs
            agent_id: cs            # which Hermes profile/persona handles this
            bot_token: "123:abc"     # channel-specific credential(s)
    bindings: []   # optional fine-grained routing (peer/group level)

This module ONLY parses + validates. No I/O side effects beyond reading the
config file the gateway already loaded into PlatformConfig.extra.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


# account_id: lowercase, alphanumeric + internal single hyphens, 1-40 chars.
# Must NOT contain "__" (our delimiter) — guaranteed by this pattern.
_ACCOUNT_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")

# Base channels we support multi-account for. Mirrors PER_CHANNEL_PAIR_SCHEMA
# in the bridge channels_handler. Keep in lock-step.
SUPPORTED_BASE_CHANNELS = frozenset(
    {
        # Phase R — token/QR adapters (proven)
        "telegram",
        "whatsapp",
        "discord",
        "slack",
        # Phase CA1 — clean per-account (poll/WS/TCP) via native-wrap factory
        "matrix",
        "mattermost",
        "dingtalk",
        "feishu",
        "wecom",
        "weixin",
        "yuanbao",
        "homeassistant",
        "qqbot",
        "google_chat",
        "irc",
        # Phase CA2
        "email",
        # Phase CE — webhook (need public ingress to RECEIVE; registered when built)
        "line",
        "teams",
        "sms",
        "msgraph_webhook",
        "wecom_callback",
        "bluebubbles",
        "webhook",
        # Phase CF — daemon-backed
        "signal",
        "simplex",
    }
)

# Delimiter between base channel and account id in the synthetic platform name.
DELIM = "__"


@dataclass(frozen=True)
class AccountIdentity:
    """Parsed identity of a synthetic platform name."""

    synthetic_name: str   # e.g. "telegram__cs"
    base_channel: str     # e.g. "telegram"
    account_id: str       # e.g. "cs"


def make_synthetic_name(base_channel: str, account_id: str) -> str:
    """Compose a synthetic platform name. Raises ValueError on invalid input."""
    base = (base_channel or "").strip().lower()
    acc = (account_id or "").strip().lower()
    if base not in SUPPORTED_BASE_CHANNELS:
        raise ValueError(f"unsupported base channel: {base_channel!r}")
    if not _ACCOUNT_ID_RE.match(acc):
        raise ValueError(
            f"invalid account_id {account_id!r} — must be lowercase "
            f"alphanumeric + single hyphens, 1-40 chars"
        )
    return f"{base}{DELIM}{acc}"


def parse_synthetic_name(name: str) -> Optional[AccountIdentity]:
    """Reverse make_synthetic_name. Returns None if `name` isn't synthetic."""
    if not isinstance(name, str) or DELIM not in name:
        return None
    base, _, acc = name.partition(DELIM)
    base = base.strip().lower()
    acc = acc.strip().lower()
    if base not in SUPPORTED_BASE_CHANNELS:
        return None
    if not _ACCOUNT_ID_RE.match(acc):
        return None
    return AccountIdentity(synthetic_name=name, base_channel=base, account_id=acc)


def read_account_extra(config) -> dict:
    """Pull the `extra` dict from a PlatformConfig defensively."""
    extra = getattr(config, "extra", None)
    return extra if isinstance(extra, dict) else {}


def resolve_agent_id(config, fallback: str = "default") -> str:
    """Read which agent/profile should handle this account's messages.

    Order: extra.agent_id → extra.agentId → fallback.
    """
    extra = read_account_extra(config)
    cand = extra.get("agent_id") or extra.get("agentId")
    if isinstance(cand, str) and cand.strip():
        return cand.strip()
    return fallback
