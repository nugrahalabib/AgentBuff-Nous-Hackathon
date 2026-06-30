"""adapter_slack.py — one Slack workspace as a synthetic platform.

Subclasses BaseAccountAdapter. Wraps ONE slack-bolt AsyncApp + one
AsyncSocketModeHandler per workspace. Socket Mode = outbound WebSocket
(no public URL needed, fits per-user container). Instance-scoped → N
workspaces coexist in one process.

Credentials (config.extra), 3 required:
    bot_token       (xoxb-...)
    app_token       (xapp-...)   — Socket Mode
    signing_secret  (string)

Lifecycle:
    connect():   build AsyncApp + AsyncSocketModeHandler →
                 create_task(handler.start_async()) → mark connected
    disconnect(): handler.close_async() → cancel task

Inbound: app.event("message") + app.event("app_mention") → _dispatch_inbound
Outbound: send() → app.client.chat_postMessage
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional, Tuple

from gateway.platforms.base import SendResult

from .base_account_adapter import BaseAccountAdapter

logger = logging.getLogger("agentbuff.multichannel.slack")

try:
    from slack_bolt.async_app import AsyncApp
    from slack_bolt.adapter.socket_mode.aiohttp import AsyncSocketModeHandler
    _SLACK_OK = True
    _SLACK_ERR = None
except Exception as _e:  # pragma: no cover
    AsyncApp = None  # type: ignore
    AsyncSocketModeHandler = None  # type: ignore
    _SLACK_OK = False
    _SLACK_ERR = _e


class SlackAccountAdapter(BaseAccountAdapter):
    base_label = "Slack"

    def __init__(self, config: Any):
        super().__init__(config)
        if not _SLACK_OK:
            raise RuntimeError(
                f"slack adapter: slack-bolt not importable ({_SLACK_ERR})"
            )
        e = self.account_extra
        bot_token = e.get("bot_token") or e.get("botToken")
        app_token = e.get("app_token") or e.get("appToken")
        signing = e.get("signing_secret") or e.get("signingSecret")
        if not (isinstance(bot_token, str) and bot_token.startswith("xoxb-")):
            raise ValueError(
                f"slack adapter [{self.identity.account_id}]: invalid bot_token (xoxb-)"
            )
        if not (isinstance(app_token, str) and app_token.startswith("xapp-")):
            raise ValueError(
                f"slack adapter [{self.identity.account_id}]: invalid app_token (xapp-)"
            )
        if not (isinstance(signing, str) and len(signing) >= 8):
            raise ValueError(
                f"slack adapter [{self.identity.account_id}]: invalid signing_secret"
            )
        self._bot_token = bot_token
        self._app_token = app_token
        self._signing = signing
        self._app: Optional["AsyncApp"] = None
        self._handler: Optional["AsyncSocketModeHandler"] = None
        self._run_task: Optional[asyncio.Task] = None
        self._bot_user_id: Optional[str] = None  # for mention/self detection

    async def connect(self) -> bool:
        try:
            if not self._acquire_platform_lock(
                "slack-bot-token", self._bot_token, "Slack bot token"
            ):
                self._set_fatal_error(
                    "lock_conflict",
                    "Slack bot token already in use by another profile",
                    retryable=False,
                )
                return False
        except Exception:
            pass

        try:
            self._app = AsyncApp(token=self._bot_token, signing_secret=self._signing)
        except Exception as e:
            self._set_fatal_error("build_failed", str(e), retryable=True)
            return False

        adapter = self
        app = self._app

        @app.event("message")
        async def on_message(event, client):
            try:
                await adapter._handle_slack_event(event, kind="message")
            except Exception:
                logger.exception(
                    "slack[%s]: on_message failed", adapter.identity.account_id
                )

        @app.event("app_mention")
        async def on_app_mention(event, client):
            try:
                await adapter._handle_slack_event(event, kind="app_mention")
            except Exception:
                logger.exception(
                    "slack[%s]: on_app_mention failed", adapter.identity.account_id
                )

        try:
            self._handler = AsyncSocketModeHandler(app, self._app_token)
        except Exception as e:
            self._set_fatal_error("handler_build_failed", str(e), retryable=True)
            return False

        self._run_task = asyncio.create_task(self._run_handler())
        # Socket mode connects async; give it a moment but don't hard-fail on
        # timeout — handler keeps retrying internally.
        await asyncio.sleep(2)
        # Cache our own bot user id (for mention detection + avoiding the
        # app_mention/message double-dispatch). Best-effort.
        try:
            auth = await self._app.client.auth_test()
            self._bot_user_id = auth.get("user_id")
        except Exception:
            logger.debug("slack[%s]: auth_test failed", self.identity.account_id)
        self._mark_connected()
        logger.info("slack[%s]: socket handler launched", self.identity.account_id)
        return True

    async def _run_handler(self) -> None:
        try:
            await self._handler.start_async()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception(
                "slack[%s]: handler.start_async raised", self.identity.account_id
            )

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._handler is not None:
            try:
                await self._handler.close_async()
            except Exception:
                logger.debug(
                    "slack[%s]: close_async failed", self.identity.account_id,
                    exc_info=True,
                )
        if self._run_task is not None and not self._run_task.done():
            self._run_task.cancel()
            try:
                await self._run_task
            except (asyncio.CancelledError, Exception):
                pass
        self._run_task = None
        self._handler = None
        self._app = None
        try:
            self._release_platform_lock()
        except Exception:
            pass

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
                kwargs["thread_ts"] = reply_to
            resp = await self._app.client.chat_postMessage(
                channel=chat_id, text=content, **kwargs
            )
            return SendResult(
                success=bool(resp.get("ok", False)),
                message_id=resp.get("ts"),
            )
        except Exception as e:
            logger.exception("slack[%s]: send failed", self.identity.account_id)
            return SendResult(success=False, error=str(e)[:300], retryable=True)

    async def _handle_slack_event(self, event: dict, *, kind: str) -> None:
        if not isinstance(event, dict):
            return
        if event.get("bot_id"):
            return  # ignore bot messages (incl. self)
        channel = event.get("channel")
        if not channel:
            return
        ctype = event.get("channel_type", "channel")
        chat_type = "dm" if ctype == "im" else ("group" if ctype == "mpim" else "channel")
        text = event.get("text", "") or ""
        thread_ts = event.get("thread_ts")
        mentions_bot = bool(
            self._bot_user_id and f"<@{self._bot_user_id}>" in text
        )

        # Multi-user (channel / mpim) gate with require_mention (default True):
        # respond to @mention, a thread reply, or a command. DMs always pass.
        if chat_type in ("channel", "group"):
            if kind == "message":
                # The bot's own @mention also arrives as an app_mention event —
                # let THAT path handle mentions so we don't double-dispatch.
                if mentions_bot:
                    return
                if self._group_require_mention():
                    is_command = text.startswith("/")
                    is_thread_reply = bool(thread_ts and thread_ts != event.get("ts"))
                    if not (is_thread_reply or is_command):
                        return  # unaddressed channel chatter — ignore
            # kind == "app_mention" → explicit mention → always pass.

        await self._dispatch_inbound(
            text=text,
            chat_id=str(channel),
            chat_type=chat_type,
            user_id=str(event.get("user")) if event.get("user") else None,
            user_name=None,
            message_id=event.get("ts"),
            reply_to_message_id=str(thread_ts) if thread_ts else None,
            raw_message=event,
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "channel"}


def check_requirements() -> bool:
    return _SLACK_OK


def validate_config(config) -> bool:
    e = getattr(config, "extra", {}) or {}
    bt = e.get("bot_token") or e.get("botToken")
    at = e.get("app_token") or e.get("appToken")
    ss = e.get("signing_secret") or e.get("signingSecret")
    return (
        isinstance(bt, str) and bt.startswith("xoxb-")
        and isinstance(at, str) and at.startswith("xapp-")
        and isinstance(ss, str) and len(ss) >= 8
    )
