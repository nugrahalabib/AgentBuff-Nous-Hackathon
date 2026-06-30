"""adapter_native_wrap.py — generic per-account wrapper for native Hermes adapters.

Most native Hermes channel adapters are uniform:
    class XAdapter(BasePlatformAdapter):
        def __init__(self, config): super().__init__(config, Platform.X)
and read credentials as `config.extra.get("x") or os.getenv("X")`.

So a per-account synthetic platform = SUBCLASS the native adapter, inject the
per-account `config.extra`, and override `self.platform` to the synthetic name
AFTER super().__init__ (the exact pattern proven for WhatsApp + Telegram). The
native connect/disconnect/send/get_chat_info are inherited verbatim and now key
their sessions/locks on the synthetic platform value → per-account-unique, N
instances coexist in ONE process.

This factory wraps ANY native adapter class from a (module, class) spec, so all
"clean" channels (poll / WebSocket / TCP — no public URL needed) are covered
compactly. Webhook channels (line/teams/sms/...) need public ingress and are
handled separately (Phase CE). Email is env-only and gets a bespoke adapter
(Phase CA2).

Guarded: a channel whose native module or optional library is missing simply
doesn't register (logged) — the rest keep working.
"""

from __future__ import annotations

import importlib
import logging
from typing import Any, Optional

from .account_config import (
    parse_synthetic_name,
    read_account_extra,
    resolve_agent_id,
)

logger = logging.getLogger("agentbuff.multichannel.native")


# base_channel -> (module_path, class_name, human_label, emoji)
# Only CLEAN channels (poll/WS/TCP, no public-URL requirement) belong here.
_NATIVE_SPECS: dict[str, tuple[str, str, str, str]] = {
    "matrix": ("gateway.platforms.matrix", "MatrixAdapter", "Matrix", "🔗"),
    "mattermost": ("gateway.platforms.mattermost", "MattermostAdapter", "Mattermost", "💬"),
    "dingtalk": ("gateway.platforms.dingtalk", "DingTalkAdapter", "DingTalk", "📌"),
    "feishu": ("gateway.platforms.feishu", "FeishuAdapter", "Feishu", "🪶"),
    "wecom": ("gateway.platforms.wecom", "WeComAdapter", "WeCom", "🏢"),
    "weixin": ("gateway.platforms.weixin", "WeixinAdapter", "Weixin", "🟢"),
    "yuanbao": ("gateway.platforms.yuanbao", "YuanbaoAdapter", "Yuanbao", "🧧"),
    "homeassistant": ("gateway.platforms.homeassistant", "HomeAssistantAdapter", "Home Assistant", "🏠"),
    "qqbot": ("gateway.platforms.qqbot.adapter", "QQAdapter", "QQ", "🐧"),
    "google_chat": ("plugins.platforms.google_chat.adapter", "GoogleChatAdapter", "Google Chat", "💼"),
    "irc": ("plugins.platforms.irc.adapter", "IRCAdapter", "IRC", "📟"),
}


def _pre_register_lazy_platform(
    base_channel: str, module_path: str, class_name: str
) -> None:
    """Pre-register a plugin-platform NAME so its adapter module can import.

    Some bundled platform adapters (e.g. google_chat) call ``Platform(name)`` at
    MODULE-LOAD time. ``Platform._missing_`` only mints that pseudo-member if the
    name is already in ``platform_registry`` — but the registration lives INSIDE
    the very module we need to import (chicken-egg), and Hermes never loads that
    plugin in our per-user container. We register a lazy placeholder entry first
    so the import succeeds. Registry is last-writer-wins, so if Hermes ever loads
    the real google_chat plugin it cleanly overrides this with the full entry.
    """
    from gateway.platform_registry import PlatformEntry, platform_registry

    if platform_registry.is_registered(base_channel):
        return

    def _lazy_factory(cfg: Any):
        return getattr(importlib.import_module(module_path), class_name)(cfg)

    platform_registry.register(
        PlatformEntry(
            name=base_channel,
            label=base_channel,
            adapter_factory=_lazy_factory,
            check_fn=(lambda: True),
            source="plugin",
            plugin_name="agentbuff-multichannel",
        )
    )
    logger.info(
        "native-wrap: pre-registered lazy base platform %s (import chicken-egg)",
        base_channel,
    )


