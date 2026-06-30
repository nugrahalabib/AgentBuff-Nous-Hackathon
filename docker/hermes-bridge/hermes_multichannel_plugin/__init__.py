"""agentbuff-multichannel — per-agen multi-channel for Hermes 0.14.

Entry point: register(ctx) called by Hermes plugin loader at gateway startup.

Two things happen here:
  1. Register the pre_gateway_dispatch hook (routing.py) — maps inbound from
     synthetic platforms to the right agent's model + persona + skills.
  2. Scan config.yaml::gateway.platforms for synthetic platform names
     (<base>__<account>) and register each with the platform_registry via
     ctx.register_platform(), wiring the correct concrete adapter factory.

CONTRACT (verified from plugins/platforms/irc/adapter.py + spike 2026-05-30):
  ctx.register_platform(name=, label=, adapter_factory=lambda cfg: Adapter(cfg),
                        check_fn=, validate_config=, required_env=[], **kwargs)
  - adapter_factory: callable(PlatformConfig) -> BasePlatformAdapter subclass
  - Platform(name) becomes valid via Platform._missing_ once registered
  - _create_adapter (run.py:5279) checks platform_registry FIRST

Defensive: every channel registration wrapped in try/except so one bad account
never sabotages the others or aborts gateway boot.

Survives `pip install --upgrade hermes-agent` — lives in $HERMES_HOME/plugins/.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("agentbuff.multichannel")

# Base channels whose engine adapter gates inbound by SENDER ID (so a
# per-account allowlist is meaningful). Keep in sync with
# channels_handler._CHANNEL_ALLOW_ENV on the bridge side.
_ALLOWLIST_CAPABLE_CHANNELS = frozenset({"telegram", "discord", "slack", "whatsapp"})


def _synthetic_allow_env(synthetic_name: str) -> str:
    """Per-synthetic-platform allowlist env var name. MUST match
    channels_handler._synthetic_allow_env on the bridge side byte-for-byte:
    uppercase, non-alnum -> "_", append "_ALLOWED_USERS".
    e.g. "telegram__cs" -> "TELEGRAM__CS_ALLOWED_USERS"."""
    safe = re.sub(r"[^A-Z0-9]", "_", synthetic_name.upper())
    return f"{safe}_ALLOWED_USERS"

# Map base channel → (adapter module attr, label, check_fn, validate_config).
# Concrete adapters land per-channel (R2 telegram now; R4 wa/discord/slack).
# Channels not yet implemented are simply absent from this map → their config
# entries are skipped with a clear log line (no crash).
_CHANNEL_REGISTRY: dict[str, dict] = {}


def _register_builtin_channels() -> None:
    """Populate _CHANNEL_REGISTRY with implemented channel adapters.

    Imports are lazy + guarded: a channel whose library is missing simply
    doesn't register (logged), the rest keep working.
    """
    # Telegram (R2)
    try:
        from .adapter_telegram import (
            TelegramAccountAdapter,
            check_requirements as tg_check,
            validate_config as tg_validate,
        )
        _CHANNEL_REGISTRY["telegram"] = {
            "adapter_cls": TelegramAccountAdapter,
            "label": "Telegram",
            "check_fn": tg_check,
            "validate_config": tg_validate,
            "emoji": "📨",
        }
    except Exception as e:
        logger.warning("multichannel: telegram adapter unavailable: %s", e)

    # Discord (R4)
    try:
        from .adapter_discord import (
            DiscordAccountAdapter,
            check_requirements as dc_check,
            validate_config as dc_validate,
        )
        _CHANNEL_REGISTRY["discord"] = {
            "adapter_cls": DiscordAccountAdapter,
            "label": "Discord",
            "check_fn": dc_check,
            "validate_config": dc_validate,
            "emoji": "🎮",
        }
    except Exception as e:
        logger.warning("multichannel: discord adapter unavailable: %s", e)

    # Slack (R4)
    try:
        from .adapter_slack import (
            SlackAccountAdapter,
            check_requirements as sl_check,
            validate_config as sl_validate,
        )
        _CHANNEL_REGISTRY["slack"] = {
            "adapter_cls": SlackAccountAdapter,
            "label": "Slack",
            "check_fn": sl_check,
            "validate_config": sl_validate,
            "emoji": "💼",
        }
    except Exception as e:
        logger.warning("multichannel: slack adapter unavailable: %s", e)

    # WhatsApp (R4) — subclasses native WhatsAppAdapter (Node bridge per account)
    try:
        from .adapter_whatsapp import (
            WhatsAppAccountAdapter,
            check_requirements as wa_check,
            validate_config as wa_validate,
        )
        _CHANNEL_REGISTRY["whatsapp"] = {
            "adapter_cls": WhatsAppAccountAdapter,
            "label": "WhatsApp",
            "check_fn": wa_check,
            "validate_config": wa_validate,
            "emoji": "💬",
        }
    except Exception as e:
        logger.warning("multichannel: whatsapp adapter unavailable: %s", e)

    # Email (Phase CA2) — bespoke per-account adapter. The native EmailAdapter
    # reads creds from ENV, so the generic native-wrap can't make it per-account;
    # adapter_email subclasses it + overrides creds from config.extra. IMAP/SMTP
    # outbound only → works on a loopback container (no public webhook ingress).
    try:
        from .adapter_email import (
            EmailAccountAdapter,
            check_requirements as em_check,
            validate_config as em_validate,
        )
        if EmailAccountAdapter is not None:
            _CHANNEL_REGISTRY["email"] = {
                "adapter_cls": EmailAccountAdapter,
                "label": "Email",
                "check_fn": em_check,
                "validate_config": em_validate,
                "emoji": "📧",
            }
    except Exception as e:
        logger.warning("multichannel: email adapter unavailable: %s", e)

    # Phase CA1 — clean per-account channels (matrix, mattermost, dingtalk,
    # feishu, wecom, weixin, yuanbao, homeassistant, qqbot, google_chat, irc)
    # via the generic native-wrap factory. setdefault so the bespoke adapters
    # above (telegram/discord/slack/whatsapp) always win over a generic wrap.
    try:
        from .adapter_native_wrap import build_native_registry
        for base, spec in build_native_registry().items():
            _CHANNEL_REGISTRY.setdefault(base, spec)
    except Exception as e:
        logger.warning("multichannel: native-wrap registry unavailable: %s", e)


def _hermes_home() -> Path:
    h = os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _scan_synthetic_platforms() -> list[dict]:
    """Read config.yaml::gateway.platforms for synthetic platform entries.

    Returns list of {synthetic_name, base_channel, account_id, extra}.
    Only entries whose name parses as <base>__<account> AND base is in
    _CHANNEL_REGISTRY are returned.
    """
    from .account_config import parse_synthetic_name

    out: list[dict] = []
    cfg_path = _hermes_home() / "config.yaml"
    try:
        import yaml
        if not cfg_path.is_file():
            return out
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        logger.warning("multichannel: config.yaml read failed", exc_info=True)
        return out

    # Merge BOTH sources: `gateway.platforms` AND top-level `platforms`.
    # The bridge writes synthetic entries to TOP-LEVEL `platforms` (where
    # load_gateway_config merges them into the gateway block). Native gateway
    # settings may also live under `gateway.platforms`. Scanning the union is
    # robust regardless of which section holds the synthetic entry — an
    # either-or check would silently miss top-level entries the moment
    # `gateway.platforms` had any unrelated key.
    gw = data.get("gateway") if isinstance(data.get("gateway"), dict) else {}
    platforms: dict = {}
    if isinstance(gw.get("platforms"), dict):
        platforms.update(gw["platforms"])
    if isinstance(data.get("platforms"), dict):
        platforms.update(data["platforms"])

    for name, block in platforms.items():
        ident = parse_synthetic_name(name)
        if ident is None:
            continue
        if ident.base_channel not in _CHANNEL_REGISTRY:
            logger.info(
                "multichannel: skip %s — no adapter for base channel %s",
                name, ident.base_channel,
            )
            continue
        extra = {}
        if isinstance(block, dict):
            extra = block.get("extra") if isinstance(block.get("extra"), dict) else {}
        out.append(
            {
                "synthetic_name": name,
                "base_channel": ident.base_channel,
                "account_id": ident.account_id,
                "extra": extra,
            }
        )
    return out


def _make_factory(adapter_cls: Callable, synthetic_name: str) -> Callable:
    """Build an adapter_factory closure that stamps the synthetic name into
    config.extra so the adapter can recover its identity.
    """
    def _factory(cfg: Any):
        # Ensure extra carries the synthetic name (defensive — bridge already
        # writes base_channel/account_id, but stamp synthetic_name too).
        try:
            extra = getattr(cfg, "extra", None)
            if isinstance(extra, dict):
                extra.setdefault("synthetic_name", synthetic_name)
        except Exception:
            pass
        return adapter_cls(cfg)

    return _factory


def _write_brand_scrub_status(native_patched, plugin_patched, plugin_classes, aux_patched=None) -> None:
    """Write a per-PID JSON proof that the brand scrub installed in THIS process.

    The gateway-runtime subprocess (which sends channel messages) suppresses
    this plugin's logging, so logs can't confirm the wrap there. This file —
    in the shared HERMES_HOME volume — lets us verify install from outside,
    per process, including the LIVE sentinel state of each synthetic adapter's
    send(). Best-effort: never raise.
    """
    try:
        import json
        from .outbound_brand import _PATCH_SENTINEL

        adapters = {}
        for cls in plugin_classes or []:
            try:
                own = cls.__dict__.get("send")
                adapters[getattr(cls, "__name__", str(cls))] = bool(
                    own is not None and getattr(own, _PATCH_SENTINEL, False)
                )
            except Exception:
                pass

        try:
            with open("/proc/self/cmdline", "rb") as fh:
                cmdline = fh.read().replace(b"\x00", b" ").decode("utf-8", "ignore").strip()
        except Exception:
            cmdline = ""

        record = {
            "pid": os.getpid(),
            "cmdline": cmdline,
            "native_send_patched": native_patched,
            "plugin_send_wrapped": plugin_patched,
            "aux_text_methods_wrapped": aux_patched,
            "synthetic_adapter_send_wrapped": adapters,
        }
        home = _hermes_home()
        # Self-maintain: drop status files for PIDs that no longer exist so the
        # volume doesn't accumulate one stale file per past restart.
        try:
            for old in home.glob(".agentbuff_brand_scrub_*.json"):
                try:
                    old_pid = int(old.stem.rsplit("_", 1)[-1])
                except (ValueError, IndexError):
                    continue
                if old_pid == os.getpid():
                    continue
                if not os.path.exists(f"/proc/{old_pid}"):
                    old.unlink(missing_ok=True)
        except Exception:
            pass
        (home / f".agentbuff_brand_scrub_{os.getpid()}.json").write_text(
            json.dumps(record, indent=2), encoding="utf-8"
        )
    except Exception:
        logger.debug("multichannel: brand-scrub status write failed", exc_info=True)


def register(ctx) -> None:
    """Plugin entry point."""
    _register_builtin_channels()

    # 0. Outbound brand scrub — wrap every platform adapter's send() so the
    # engine brand (Hermes/Nous/OpenClaw) never leaks in ANY channel message
    # (agent prose, tool-progress cards, command labels, paths). Channel-only;
    # the web /app path is handled separately. Fail-open + path/MEDIA-protected.
    try:
        from .outbound_brand import (
            install_outbound_brand_scrub,
            wrap_adapter_classes,
            install_aux_text_scrub,
        )
        native_patched = install_outbound_brand_scrub()
        # Native adapters' caption/content/edit methods bypass send() (e.g. WA
        # media captions hit the Baileys bridge directly). Scrub their text
        # kwargs too — path/URL-safe.
        aux_patched = install_aux_text_scrub()
        # CRITICAL: our synthetic per-account adapters (telegram/discord/slack)
        # define their OWN send() in this plugin package — NOT under
        # gateway.platforms.* — so install_outbound_brand_scrub (which scans only
        # gateway.platforms.*) never wraps them and the engine brand leaks raw on
        # those channels. Wrap every plugin adapter class that defines its own
        # send. Classes that INHERIT the native (already-wrapped) send are
        # skipped automatically (sentinel + own-send check).
        plugin_adapter_classes = [
            spec.get("adapter_cls")
            for spec in _CHANNEL_REGISTRY.values()
            if spec.get("adapter_cls") is not None
        ]
        plugin_patched = wrap_adapter_classes(plugin_adapter_classes)
        # The gateway-runtime subprocess (the one that actually sends channel
        # messages) suppresses this plugin's logging entirely, so a log line is
        # invisible there. Write a per-PID status file into HERMES_HOME (shared
        # volume) so install can be VERIFIED in any process from outside.
        _write_brand_scrub_status(
            native_patched, plugin_patched, plugin_adapter_classes, aux_patched
        )
    except Exception:
        logger.exception("multichannel: outbound brand scrub install failed (non-fatal)")

    # 1. Hook — always register, even if zero channels configured yet.
    try:
        from .routing import on_pre_gateway_dispatch
        ctx.register_hook("pre_gateway_dispatch", on_pre_gateway_dispatch)
        logger.info("multichannel: pre_gateway_dispatch hook registered")
    except Exception:
        logger.exception("multichannel: hook registration failed")

    # 2. Synthetic platforms from config.
    entries = _scan_synthetic_platforms()
    registered = 0
    for entry in entries:
        spec = _CHANNEL_REGISTRY.get(entry["base_channel"])
        if spec is None:
            continue
        name = entry["synthetic_name"]
        # Sender-gated channels get a per-account allowlist env so the engine's
        # _is_user_authorized restricts each account independently. The bridge
        # writes this same env at pair time (channels_handler._pair_synthetic).
        extra_entry_kwargs: dict[str, Any] = {}
        if entry["base_channel"] in _ALLOWLIST_CAPABLE_CHANNELS:
            extra_entry_kwargs["allowed_users_env"] = _synthetic_allow_env(name)
        try:
            ctx.register_platform(
                name=name,
                label=f"{spec['label']} ({entry['account_id']})",
                adapter_factory=_make_factory(spec["adapter_cls"], name),
                check_fn=spec["check_fn"],
                validate_config=spec.get("validate_config"),
                required_env=[],
                install_hint=f"AgentBuff {spec['label']} account {entry['account_id']}",
                emoji=spec.get("emoji", "📡"),
                **extra_entry_kwargs,
            )
            registered += 1
            logger.info("multichannel: registered platform %s", name)
        except Exception:
            logger.exception(
                "multichannel: register_platform failed for %s", name
            )

    logger.info(
        "multichannel: ready — %d synthetic platform(s) registered, "
        "%d base channel(s) available",
        registered, len(_CHANNEL_REGISTRY),
    )
