"""adapter_telegram.py — one Telegram bot account as a synthetic platform.

Subclasses BaseAccountAdapter (→ BasePlatformAdapter). Each instance wraps ONE
python-telegram-bot Application with its OWN token, so N instances coexist in
one process (verified: PTB Application is fully instance-scoped, no globals).

Lifecycle (PTB 22.6, decomposed — never run_polling which blocks):
    connect():   build Application → initialize → start → updater.start_polling
    disconnect(): updater.stop → stop → shutdown

Inbound: MessageHandler(filters.ALL) → _on_update → BaseAccountAdapter._dispatch_inbound
Outbound: send() → Application.bot.send_message

Credentials (config.extra):
    bot_token   (required)  — the Telegram bot token from @BotFather

Token uniqueness: Telegram rejects two pollers on the same token with 409
Conflict. Each account MUST have a distinct token — enforced upstream by the
bridge (one account_id = one token).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from gateway.platforms.base import SendResult

from .base_account_adapter import BaseAccountAdapter

logger = logging.getLogger("agentbuff.multichannel.telegram")

# Lazy import flag — PTB is a heavy dep; import at module load is fine here
# because the bridge image always ships python-telegram-bot (messaging extra).
try:
    from telegram import Update
    from telegram.ext import (
        Application,
        ApplicationBuilder,
        MessageHandler,
        filters,
        ContextTypes,
    )
    _PTB_OK = True
    _PTB_ERR = None
except Exception as _e:  # pragma: no cover
    Application = None  # type: ignore
    _PTB_OK = False
    _PTB_ERR = _e


class TelegramAccountAdapter(BaseAccountAdapter):
    base_label = "Telegram"

    def __init__(self, config: Any):
        super().__init__(config)
        if not _PTB_OK:
            raise RuntimeError(
                f"telegram adapter: python-telegram-bot not importable ({_PTB_ERR})"
            )
        token = (
            self.account_extra.get("bot_token")
            or self.account_extra.get("botToken")
            or self.account_extra.get("token")
        )
        if not isinstance(token, str) or ":" not in token:
            raise ValueError(
                f"telegram adapter [{self.identity.account_id}]: "
                "missing/invalid bot_token in config.extra"
            )
        self._token = token
        self._app: Optional["Application"] = None
        self._keepalive: Optional[asyncio.Task] = None

    # ── Lifecycle ──────────────────────────────────────────────────────────

    async def connect(self) -> bool:
        # Lock by token so two profiles can't poll the same bot (409 Conflict).
        try:
            if not self._acquire_platform_lock(
                "telegram-bot-token", self._token, "Telegram bot token"
            ):
                self._set_fatal_error(
                    "lock_conflict",
                    "Telegram bot token already in use by another profile",
                    retryable=False,
                )
                return False
        except Exception:
            # status module unavailable (tests) — proceed without lock
            pass

        try:
            self._app = ApplicationBuilder().token(self._token).build()
        except Exception as e:
            self._set_fatal_error("build_failed", str(e), retryable=True)
            return False

        adapter = self

        async def _on_update(update: "Update", _ctx: "ContextTypes.DEFAULT_TYPE"):
            try:
                await adapter._handle_ptb_update(update)
            except Exception:
                logger.exception(
                    "telegram[%s]: _on_update failed", adapter.identity.account_id
                )

        self._app.add_handler(MessageHandler(filters.ALL, _on_update))

        try:
            await self._app.initialize()   # validates token via getMe (network)
            await self._app.start()
            await self._app.updater.start_polling(drop_pending_updates=False)
        except Exception as e:
            logger.exception(
                "telegram[%s]: start failed", self.identity.account_id
            )
            self._set_fatal_error("start_failed", str(e), retryable=True)
            await self._safe_teardown()
            return False

        self._keepalive = asyncio.create_task(self._keepalive_loop())
        self._mark_connected()
        logger.info(
            "telegram[%s]: connected + polling (token=%s...)",
            self.identity.account_id, self._token[:12],
        )
        return True

    async def _keepalive_loop(self) -> None:
        try:
            while (
                self._app is not None
                and self._app.updater is not None
                and self._app.updater.running
            ):
                await asyncio.sleep(30)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception(
                "telegram[%s]: keepalive crashed", self.identity.account_id
            )

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._keepalive is not None and not self._keepalive.done():
            self._keepalive.cancel()
            try:
                await self._keepalive
            except (asyncio.CancelledError, Exception):
                pass
            self._keepalive = None
        await self._safe_teardown()
        try:
            self._release_platform_lock()
        except Exception:
            pass

    async def _safe_teardown(self) -> None:
        app = self._app
        if app is None:
            return
        for step_name, coro in (
            ("updater.stop", self._stop_updater(app)),
            ("app.stop", app.stop()),
            ("app.shutdown", app.shutdown()),
        ):
            try:
                await coro
            except Exception:
                logger.debug(
                    "telegram[%s]: %s failed during teardown",
                    self.identity.account_id, step_name, exc_info=True,
                )
        self._app = None

    @staticmethod
    async def _stop_updater(app) -> None:
        if app.updater is not None and app.updater.running:
            await app.updater.stop()

    # ── Outbound ───────────────────────────────────────────────────────────

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if self._app is None:
            return SendResult(success=False, error="not connected", retryable=True)
        try:
            kwargs: Dict[str, Any] = {}
            if reply_to:
                try:
                    kwargs["reply_to_message_id"] = int(reply_to)
                except (TypeError, ValueError):
                    pass
            msg = await self._app.bot.send_message(
                chat_id=int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id,
                text=content,
                **kwargs,
            )
            return SendResult(success=True, message_id=str(msg.message_id))
        except Exception as e:
            logger.exception(
                "telegram[%s]: send failed", self.identity.account_id
            )
            return SendResult(success=False, error=str(e)[:300], retryable=True)

    # ── Inbound ────────────────────────────────────────────────────────────

    @staticmethod
    def _coerce_bool(value: Any, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, str):
            return value.strip().lower() in {"true", "1", "yes", "on"}
        return bool(value)

    def _is_addressed_to_bot(self, msg: Any, text: str) -> tuple[bool, bool]:
        """Return (is_mention, is_reply_to_bot) for a group message.

        We control this adapter, so we detect BOTH the @mention (bot username or
        a text_mention entity pointing at the bot) AND a reply to one of the
        bot's own messages (reply_to_message.from_user.id == bot.id). The native
        engine gate isn't used for synthetic platforms, so this is the trigger
        source of truth."""
        bot = getattr(self._app, "bot", None) if self._app else None
        bot_id = getattr(bot, "id", None)
        bot_username = (getattr(bot, "username", "") or "").lower()

        reply = getattr(msg, "reply_to_message", None)
        is_reply_to_bot = bool(
            reply
            and getattr(reply, "from_user", None)
            and bot_id is not None
            and getattr(reply.from_user, "id", None) == bot_id
        )

        is_mention = False
        low = text.lower()
        if bot_username and f"@{bot_username}" in low:
            is_mention = True
        if not is_mention:
            for ent in (getattr(msg, "entities", None) or []):
                etype = getattr(ent, "type", "")
                if etype == "text_mention":
                    ent_user = getattr(ent, "user", None)
                    if ent_user and getattr(ent_user, "id", None) == bot_id:
                        is_mention = True
                        break
                elif etype == "mention" and bot_username:
                    off = getattr(ent, "offset", 0)
                    ln = getattr(ent, "length", 0)
                    seg = text[off:off + ln].lstrip("@").lower()
                    if seg == bot_username:
                        is_mention = True
                        break
        return is_mention, is_reply_to_bot

    async def _handle_ptb_update(self, update: "Update") -> None:
        msg = update.effective_message
        chat = update.effective_chat
        user = update.effective_user
        if msg is None or chat is None:
            return
        text = msg.text or msg.caption or ""
        if chat.type in ("group", "supergroup"):
            chat_type = "group"
        elif chat.type == "channel":
            chat_type = "channel"
        else:
            chat_type = "dm"

        reply = getattr(msg, "reply_to_message", None)
        reply_to_text: Optional[str] = None

        # Group trigger gate. DMs always pass. In groups with require_mention
        # (our mass-market default = True, so the bot doesn't reply to every
        # message), respond ONLY to: @mention, reply-to-bot, or a /command.
        if chat_type == "group":
            require_mention = self._coerce_bool(
                self.config.extra.get("require_mention"), True
            )
            if require_mention:
                is_mention, is_reply_to_bot = self._is_addressed_to_bot(msg, text)
                is_command = text.startswith("/")
                if not (is_mention or is_reply_to_bot or is_command):
                    return  # unaddressed group chatter — ignore
                if is_reply_to_bot and reply is not None:
                    reply_to_text = getattr(reply, "text", None) or getattr(
                        reply, "caption", None
                    )

        await self._dispatch_inbound(
            text=text,
            chat_id=str(chat.id),
            chat_type=chat_type,
            user_id=str(user.id) if user else None,
            user_name=(user.username or user.first_name) if user else None,
            message_id=str(msg.message_id),
            reply_to_message_id=(
                str(reply.message_id) if reply else None
            ),
            reply_to_text=reply_to_text,
            raw_message=update,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        if self._app is None:
            return {"name": str(chat_id), "type": "dm"}
        try:
            chat = await self._app.bot.get_chat(
                int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id
            )
            return {
                "name": chat.title or chat.username or str(chat_id),
                "type": "group" if chat.type in ("group", "supergroup") else "dm",
            }
        except Exception:
            return {"name": str(chat_id), "type": "dm"}


def check_requirements() -> bool:
    """True if PTB importable. Per-account token validated at construct time."""
    return _PTB_OK


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    token = extra.get("bot_token") or extra.get("botToken") or extra.get("token")
    return isinstance(token, str) and ":" in token
