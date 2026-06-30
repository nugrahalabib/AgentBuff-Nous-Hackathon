"""base_account_adapter.py — shared scaffolding for synthetic-platform adapters.

Each concrete channel adapter (telegram, whatsapp, discord, slack) subclasses
`BaseAccountAdapter`, which itself subclasses Hermes' `BasePlatformAdapter`
(the engine contract verified from plugins/platforms/irc/adapter.py).

Engine contract (4 abstractmethods MUST be implemented by leaf subclass):
    async connect() -> bool
    async disconnect() -> None
    async send(chat_id, content, reply_to=None, metadata=None) -> SendResult
    async get_chat_info(chat_id) -> dict

Inbound path (provided helper, leaf calls it):
    self._dispatch_inbound(text, chat_id, chat_type, user_id, user_name, ...)
        → builds SessionSource via self.build_source(...)
        → builds MessageEvent
        → await self.handle_message(event)   # engine routes to agent

This base does:
  - Parse the synthetic platform name → AccountIdentity (base_channel, account_id)
  - Hold per-account credentials from config.extra
  - Provide a uniform _dispatch_inbound that stamps the event so the
    pre_gateway_dispatch hook (routing.py) can map it to the right agent
    (model + persona + skills). We tag MessageEvent via channel_prompt left
    None here — the HOOK fills persona/model; the adapter only needs to make
    sure the message reaches handle_message with a correct SessionSource whose
    platform is the synthetic name (so session keys are per-account-unique).

Zero hard imports of leaf channel libs — those import lazily in leaf modules.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform

from .account_config import (
    parse_synthetic_name,
    read_account_extra,
    resolve_agent_id,
)

logger = logging.getLogger("agentbuff.multichannel.adapter")


class BaseAccountAdapter(BasePlatformAdapter):
    """Base for one ACCOUNT of a channel, registered under a synthetic platform.

    Subclass __init__ MUST call super().__init__(config) (this class wires the
    Platform + identity); then set up its own library client from
    self.account_extra credentials.
    """

    # Leaf subclasses set this to the human label base, e.g. "Telegram".
    base_label: str = "Channel"

    def __init__(self, config: Any):
        # The synthetic platform name lives on config — the registry created
        # the PlatformConfig keyed by it. We recover it from config.extra
        # (bridge writes base_channel + account_id there) and fall back to
        # parsing if a synthetic_name was stamped.
        extra = read_account_extra(config)
        synthetic = (
            extra.get("synthetic_name")
            or extra.get("platform_name")
            or self._guess_synthetic_from_extra(extra)
        )
        if not synthetic:
            raise ValueError(
                "BaseAccountAdapter: cannot determine synthetic platform name "
                f"from config.extra={list(extra.keys())}"
            )

        identity = parse_synthetic_name(synthetic)
        if identity is None:
            raise ValueError(
                f"BaseAccountAdapter: invalid synthetic name {synthetic!r}"
            )

        # Platform(synthetic) resolves because register_platform already
        # registered the name (Platform._missing_ mints a pseudo-member).
        platform = Platform(synthetic)
        super().__init__(config=config, platform=platform)

        self.identity = identity
        self.account_extra = extra
        # Which agent/profile handles inbound from this account. The hook
        # re-reads this from config too, but we cache it for logging.
        self.agent_id = resolve_agent_id(config, fallback="default")

        logger.info(
            "%s adapter init: synthetic=%s base=%s account=%s agent=%s",
            self.base_label,
            synthetic,
            identity.base_channel,
            identity.account_id,
            self.agent_id,
        )

    @staticmethod
    def _guess_synthetic_from_extra(extra: dict) -> Optional[str]:
        """If extra carries base_channel + account_id, compose the name."""
        base = extra.get("base_channel")
        acc = extra.get("account_id")
        if isinstance(base, str) and isinstance(acc, str) and base and acc:
            return f"{base}__{acc}"
        return None

    @property
    def name(self) -> str:
        return f"{self.base_label}:{self.identity.account_id}"

    # ── Inbound helper — leaf adapters call this on each incoming message ──

    async def _dispatch_inbound(
        self,
        *,
        text: str,
        chat_id: str,
        chat_type: str = "dm",
        user_id: Optional[str] = None,
        user_name: Optional[str] = None,
        message_id: Optional[str] = None,
        guild_id: Optional[str] = None,
        thread_id: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        reply_to_text: Optional[str] = None,
        media_urls: Optional[list] = None,
        media_types: Optional[list] = None,
        raw_message: Any = None,
    ) -> None:
        """Normalize + hand a message to the engine.

        The engine's handle_message → _handle_message will:
          1. fire pre_gateway_dispatch hook (our routing.py sets model +
             channel_prompt + auto_skill keyed by this synthetic platform)
          2. resolve session key (per-account-unique because platform is the
             synthetic name)
          3. run the agent with the per-account persona/model/skills
        """
        if self._message_handler is None:
            logger.warning(
                "%s: no message handler set; dropping inbound", self.name
            )
            return

        source = self.build_source(
            chat_id=str(chat_id),
            chat_name=str(chat_id),
            chat_type=chat_type,
            user_id=str(user_id) if user_id is not None else None,
            user_name=user_name,
            thread_id=thread_id,
            guild_id=guild_id,
            message_id=message_id,
        )

        event = MessageEvent(
            text=text or "",
            message_type=MessageType.TEXT,
            source=source,
            raw_message=raw_message,
            message_id=str(message_id) if message_id is not None else None,
            reply_to_message_id=(
                str(reply_to_message_id) if reply_to_message_id else None
            ),
            media_urls=list(media_urls) if media_urls else [],
            media_types=list(media_types) if media_types else [],
            timestamp=datetime.now(),
        )
        # reply_to_text (text of the replied-to message) lets the engine inject
        # reply context so the agent knows it's being replied to. MessageEvent
        # carries this field (gateway/platforms/base.py); set it post-init so we
        # don't depend on it being a constructor arg across engine versions.
        if reply_to_text:
            try:
                event.reply_to_text = reply_to_text
            except Exception:
                pass

        try:
            await self.handle_message(event)
        except Exception:
            logger.exception("%s: handle_message failed", self.name)

    @staticmethod
    def _coerce_bool(value: Any, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, str):
            return value.strip().lower() in {"true", "1", "yes", "on"}
        return bool(value)

    def _group_require_mention(self) -> bool:
        """Whether multi-user (group/channel/guild) chats require the bot to be
        explicitly addressed (mention / reply-to-bot / command) before it
        responds. Mass-market default True so the bot never spams a busy group.
        Read from this account's config.extra (set at pair time)."""
        extra = getattr(self.config, "extra", None) or {}
        return self._coerce_bool(extra.get("require_mention"), True)

    # ── Default get_chat_info — leaf may override for richer info ──

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "dm"}

    # connect / disconnect / send remain abstract — leaf MUST implement.
