"""profile_title.py — auto-title PER-AGENT (profile) sessions in their OWN db.

The engine auto-titles sessions via `agent.title_generator.maybe_auto_title`,
but the gateway calls it with the LAUNCH/ROOT SessionDB handle. A non-default
agent's session row lives in `profiles/<agent>/state.db`, so the engine's
`UPDATE sessions SET title=? WHERE id=?` matches ZERO rows there and the profile
session's title stays NULL forever -> /app shows the "Sesi utama" fallback no
matter how long the conversation ran. (The default agent works only because its
rows live in root, where the gateway's handle matches.)

This module re-runs the engine's OWN titler against the CORRECT profile db. It
is UPDATE-only (cannot resurrect a deleted row), skips when a title already
exists (never clobbers a manual rename), and hands off to maybe_auto_title which
spawns its own daemon thread (never blocks the turn). The engine source is NOT
modified — we only call its public title_generator with a profile-bound db.
(2026-06-09)
"""
from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path

log = logging.getLogger("bridge.profile_title")

_DEFAULT_IDS = {"", "main", "default"}


def maybe_title_profile_session(
    agent_id: str, dbkey: str, assistant_text: str
) -> None:
    """Best-effort: auto-title a profile session in its own state.db.

    Silent no-op for: the default agent, a missing/deleted/unflushed row, an
    already-titled row, no user message, or any error. NEVER raises (callers
    invoke it from the chat-final event path, which must not break).
    """
    try:
        aid = (agent_id or "").strip().lower()
        if aid in _DEFAULT_IDS or not dbkey or not (assistant_text or "").strip():
            return
        home = os.environ.get("HERMES_HOME") or "/home/hermes/.hermes"
        db_path = Path(f"{home}/profiles/{aid}/state.db")
        if not db_path.is_file():
            return

        # Existence + empty-title guard (read-only). Bail if the row is gone
        # (deleted / never flushed -> UPDATE-only safety) or already has a
        # title (don't clobber an LLM title or a manual rename — same
        # sessions.title column).
        try:
            ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
            try:
                row = ro.execute(
                    "SELECT title FROM sessions WHERE id = ?", (dbkey,)
                ).fetchone()
                if row is None:
                    return  # deleted / not flushed yet
                if row[0] and str(row[0]).strip():
                    return  # already titled
                msgs = ro.execute(
                    "SELECT role, content FROM messages "
                    "WHERE session_id = ? ORDER BY rowid",
                    (dbkey,),
                ).fetchall()
            finally:
                ro.close()
        except sqlite3.Error as e:
            log.debug("profile_title: read guard failed (%s): %s", db_path, e)
            return

        history = [
            {"role": r[0], "content": r[1]} for r in msgs if r and r[0]
        ]
        user_msgs = [h for h in history if h["role"] == "user"]
        if not user_msgs:
            return
        user_message = str(user_msgs[0].get("content") or "")
        if not user_message.strip():
            return

        # Build the agent's runtime so the title LLM uses the profile's model
        # (mirrors agentbuff_persona_patch). Falls back to the auxiliary client
        # when unresolved.
        main_runtime = None
        try:
            from agentbuff_persona_patch import _read_persona

            persona = _read_persona(aid) or {}
            from hermes_cli.runtime_provider import resolve_runtime_provider

            rt = resolve_runtime_provider(
                requested=persona.get("provider") or None,
                target_model=persona.get("model") or None,
            ) or {}
            main_runtime = {
                k: rt[k]
                for k in (
                    "provider", "model", "base_url",
                    "api_key", "api_mode", "auth_mode",
                )
                if rt.get(k)
            } or None
        except Exception:
            log.debug(
                "profile_title: runtime resolve failed (using aux fallback)",
                exc_info=True,
            )

        # Hand off to the engine's own titler, bound to the PROFILE db. It
        # spawns a daemon thread, re-checks the empty-title guard, self-skips
        # when user_msg_count > 2, and writes via UPDATE ... WHERE id=? (no
        # INSERT, cannot resurrect a deleted row). WAL is on so the short
        # UPDATE coexists with the gateway reader; set_session_title has its
        # own busy-timeout retry.
        from hermes_state import SessionDB
        from agent.title_generator import maybe_auto_title

        sdb = SessionDB(db_path=db_path)
        maybe_auto_title(
            sdb,
            dbkey,
            user_message,
            assistant_text,
            history,
            main_runtime=main_runtime,
        )
    except Exception:
        log.debug(
            "profile_title: maybe_title_profile_session crashed (non-fatal)",
            exc_info=True,
        )