def _load_native(base_channel: str, module_path: str, class_name: str):
    try:
        mod = importlib.import_module(module_path)
    except ValueError as e:
        # Plugin-platform adapter referenced Platform(<name>) at import time
        # before the name was registered. Pre-register a lazy entry, then retry.
        if "not a valid Platform" in str(e):
            _pre_register_lazy_platform(base_channel, module_path, class_name)
            mod = importlib.import_module(module_path)
        else:
            raise
    return getattr(mod, class_name)


def make_native_account_adapter(
    base_channel: str, module_path: str, class_name: str, label: str
):
    """Build a per-account adapter class that subclasses the native adapter.

    Raises ImportError/AttributeError if the native module/class is unavailable
    (caller guards with try/except so the channel is simply skipped).
    """
    native_cls = _load_native(base_channel, module_path, class_name)
    from gateway.config import Platform

    class _NativeAccountAdapter(native_cls):  # type: ignore[valid-type, misc]
        base_label = label

        def __init__(self, config: Any):
            extra = read_account_extra(config)
            synthetic = (
                extra.get("synthetic_name")
                or extra.get("platform_name")
                or self._guess_synthetic(extra)
            )
            identity = parse_synthetic_name(synthetic) if synthetic else None
            if identity is None:
                raise ValueError(
                    f"{label} account adapter: invalid/missing synthetic name "
                    f"{synthetic!r} (extra keys: {list(extra.keys())})"
                )

            # Native __init__ sets self.platform = Platform.<BASE> and reads
            # config.extra for its creds. We override the platform identity
            # AFTER so session keys + the routing hook are per-account-unique.
            super().__init__(config)
            try:
                self.platform = Platform(synthetic)
            except Exception:
                logger.warning(
                    "%s: could not set synthetic platform %s", label, synthetic
                )

            self.identity = identity
            self.account_extra = extra
            self.agent_id = resolve_agent_id(config, fallback="default")
            logger.info(
                "%s account adapter init: synthetic=%s account=%s agent=%s",
                label, synthetic, identity.account_id, self.agent_id,
            )

        @staticmethod
        def _guess_synthetic(extra: dict) -> Optional[str]:
            base = extra.get("base_channel")
            acc = extra.get("account_id")
            if isinstance(base, str) and isinstance(acc, str) and base and acc:
                return f"{base}__{acc}"
            return None

        @property
        def name(self) -> str:  # type: ignore[override]
            return f"{label}:{self.identity.account_id}"

    _NativeAccountAdapter.__name__ = f"{class_name}Account"
    _NativeAccountAdapter.__qualname__ = _NativeAccountAdapter.__name__
    return _NativeAccountAdapter


def build_native_registry() -> dict[str, dict]:
    """Return {base_channel: {adapter_cls, label, check_fn, validate_config, emoji}}
    for every native adapter that imports cleanly. Channels whose native module
    or optional lib is missing are skipped (logged), never crash the plugin.
    """
    out: dict[str, dict] = {}
    for base, (module_path, class_name, label, emoji) in _NATIVE_SPECS.items():
        try:
            adapter_cls = make_native_account_adapter(
                base, module_path, class_name, label
            )
        except Exception as e:  # ImportError (missing lib), AttributeError, etc.
            logger.warning(
                "native-wrap: %s unavailable (%s: %s)",
                base, type(e).__name__, e,
            )
            continue
        out[base] = {
            "adapter_cls": adapter_cls,
            "label": label,
            # check/validate are best-effort — the native adapter validates its
            # own creds at connect(); registry gating only needs import success.
            "check_fn": (lambda: True),
            "validate_config": None,
            "emoji": emoji,
        }
    return out
