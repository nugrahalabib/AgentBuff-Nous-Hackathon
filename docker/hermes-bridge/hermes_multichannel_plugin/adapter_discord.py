"""adapter_discord.py — one Discord bot account as a synthetic platform.

Subclasses BaseAccountAdapter. Wraps ONE discord.py commands.Bot per token.
discord.py Bot is instance-scoped (own aiohttp session + websocket) so N
instances coexist in one process.

Lifecycle:
    connect():   build Bot → asyncio.create_task(bot.start(token)) → wait ready
    disconnect(): await bot.close() → cancel task

Credentials (config.extra):
    bot_token (required) — Discord bot token

Inbound: @bot.event on_message → _dispatch_inbound
Outbound: send() → channel.send
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from gateway.platforms.base import SendResult

from .base_account_adapter import BaseAccountAdapter

logger = logging.getLogger("agentbuff.multichannel.discord")

try:
    import discord
    from discord.ext import commands
    _DISCORD_OK = True
    _DISCORD_ERR = None
except Exception as _e:  # pragma: no cover
    discord = None  # type: ignore
    commands = None  # type: ignore
    _DISCORD_OK = False
    _DISCORD_ERR = _e


class DiscordAccountAdapter(BaseAccountAdapter):
    base_label = "Discord"

    def __init__(self, config: Any):
        super().__init__(config)
        if not _DISCORD_OK:
            raise RuntimeError(
                f"discord adapter: discord.py not importable ({_DISCORD_ERR})"
            )
        token = (
            self.account_extra.get("bot_token")
            or self.account_extra.get("botToken")
            or self.account_extra.get("token")
        )
        if not isinstance(token, str) or len(token) < 20:
            raise ValueError(
                f"discord adapter [{self.identity.account_id}]: missing/invalid bot_token"
            )
        self._token = token
        self._bot: Optional["commands.Bot"] = None
        self._run_task: Optional[asyncio.Task] = None
        self._ready_evt: Optional[asyncio.Event] = None

    async def connect(self) -> bool:
        try:
            if not self._acquire_platform_lock(
                "discord-bot-token", self._token, "Discord bot token"
            ):
                self._set_fatal_error(
                    "lock_conflict",
                    "Discord bot token already in use by another profile",
                    retryable=False,
                )
                return False
        except Exception:
            pass

        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.members = False
        prefix = self.account_extra.get("command_prefix") or "!"

        try:
            self._bot = commands.Bot(
                command_prefix=prefix, intents=intents, help_command=None
            )
        except Exception as e:
            self._set_fatal_error("build_failed", str(e), retryable=True)
            return False

        self._ready_evt = asyncio.Event()
        adapter = self
        bot = self._bot

        @bot.event
        async def on_ready():
            try:
                adapter._ready_evt.set()
                logger.info(
                    "discord[%s]: connected as %s",
                    adapter.identity.account_id,
                    bot.user,
                )
            except Exception:
                pass

        @bot.event
        async def on_message(message):
            try:
                if bot.user and message.author.id == bot.user.id:
                    return  # ignore self
                await adapter._handle_discord_message(message)
            except Exception:
                logger.exception(
                    "discord[%s]: on_message failed", adapter.identity.account_id
                )

        self._run_task = asyncio.create_task(self._run_bot())

        # Wait up to 30s for on_ready (login + gateway handshake).
        try:
            await asyncio.wait_for(self._ready_evt.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            logger.warning(
                "discord[%s]: ready timeout (token invalid or network?)",
                self.identity.account_id,
            )
            self._set_fatal_error(
                "ready_timeout", "Discord did not reach ready", retryable=True
            )
            await self._safe_teardown()
            return False

        self._mark_connected()
        return True

    async def _run_bot(self) -> None:
        try:
            await self._bot.start(self._token)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception(
                "discord[%s]: bot.start raised — connection lost",
                self.identity.account_id,
            )

    async def disconnect(self) -> None:
        self._mark_disconnected()
        await self._safe_teardown()
        try:
            self._release_platform_lock()
        except Exception:
            pass

    async def _safe_teardown(self) -> None:
        if self._bot is not None:
            try:
                await self._bot.close()
            except Exception:
                logger.debug(
                    "discord[%s]: close failed", self.identity.account_id,
                    exc_info=True,
                )
        if self._run_task is not None and not self._run_task.done():
            self._run_task.cancel()
            try:
                await self._run_task
            except (asyncio.CancelledError, Exception):
                pass
        self._run_task = None
        self._bot = None

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if self._bot is None:
            return SendResult(success=False, error="not connected", retryable=True)
        try:
            cid = int(chat_id)
            channel = self._bot.get_channel(cid)
            if channel is None:
                channel = await self._bot.fetch_channel(cid)
            sent = await channel.send(content)
            return SendResult(success=True, message_id=str(sent.id))
        except Exception as e:
            logger.exception(
                "discord[%s]: send failed", self.identity.account_id
            )
            return SendResult(success=False, error=str(e)[:300], retryable=True)

    async def _handle_discord_message(self, message) -> None:
        text = message.content or ""
        is_guild = message.guild is not None
        reply_to_message_id: Optional[str] = None
        reply_to_text: Optional[str] = None

        # Guild (server channel) gate: with require_mention (default True),
        # respond ONLY to @mention of the bot, a reply to the bot's message, or
        # a command. DMs always pass.
        if is_guild and self._group_require_mention():
            bot_user = getattr(self._bot, "user", None)
            bot_id = getattr(bot_user, "id", None)
            is_mention = bool(
                bot_user and bot_user in (getattr(message, "mentions", None) or [])
            )
            ref = getattr(message, "reference", None)
            resolved = getattr(ref, "resolved", None) if ref else None
            ref_author = getattr(resolved, "author", None) if resolved else None
            is_reply_to_bot = bool(
                ref_author and bot_id is not None
                and getattr(ref_author, "id", None) == bot_id
            )
            is_command = text.startswith("/") or text.startswith("!")
            if not (is_mention or is_reply_to_bot or is_command):
                return  # unaddressed guild chatter — ignore
            if is_reply_to_bot and resolved is not None:
                reply_to_text = getattr(resolved, "content", None) or None
                rid = getattr(resolved, "id", None)
                reply_to_message_id = str(rid) if rid is not None else None

        await self._dispatch_inbound(
            text=text,
            chat_id=str(message.channel.id),
            chat_type="channel" if is_guild else "dm",
            user_id=str(message.author.id),
            user_name=getattr(message.author, "name", None),
            message_id=str(message.id),
            guild_id=str(message.guild.id) if is_guild else None,
            reply_to_message_id=reply_to_message_id,
            reply_to_text=reply_to_text,
            media_urls=[a.url for a in message.attachments] if message.attachments else None,
            raw_message=message,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        if self._bot is None:
            return {"name": str(chat_id), "type": "dm"}
        try:
            ch = self._bot.get_channel(int(chat_id))
            name = getattr(ch, "name", None) or str(chat_id)
            is_guild = getattr(ch, "guild", None) is not None
            return {"name": name, "type": "channel" if is_guild else "dm"}
        except Exception:
            return {"name": str(chat_id), "type": "dm"}


def check_requirements() -> bool:
    return _DISCORD_OK


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    token = extra.get("bot_token") or extra.get("botToken") or extra.get("token")
    return isinstance(token, str) and len(token) >= 20
