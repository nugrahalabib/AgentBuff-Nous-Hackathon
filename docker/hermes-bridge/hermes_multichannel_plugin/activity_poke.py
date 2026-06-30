"""activity_poke.py — instant cross-process realtime signal.

Channels run in the `hermes gateway run` process (our plugin's adapters);
/app connects to the bridge process. They share HERMES_HOME (the volume).

When a channel turn happens (a message arrives via the routing hook, or a reply
goes out via an adapter's send), we touch a tiny poke file. The bridge's session
watcher checks this file's mtime every ~0.2s and runs an IMMEDIATE db scan +
broadcast when it changes — so the web sees channel activity in near-real time
(working state + new messages) instead of waiting for its slow idle poll.

Best-effort: every call is wrapped so a poke failure can NEVER affect message
handling or delivery.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger("agentbuff.multichannel.poke")

POKE_FILENAME = ".agentbuff_activity_poke"
# Active-turn marker: the engine persists the user + assistant messages TOGETHER
# at turn END (~ms apart), so the bridge's db role-heuristic can NEVER observe a
# channel turn while it's in flight. This marker is the only in-progress signal:
# the plugin (channel runtime process) records which agent started a turn; the
# bridge watcher reads it to animate that agent's card on /app. Cleared when a
# reply goes out (mark_reply_sent) or after a safety TTL.
ACTIVE_TURNS_FILENAME = ".agentbuff_active_turns.json"
_TURN_TTL_S = 180.0


def _poke_path() -> Path:
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else (Path.home() / ".hermes")
    return base / POKE_FILENAME


def poke_activity() -> None:
    """Touch the poke file so the bridge watcher scans immediately. Never raises."""
    try:
        _poke_path().write_text(str(time.time()), encoding="utf-8")
    except Exception:
        log.debug("activity poke failed", exc_info=True)


def _active_turns_path() -> Path:
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else (Path.home() / ".hermes")
    return base / ACTIVE_TURNS_FILENAME


def _read_turns() -> dict:
    try:
        d = json.loads(_active_turns_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_turns(d: dict) -> None:
    try:
        _active_turns_path().write_text(json.dumps(d), encoding="utf-8")
    except Exception:
        log.debug("active-turns write failed", exc_info=True)


def mark_turn_start(agent_id: str) -> None:
    """Record that `agent_id` started a channel turn NOW + wake the watcher.

    The bridge watcher treats the agent as 'working' until a reply goes out
    (mark_reply_sent bumps last_reply_ts past this start) or the safety TTL
    elapses. This is the in-flight signal the DB cannot provide. Never raises."""
    try:
        aid = (agent_id or "default").strip().lower() or "default"
        now = time.time()
        d = _read_turns()
        agents = d.get("agents")
        if not isinstance(agents, dict):
            agents = {}
        agents[aid] = now
        cutoff = now - _TURN_TTL_S  # prune crashed/stale starts
        agents = {
            k: v for k, v in agents.items()
            if isinstance(v, (int, float)) and v > cutoff
        }
        d["agents"] = agents
        _write_turns(d)
        poke_activity()
    except Exception:
        log.debug("mark_turn_start failed", exc_info=True)


def mark_reply_sent() -> None:
    """Record that a channel reply just went out NOW. The watcher clears any
    agent whose turn started at/before this timestamp (turn finished). Never
    raises."""
    try:
        d = _read_turns()
        d["last_reply_ts"] = time.time()
        _write_turns(d)
        poke_activity()
    except Exception:
        log.debug("mark_reply_sent failed", exc_info=True)
