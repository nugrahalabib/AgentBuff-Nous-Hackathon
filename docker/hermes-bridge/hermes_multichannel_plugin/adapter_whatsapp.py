"""adapter_whatsapp.py — one WhatsApp account as a synthetic platform.

WA is special: no pure-Python lib. Hermes' native WhatsAppAdapter spawns a
Node.js Baileys bridge subprocess + talks HTTP to it. Re-implementing that
protocol would be fragile, so we SUBCLASS Hermes' own WhatsAppAdapter and:
  1. Inject per-account bridge_port + session_path into config.extra so each
     account gets its OWN Node subprocess + session dir (no collision).
  2. Override the platform identity to the synthetic name (telegram-style)
     so session keys + routing are per-account-unique.

This reuses Hermes' entire battle-tested Baileys pipeline (QR pairing, poll,
send, media) while giving us multi-account isolation in one process.

Credentials / config.extra:
    account_id   — used to derive a stable port + session dir
    bridge_port  — optional explicit port (else auto from account hash)
    session_path — optional explicit path (else ~/.hermes/wa-sessions/<account>)

CAVEAT: each WA account = one Node+Chromium subprocess ≈ 100-200 MB RAM.
Mass-market container (2 GB) supports ~3-5 WA accounts. Enforced upstream.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .account_config import parse_synthetic_name, read_account_extra, resolve_agent_id

logger = logging.getLogger("agentbuff.multichannel.whatsapp")

try:
    from gateway.platforms.whatsapp import WhatsAppAdapter as _NativeWA
    from gateway.config import Platform
    _WA_OK = True
    _WA_ERR = None
except Exception as _e:  # pragma: no cover
    _NativeWA = object  # type: ignore
    _WA_OK = False
    _WA_ERR = _e


# Port range for per-account WA bridges. 34000-34999 — clear of bridge(18789),
# dashboard(28800+), media(38800+), and any other multichannel webhook ports.
_WA_PORT_BASE = 34000
_WA_PORT_SPAN = 1000


def _derive_port(account_id: str) -> int:
    """Stable, collision-resistant port from account_id (deterministic so a
    restart reuses the same port → bridge session continuity)."""
    h = 0
    for ch in account_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return _WA_PORT_BASE + (h % _WA_PORT_SPAN)


class WhatsAppAccountAdapter(_NativeWA):  # type: ignore[misc]
    """Per-account WA adapter = Hermes native WhatsAppAdapter with synthetic
    platform identity + per-account port/session injected."""

    base_label = "WhatsApp"

    def __init__(self, config: Any):
        if not _WA_OK:
            raise RuntimeError(f"whatsapp adapter: native WA unavailable ({_WA_ERR})")

        extra = read_account_extra(config)
        synthetic = (
            extra.get("synthetic_name")
            or extra.get("platform_name")
            or self._guess_synthetic(extra)
        )
        identity = parse_synthetic_name(synthetic) if synthetic else None
        if identity is None:
            raise ValueError(
                f"whatsapp adapter: invalid/missing synthetic name {synthetic!r}"
            )

        account_id = identity.account_id

        # Inject per-account port + session BEFORE native __init__ reads extra.
        if not extra.get("bridge_port"):
            extra["bridge_port"] = _derive_port(account_id)
        if not extra.get("session_path"):
            home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
            extra["session_path"] = str(
                Path(home) / "wa-sessions" / account_id
            )
        # Point the native WA adapter at OUR baked Baileys bridge (the Hermes
        # pip wheel ships none → default path is missing). Same script the
        # pairing manager uses, so the runtime adapter reuses the paired session.
        if not extra.get("bridge_script"):
            extra["bridge_script"] = os.environ.get(
                "WA_BRIDGE_SCRIPT", "/app/bridge/whatsapp-bridge/bridge.js"
            )
        # Ensure config.extra reflects our injected values (native reads config.extra)
        try:
            config.extra = extra
        except Exception:
            pass

        # Native __init__ sets self.platform = Platform.WHATSAPP — we override
        # after to the synthetic name so routing/session keys are per-account.
        super().__init__(config)

        try:
            self.platform = Platform(synthetic)
        except Exception:
            logger.warning(
                "whatsapp[%s]: could not set synthetic platform %s",
                account_id, synthetic,
            )

        self.identity = identity
        self.account_extra = extra
        self.agent_id = resolve_agent_id(config, fallback="default")
        logger.info(
            "whatsapp adapter init: synthetic=%s account=%s port=%s session=%s agent=%s",
            synthetic, account_id, extra.get("bridge_port"),
            extra.get("session_path"), self.agent_id,
        )

    @staticmethod
    def _guess_synthetic(extra: dict):
        base = extra.get("base_channel")
        acc = extra.get("account_id")
        if isinstance(base, str) and isinstance(acc, str) and base and acc:
            return f"{base}__{acc}"
        return None

    # Native connect/disconnect/send/get_chat_info/_poll_messages all inherited.
    # Because we overrode self.platform to the synthetic name, every
    # MessageEvent the native poller builds via self.build_source carries the
    # synthetic platform → session keys + the pre_gateway_dispatch routing hook
    # resolve per-account automatically. No further override needed.


def check_requirements() -> bool:
    # Native WA also needs Node + bridge script; it self-reports at connect().
    # For registry gating we only require the import to succeed.
    return _WA_OK


def validate_config(config) -> bool:
    # WA has no token to validate pre-connect (QR-based). Accept if we can
    # parse a synthetic name; native adapter reports pairing state at connect.
    extra = getattr(config, "extra", {}) or {}
    syn = (
        extra.get("synthetic_name")
        or extra.get("platform_name")
        or (
            f"{extra.get('base_channel')}__{extra.get('account_id')}"
            if extra.get("base_channel") and extra.get("account_id")
            else None
        )
    )
    return parse_synthetic_name(syn) is not None if syn else False
