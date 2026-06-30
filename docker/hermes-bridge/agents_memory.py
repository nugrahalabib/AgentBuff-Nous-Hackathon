"""
agents_memory.py — Structured MEMORY.md editor (REAL Hermes location).

REWRITE 2026-05-26: now operates on the REAL Hermes location
`<profile>/memories/MEMORY.md` (matching Hermes Desktop's memory.ts).

For the default profile this is `~/.hermes/memories/MEMORY.md` — the
SAME file the chat engine actually loads as the agent's long-term memory.

Parser matches HD exactly:
  - ENTRY_DELIMITER = "\n§\n" (literal section sign)
  - MEMORY_CHAR_LIMIT = 2200
  - parse: split → trim → drop empty → re-index

RPC surface exposed via rpc_router:
    agents.memory.entries     (agent_id) → { entries, charCount, charLimit }
    agents.memory.addEntry    (agent_id, content)
    agents.memory.updateEntry (agent_id, index, content)
    agents.memory.removeEntry (agent_id, index)
    agents.memory.capacity    (agent_id) → { charCount, charLimit, percent }
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("bridge.agents_memory")


# MUST match HD constants exactly (memory.ts:6-8)
ENTRY_DELIMITER = "\n§\n"
MEMORY_CHAR_LIMIT = 2200
MEMORY_FILENAME = "memories/MEMORY.md"  # REAL Hermes location, was "MEMORY.md"


# -----------------------------------------------------------------
# Parsing / serializing — port of HD parseMemoryEntries / serializeEntries
# -----------------------------------------------------------------


def parse_memory_entries(content: str) -> list[dict]:
    """Port of HD parseMemoryEntries (memory.ts:63-71)."""
    if not content or not content.strip():
        return []
    out: list[dict] = []
    for idx, raw in enumerate(content.split(ENTRY_DELIMITER)):
        trimmed = raw.strip()
        if not trimmed:
            continue
        out.append({"index": idx, "content": trimmed})
    # Re-index after dropping empties so caller sees contiguous indices
    return [{"index": i, "content": e["content"]} for i, e in enumerate(out)]


def serialize_entries(entries: list[dict]) -> str:
    """Port of HD serializeEntries (memory.ts:73-75). Lossless reverse."""
    return ENTRY_DELIMITER.join(str(e.get("content", "")).strip() for e in entries)


def char_count(content: str) -> int:
    """Visible char count for capacity gauge — len after strip."""
    return len(content)


# -----------------------------------------------------------------
# RPC operations
# -----------------------------------------------------------------


async def list_entries(agents_handler: Any, agent_id: str) -> dict:
    """Return parsed entries + capacity info."""
    res = await agents_handler.get_file(agent_id, MEMORY_FILENAME)
    content = res.get("content", "") if isinstance(res, dict) else ""
    entries = parse_memory_entries(content)
    return {
        "agentId": agent_id,
        "entries": entries,
        "charCount": char_count(content),
        "charLimit": MEMORY_CHAR_LIMIT,
    }


async def add_entry(agents_handler: Any, agent_id: str, content: str) -> dict:
    """Append an entry. Refuses if it would exceed char limit."""
    if not isinstance(content, str):
        return {"ok": False, "error": "Konten harus string"}
    content = content.strip()
    if not content:
        return {"ok": False, "error": "Entry kosong"}

    # Read current
    res = await agents_handler.get_file(agent_id, MEMORY_FILENAME)
    current = res.get("content", "") if isinstance(res, dict) else ""
    entries = parse_memory_entries(current)
    next_entries = entries + [{"index": len(entries), "content": content}]
    next_text = serialize_entries(next_entries)

    if len(next_text) > MEMORY_CHAR_LIMIT:
        return {
            "ok": False,
            "error": f"Memori bakal kepenuhan ({len(next_text)}/{MEMORY_CHAR_LIMIT} chars)",
        }

    await agents_handler.set_file(agent_id, MEMORY_FILENAME, next_text)
    return {
        "ok": True,
        "entries": next_entries,
        "charCount": len(next_text),
        "charLimit": MEMORY_CHAR_LIMIT,
    }


async def update_entry(
    agents_handler: Any,
    agent_id: str,
    index: int,
    content: str,
) -> dict:
    """Replace entry at `index`. Refuses if out-of-range or over limit."""
    if not isinstance(index, int) or index < 0:
        return {"ok": False, "error": "Index harus integer ≥ 0"}
    if not isinstance(content, str):
        return {"ok": False, "error": "Konten harus string"}
    content = content.strip()
    if not content:
        return {"ok": False, "error": "Entry kosong (pake removeEntry buat hapus)"}

    res = await agents_handler.get_file(agent_id, MEMORY_FILENAME)
    current = res.get("content", "") if isinstance(res, dict) else ""
    entries = parse_memory_entries(current)
    if index >= len(entries):
        return {"ok": False, "error": "Entry tidak ditemukan"}

    next_entries = list(entries)
    next_entries[index] = {"index": index, "content": content}
    next_text = serialize_entries(next_entries)

    if len(next_text) > MEMORY_CHAR_LIMIT:
        return {
            "ok": False,
            "error": f"Edit bikin memori kepenuhan ({len(next_text)}/{MEMORY_CHAR_LIMIT} chars)",
        }

    await agents_handler.set_file(agent_id, MEMORY_FILENAME, next_text)
    return {
        "ok": True,
        "entries": next_entries,
        "charCount": len(next_text),
        "charLimit": MEMORY_CHAR_LIMIT,
    }


async def remove_entry(agents_handler: Any, agent_id: str, index: int) -> dict:
    """Delete entry at index. Returns ok=True even if index missing."""
    if not isinstance(index, int) or index < 0:
        return {"ok": False, "error": "Index harus integer ≥ 0"}

    res = await agents_handler.get_file(agent_id, MEMORY_FILENAME)
    current = res.get("content", "") if isinstance(res, dict) else ""
    entries = parse_memory_entries(current)
    if index >= len(entries):
        return {"ok": True, "noop": True, "entries": entries}

    next_entries = [e for i, e in enumerate(entries) if i != index]
    # Re-index after removal
    next_entries = [{"index": i, "content": e["content"]} for i, e in enumerate(next_entries)]
    next_text = serialize_entries(next_entries)
    await agents_handler.set_file(agent_id, MEMORY_FILENAME, next_text)
    return {
        "ok": True,
        "entries": next_entries,
        "charCount": len(next_text),
        "charLimit": MEMORY_CHAR_LIMIT,
    }


async def capacity(agents_handler: Any, agent_id: str) -> dict:
    """Just the capacity numbers — for status bar polling."""
    res = await agents_handler.get_file(agent_id, MEMORY_FILENAME)
    current = res.get("content", "") if isinstance(res, dict) else ""
    cc = len(current)
    return {
        "agentId": agent_id,
        "charCount": cc,
        "charLimit": MEMORY_CHAR_LIMIT,
        "percent": round((cc / MEMORY_CHAR_LIMIT) * 100, 1) if MEMORY_CHAR_LIMIT else 0,
    }
