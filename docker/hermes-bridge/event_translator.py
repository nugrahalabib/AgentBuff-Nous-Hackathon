"""
event_translator.py — Translate Hermes notifications to portal event format.

Hermes emits multiple distinct JSON-RPC notification methods for what the
portal/browser expects as a SINGLE event type with a `state` discriminator
field. This module owns the translation + the per-session delta accumulator.

Hermes 0.14 actual event catalog (verified against tui_gateway/server.py
`_emit("<name>", ...)` callsites):
    approval.request, browser.progress, error, message.start,
    message.delta, message.complete, reasoning.available,
    reasoning.delta, session.info, skin.changed, status.update,
    thinking.delta, tool.complete, tool.generating, tool.progress,
    voice.status, voice.transcript

We translate the ones the portal /app UI actually renders; everything
else falls through the passthrough at the bottom (forwarded as
`event=<method>` for any consumer that wants it).

OpenClaw wire gotchas preserved:

  G3 — sessionKey rewriting:
    Hermes uses flat `session_id` (e.g. "554ffd2f"). Portal expects
    canonical "agent:<agentId>:<sessionKey>" form. We rewrite outbound.

  G4 — ONE `event: "chat"` covers ALL streaming states:
    Hermes:                              Portal expects:
    - message.delta           →          event="chat" state="delta"
    - message.complete        →          event="chat" state="final"
    - error                   →          event="chat" state="error"

  G5 — content[].text is FULL merged text, not chunk:
    Hermes' message.delta/complete payloads carry the FULL merged
    text in `text` (verified at tui_gateway/server.py:3245). The
    delta accumulator stays in lock-step via replace_text(), and
    the UI does REPLACE not append.

  G6 — Error in payload.errorMessage:
    Hermes' `error` event carries the message at params.message; we
    re-shape into payload.errorMessage at the top level.

  G10 — Energy cost ceiling not floor (handled in energy_gate.py,
    not here — translator only surfaces token counts when present.)

Thinking events translate to `event: "agent"` stream=thinking.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional


log = logging.getLogger("bridge.event_translator")


# How long to keep an inactive delta accumulator before pruning.
# Long enough to survive a slow client reconnect, short enough to bound memory.
ACCUMULATOR_TTL_S = 600.0  # 10 minutes


# ---------------------------------------------------------------------
# Session-key canonicalization (G3)
# ---------------------------------------------------------------------


def canonicalize_session_key(
    raw_key: str,
    default_agent_id: str = "main",
) -> str:
    """Convert Hermes flat session_id to portal's canonical form.

    Examples:
        "main"                  → "agent:main:main"
        "telegram-123-456"      → "agent:main:telegram-123-456"
        "agent:cs:chat-1"       → "agent:cs:chat-1"  (already canonical)

    Convention: when we ENGINEER session_id for inbound channel routing,
    we use the canonical form directly (e.g. "agent:cs:telegram-123").
    The default_agent_id is the fallback when raw_key has no agent prefix.

    SID→DBKEY RECONCILIATION (fix 2026-06-03): sessions.list uses the stable
    DBKEY as the canonical public key (rpc_router:handle_sessions_list), but
    Hermes emits chat events + the chat.send ack keyed by the ephemeral in-memory
    SID. If those diverge, /app pivots activeSessionKey to the sid, then
    refreshSessions (sessions.list = dbkey) finds the sid "vanished" and rebinds
    away → the reply disappears + a new/empty session opens until refresh (chief
    bug). So here we resolve sid → dbkey via rpc_router's alias map whenever it's
    known, making events + ack + sessions.list ALL use the same dbkey. Already-
    canonical keys + unknown sids pass through unchanged.
    """
    if not raw_key:
        return f"agent:{default_agent_id}:main"
    if raw_key.startswith("agent:"):
        return raw_key
    agent_id = default_agent_id
    try:
        from rpc_router import get_dbkey_for_sid, get_agent_for_sid
        # Resolve the agent THIS session is bound to (set at sessions.create)
        # so a specialist agent's chat events keep their agent prefix instead
        # of collapsing to agent:main → UI mislabels the session as Buff.
        bound = get_agent_for_sid(raw_key)
        dbkey = get_dbkey_for_sid(raw_key)
        if dbkey:
            if not bound:
                bound = get_agent_for_sid(dbkey)
            raw_key = dbkey
        if bound:
            agent_id = bound
    except Exception:  # noqa: BLE001 — reconciliation is best-effort
        pass
    return f"agent:{agent_id}:{raw_key}"


def decanonicalize_session_key(canonical: str) -> tuple[str, str]:
    """Reverse of canonicalize: extract (agent_id, session_id).

    Returns ("main", raw) if not canonical form.
    """
    if not canonical.startswith("agent:"):
        return ("main", canonical)
    parts = canonical.split(":", 2)
    if len(parts) < 3:
        return ("main", canonical)
    _, agent_id, session_id = parts
    return (agent_id, session_id)


# ---------------------------------------------------------------------
# Delta accumulator (G5)
# ---------------------------------------------------------------------


@dataclass
class _Accumulator:
    """Per-session text accumulator for streaming deltas."""

    text: str = ""
    last_update_ts: float = field(default_factory=time.monotonic)
    thinking_text: str = ""


class DeltaAccumulator:
    """Tracks accumulated streaming text per (canonical_session_key).

    message.delta text is accumulated via append_text (Hermes 0.16.0 ships
    INCREMENTAL chunks; older builds shipped full-merged frames — append_text
    is tolerant of both). The cumulative snapshot is emitted on the wire and
    also lets a turn that ends without an explicit `message.complete` (network
    drop, container restart mid-stream) surface the last-seen text on the next
    reset cycle. thinking/reasoning still use replace_* (they ship full text).

    Reset on `message.complete` and on the `error`/`aborted` events.
    """

    def __init__(self) -> None:
        self._by_session: dict[str, _Accumulator] = {}

    def replace_text(self, session_key: str, full_text: str) -> str:
        """Replace session's text wholesale. Used by message.delta which
        ships the full merged text each frame (wire gotcha G5)."""
        acc = self._by_session.get(session_key)
        if acc is None:
            acc = _Accumulator()
            self._by_session[session_key] = acc
        acc.text = full_text
        acc.last_update_ts = time.monotonic()
        return acc.text

    def append_text(self, session_key: str, chunk: str) -> str:
        """Accumulate a streaming text chunk and return the CUMULATIVE text.

        Wire-shape tolerant. Hermes 0.16.0 ships message.delta as INCREMENTAL
        chunks (['Ap','el',',',' mang',...] that concat to the final) — NOT the
        full-merged text earlier builds sent. We append each chunk so the wire
        carries cumulative text (what /app's G5 REPLACE contract + turnTextOffset
        slicing both expect). If a frame already starts with the accumulated text
        (a build that reverted to full-merged frames), we REPLACE instead of
        append so we never double-concatenate across wire-shape changes."""
        acc = self._by_session.get(session_key)
        if acc is None:
            acc = _Accumulator()
            self._by_session[session_key] = acc
        if not acc.text:
            acc.text = chunk
        elif chunk and chunk.startswith(acc.text):
            acc.text = chunk  # full-merged frame (legacy/reverted wire) — replace
        else:
            acc.text += chunk  # incremental chunk (0.16.0) — append
        acc.last_update_ts = time.monotonic()
        return acc.text

    def append_thinking(self, session_key: str, delta: str) -> str:
        """Append a thinking-delta chunk (legacy — Hermes 0.14 doesn't use
        this since payloads carry full text, but kept for any producer
        that ships incremental thinking chunks)."""
        acc = self._by_session.get(session_key)
        if acc is None:
            acc = _Accumulator()
            self._by_session[session_key] = acc
        acc.thinking_text += delta
        acc.last_update_ts = time.monotonic()
        return acc.thinking_text

    def replace_thinking(self, session_key: str, full_text: str) -> str:
        """Replace session's thinking text wholesale. Used by thinking.delta
        + reasoning.delta which ship FULL merged reasoning text each frame
        (verified empirically — Hermes 0.14 payload field is `text` carrying
        the cumulative reasoning, not an incremental `delta`)."""
        acc = self._by_session.get(session_key)
        if acc is None:
            acc = _Accumulator()
            self._by_session[session_key] = acc
        acc.thinking_text = full_text
        acc.last_update_ts = time.monotonic()
        return acc.thinking_text
        acc.last_update_ts = time.monotonic()

    def reset(self, session_key: str) -> None:
        """Drop accumulator for session (on final/aborted/error)."""
        self._by_session.pop(session_key, None)

    def prune_stale(self, *, now: Optional[float] = None) -> int:
        """Drop accumulators older than ACCUMULATOR_TTL_S. Returns count pruned."""
        cutoff = (now or time.monotonic()) - ACCUMULATOR_TTL_S
        stale = [
            k for k, acc in self._by_session.items()
            if acc.last_update_ts < cutoff
        ]
        for k in stale:
            del self._by_session[k]
        return len(stale)


# ---------------------------------------------------------------------
# Placeholder-thinking detector
# ---------------------------------------------------------------------
# Hermes 0.14 emits cute ASCII-emoticon placeholder strings via
# `thinking.delta` for models that don't have native thinking. Examples:
#     ( ͡° ͜ʖ ͡°) cogitating...
#     ヽ(>∀<☆)☆ reasoning...
#     ( ˘⌣˘)♡ deliberating...
#     ( ͡° ͜ʖ ͡°) synthesizing...
# Plus reset frames with `text=""`. None of these are useful to the user
# so we drop them at the translator boundary. The detector is permissive
# (any short string starting with `(...)` whitespace and ending in `...`),
# which keeps it stable across Hermes' randomised placeholder rotation.

import re as _re

# Pattern: short string ending in `<word>...` (1+ trailing ellipsis dots).
# Catches every Hermes 0.14 placeholder we've seen regardless of which
# kaomoji wrapper Hermes randomised:
#   `( ͡° ͜ʖ ͡°) cogitating...`            ← `( ... )` ascii
#   `(>﹏<) processing...`                  ← `( ... )` ascii
#   `( ˘⌣˘)♡ deliberating...`              ← `( ... )♡`
#   `ヽ(>∀<☆)☆ reasoning...`               ← `ヽ(...)☆`
#   `٩(๑❛ᴗ❛๑)۶ reasoning...`               ← `٩(...)۶` Arabic brackets
#   `( ͡° ͜ʖ ͡°) synthesizing...`          ← post-tool placeholder
# Real reasoning chunks are virtually always > 80 chars and don't end in
# "<word>..." — they're full sentences with punctuation.
_PLACEHOLDER_THINKING_RE = _re.compile(
    r"^.{1,80}?[A-Za-z]{4,}\.{2,}\s*$"
)


def _is_placeholder_thinking(text: str) -> bool:
    if not text:
        return True
    if len(text) > 80:
        return False  # real reasoning chunks are longer
    return bool(_PLACEHOLDER_THINKING_RE.match(text))


# ---------------------------------------------------------------------
# Brand scrubber — Hermes/Nous/OpenClaw → AgentBuff/Buff
# ---------------------------------------------------------------------
# Defense-in-depth against model self-identifying as "Hermes Agent" or
# leaking the upstream engine brand. SOUL.md persona is the primary
# instruction; this filter is a belt-and-suspenders pass over outbound
# text content in case the model copies brand text from tool outputs,
# skill content, or its own training set. Applied to:
#   - chat.delta / chat.final message.content[].text
#   - tool.complete summary / partialResult / inline_diff
#   - session.info title (when displayed in sidebar)
# NOT applied to:
#   - tool input args (functional identifiers like skill name "hermes-agent")
#   - dbkey / session_id strings
# Replacement order matters — multi-word phrases first to avoid
# fragmenting "Hermes Agent" into two separate replacements.

# Kept in lock-step with the channel catalog
# (hermes_multichannel_plugin/outbound_brand.py::_BRAND_SUBS) so /app and
# channels hide the SAME engine-brand token set. Multi-word / hyphenated
# phrases FIRST (longest wins before the bare-"hermes" pass fragments them).
# `[\s_-]?` catches "Hermes Agent" / "Hermes-Agent" / "Hermes_Agent" /
# "HermesAgent" in one. The three case-preserving passes keep surrounding
# casing so a path reads /home/agentbuff/.agentbuff (not /home/AgentBuff/…).
_BRAND_SUBS: list[tuple] = [
    (_re.compile(r"Hermes[\s_-]?Agent", _re.IGNORECASE), "Buff"),
    (_re.compile(r"Nous[\s_-]?Research", _re.IGNORECASE), "AgentBuff"),
    (_re.compile(r"OpenClaw", _re.IGNORECASE), "AgentBuff"),
    (_re.compile(r"Teknium", _re.IGNORECASE), "AgentBuff"),
    # Standalone "hermes" — no word-boundary because JSON escape
    # sequences like `\nhermes` (literal backslash-n in serialized
    # tool output) break Python's `\b` (n+h both word chars). False
    # positives on identifiers like `hermes_cli` / `user_hermes`
    # are acceptable: chief's brand priority outranks scientific
    # accuracy in tool output paths. Case-preserving via three passes.
    (_re.compile(r"Hermes"), "AgentBuff"),
    (_re.compile(r"hermes"), "agentbuff"),
    (_re.compile(r"HERMES"), "AGENTBUFF"),
    # Mixed/odd casing fallthrough (HeRmEs, hErMeS …) — last so the
    # case-preserving passes handle the common forms first.
    (_re.compile(r"[Hh][Ee][Rr][Mm][Ee][Ss]"), "AgentBuff"),
]


# Path-like prefix detection — a string that starts with any of these
# is treated as a FILESYSTEM IDENTIFIER and skipped by `scrub_brand`.
# Critical: paths under `/home/hermes/.hermes/` MUST NOT be rewritten to
# `/home/agentbuff/.agentbuff/` because (a) those rewritten paths don't
# exist on disk, and (b) the agent re-reads its own scrubbed output and
# embeds corrupted paths in future replies, cascading the bug. Observed
# 2026-05-23 in chief's bot reply.
_PATH_PREFIXES = ("/", "~/", "./", "../", "C:\\", "D:\\", "$", "%")

# Dict keys whose VALUES are always filesystem paths or URLs — skip
# brand scrubbing on these entirely. Used by `deep_scrub_brand`.
# `displayUrl` is the user-side attachment URL we ship to /app;
# `path`/`file_path`/`cache_path`/`src` are tool result fields;
# `href`/`url` cover HTTP/blob URL references.
_PATH_LIKE_KEYS = frozenset({
    "displayUrl",
    "path",
    "file_path",
    "cache_path",
    "src",
    "href",
    "url",
    # Tool result fields that carry a MEDIA: tag or filesystem path —
    # added 2026-05-23 after chief's TTS test showed the gTTS-returned
    # `media_tag: "MEDIA:/home/hermes/.hermes/cache/audio/x.mp3"` was
    # scrub_brand-rewritten to `/home/agentbuff/.agentbuff/...` which
    # broke extract_bot_media in the agent's subsequent reply (the agent
    # reads tool_result + embeds media_tag verbatim into reply text;
    # if media_tag is scrubbed, the embedded path is broken too).
    "media_tag",
    "audio_url",
    "video_url",
    "image_url",
    "document_url",
    "media_url",
    "voice_url",
    "filename",
    "filepath",
    "savepath",
    "output_path",
    "outputPath",
    "input_path",
    "destination",
    "source",
    # Hermes tool outputs that wrap a single path in a `result` or
    # `output` key — typically when the entire tool result IS a path.
    # We don't blanket-protect these because they ALSO carry prose
    # in some tools. The scrub_brand path-aware logic now catches
    # paths embedded in prose, so we don't need to protect these keys.
})


def _looks_like_path(text: str) -> bool:
    if not text:
        return False
    stripped = text.lstrip()
    return stripped.startswith(_PATH_PREFIXES)


# Patterns that PROTECT spans from brand rewriting when they appear
# ANYWHERE inside prose. Previous version only checked text.startswith
# which missed paths embedded in agent replies like:
#   "Dengar jelas, Chief! ... MEDIA:/home/hermes/.hermes/cache/audio/x.mp3"
# That MEDIA: substring got brand-scrubbed → `/home/agentbuff/.agentbuff/...`
# → file doesn't exist → extract_bot_media fails → tag stays plaintext.
# Observed 2026-05-23 in chief's TTS test.
_PROTECT_SPAN_PATTERNS = [
    # MEDIA: tag — local path OR HTTP URL until whitespace/]
    re.compile(r"MEDIA:\S+"),
    # Absolute Unix paths (typical hermes/portal paths)
    re.compile(r"(?<!\w)/(?:home|root|tmp|var|opt|usr|etc|mnt|app|srv)(?:/[^\s)\]>'\"]*)?"),
    # HTTPS/HTTP URLs (any scheme)
    re.compile(r"\bhttps?://\S+"),
    # WebSocket URLs
    re.compile(r"\bwss?://\S+"),
    # Tilde-home paths (`~/.hermes/...`)
    re.compile(r"(?<!\w)~/[^\s)\]>'\"]*"),
    # Windows absolute paths (C:\foo\bar)
    re.compile(r"\b[A-Z]:\\[^\s)\]>'\"]*"),
    # `[[audio_as_voice]]` and similar agent directive markers — never
    # scrub these. Agent emits them verbatim per Hermes' webui hint.
    re.compile(r"\[\[[a-z_]+\]\]"),
]


def scrub_brand(text: str) -> str:
    """Rewrite Hermes/Nous/OpenClaw brand mentions to AgentBuff/Buff.

    Idempotent — re-applying produces the same output. Safe for any
    user-facing PROSE (chat content, tool results, status updates).

    CRITICAL: Preserves filesystem paths and URLs that appear ANYWHERE
    in the text (not just at text start). Strategy: find every protected
    span via regex, scrub the surrounding prose, then re-stitch
    everything together. Without this, agent replies like
    `"Saya save ke /home/hermes/x.mp3"` would emerge as
    `"... /home/agentbuff/x.mp3"` — a path that doesn't exist on disk,
    breaking every media tool delivery (text_to_speech / image_generate /
    video_generate / write_file).
    """
    # DISABLED 2026-06-03 (Chief: "hilangin replace-replace — jangan ubah UI
    # dari chat ku maupun balasan agen"). The brand scrubber no longer rewrites
    # any text: user messages, agent replies, tool results, and history are
    # shown VERBATIM in /app. To re-enable, delete this early return — the
    # original _BRAND_SUBS logic below is preserved intact.
    return text

    if not text or not isinstance(text, str):
        return text
    # Fast path: pure-path string at text start (legacy behavior — also
    # catches the case where dict value IS a bare path string).
    if _looks_like_path(text):
        return text

    # Collect all protected span ranges
    spans: list[tuple[int, int]] = []
    for pat in _PROTECT_SPAN_PATTERNS:
        for m in pat.finditer(text):
            spans.append((m.start(), m.end()))
    if not spans:
        # No protected spans — scrub whole text
        for pattern, replacement in _BRAND_SUBS:
            text = pattern.sub(replacement, text)
        return text

    # Sort + merge overlapping spans (e.g. `MEDIA:/home/...` matches BOTH
    # `MEDIA:` and `/home/` patterns)
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    # Scrub each gap BETWEEN protected spans; preserve spans verbatim
    out: list[str] = []
    last = 0
    for start, end in merged:
        gap = text[last:start]
        for pattern, replacement in _BRAND_SUBS:
            gap = pattern.sub(replacement, gap)
        out.append(gap)
        out.append(text[start:end])  # protected span verbatim
        last = end
    # Scrub trailing prose after final span
    tail = text[last:]
    for pattern, replacement in _BRAND_SUBS:
        tail = pattern.sub(replacement, tail)
    out.append(tail)
    return "".join(out)


def deep_scrub_brand(value):
    """Recursively scrub brand strings from any nested data structure.

    Used as a SINGLE CHOKEPOINT at the bridge's outbound boundary —
    every translator return value AND every RPC response gets laundered
    through this once before leaving the bridge. Means we don't have to
    remember to scrub each new field added to translator return shapes;
    the chokepoint catches everything.

    Idempotent (scrub_brand is idempotent). Safe to apply multiple times.
    Type-preserving (returns dict/list/str of same shape).

    For dicts: values under known path/URL keys (`_PATH_LIKE_KEYS`) are
    passed through verbatim — protects attachment URLs we already
    registered with media_serve from being rewritten and broken.
    """
    if isinstance(value, str):
        return scrub_brand(value)
    if isinstance(value, dict):
        return {
            k: (v if k in _PATH_LIKE_KEYS else deep_scrub_brand(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [deep_scrub_brand(v) for v in value]
    return value


# Narrow protect spans for DISPLAY scrub — only functional tokens /app needs
# intact. We protect MEDIA: tags (media delivery) + the audio directive, but
# NOT bare http(s) URLs: a bare-URL guard would shield brand tokens INSIDE a
# link (e.g. github.com/NousResearch/hermes-agent) from the scrubber. Our own
# durable media URLs are unaffected — resolution is by the <sha32> store name,
# the human filename is only a decorative trailing segment.
_DISPLAY_PROTECT_PATTERNS = [
    _re.compile(r"MEDIA:\S+"),
    _re.compile(r"\[\[audio_as_voice\]\]"),
]


def _scrub_display(text: str) -> str:
    """MEDIA/URL-protected brand scrub for TOOL + SYSTEM display surfaces
    (tool-progress cards, command labels, tool results, status text).

    Distinct from `scrub_brand` (a global no-op) — this is applied ONLY to
    non-chat event frames at the translate() chokepoint, so the agent's prose
    chat reply (event=="chat") and the user's own message stay VERBATIM, while
    tool/system surfaces get the engine brand hidden. MEDIA: tags + URLs are
    protected so media delivery never breaks.

    ENABLED 2026-06-11 (Chief: "aku tetep mau semua informasi di web ini
    semuanya di amankan dan tidak ada kebocoran nama brand lain tanpa
    terkecuali, jadi hanya bener bener chatnya aja yang ga di sentuh!").
    This supersedes the 2026-06-05 "show /app verbatim" decision: ONLY the chat
    conversation (user message + agent reply prose) stays verbatim; every other
    user-reachable surface gets the engine brand scrubbed. The translate()
    chokepoint guarantees chat prose never reaches this function.

    Bare filesystem paths are scrubbed COSMETICALLY here (unlike `scrub_brand`,
    which protects them): /app never fetches by a raw container path (media is
    tokenised into MEDIA:http URLs before reaching the client), and the agent
    re-reads the ENGINE's raw tool result — not this /app-displayed copy — so
    rewriting a displayed `/home/hermes/config.yaml` to `/home/agentbuff/...`
    is display-only and cannot cascade into the agent's future replies.
    """
    if not text or not isinstance(text, str):
        return text
    # Collect protected spans — MEDIA tags, http(s) URLs, and the agent's
    # `[[audio_as_voice]]` directive. Everything ELSE is brand-scrubbed.
    spans: list[tuple[int, int]] = []
    for pat in _DISPLAY_PROTECT_PATTERNS:
        for m in pat.finditer(text):
            spans.append((m.start(), m.end()))
    if not spans:
        for pattern, replacement in _BRAND_SUBS:
            text = pattern.sub(replacement, text)
        return text
    spans.sort()
    merged: list[tuple[int, int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    out: list[str] = []
    last = 0
    for start, end in merged:
        gap = text[last:start]
        for pattern, replacement in _BRAND_SUBS:
            gap = pattern.sub(replacement, gap)
        out.append(gap)
        out.append(text[start:end])  # protected span verbatim
        last = end
    tail = text[last:]
    for pattern, replacement in _BRAND_SUBS:
        tail = pattern.sub(replacement, tail)
    out.append(tail)
    return "".join(out)


# Keys whose VALUE is genuinely functional for /app and must survive verbatim:
# media tokens + URLs that the browser fetches by. NOTE this is a NARROW subset
# of `_PATH_LIKE_KEYS` — bare filesystem-path keys (file_path/path/cache_path/
# filename/output_path/input_path/destination/source/savepath/filepath) are
# DELIBERATELY excluded so brand leaks in DISPLAYED tool-card paths (e.g.
# read_file's "/home/hermes/config.yaml") get scrubbed. This is safe because the
# bridge rewrites every real media reference into a tokenised
# `MEDIA:http://127.0.0.1:<bridge>/media/<token>/<file>` URL before it reaches
# /app (rpc_router._rewrite_assistant_media_tags) — /app never fetches by a raw
# container path, so scrubbing the cosmetic path display can't break media.
_DISPLAY_FUNCTIONAL_KEYS = frozenset({
    "media_tag", "displayUrl", "url", "href", "src",
    "audio_url", "video_url", "image_url", "document_url",
    "media_url", "voice_url",
})


def _scrub_display_deep(value):
    """Recursive `_scrub_display` over a nested event frame.

    Only genuinely-functional media/URL keys (`_DISPLAY_FUNCTIONAL_KEYS`) are
    passed through verbatim. EVERY other string — including bare filesystem-path
    fields shown in tool cards (file_path/path/cache_path/…) and command labels,
    skill names, summaries, thinking, status — is scrubbed. The value-level
    `_scrub_display` still keeps MEDIA: tags + http(s) URLs verbatim wherever
    they appear, so the tokenised media URL survives even inside a scrubbed
    field. Result: the engine brand is hidden in EVERY tool-output display
    (terminal, execute_code, read_file, skill_view, search, …), web side."""
    if isinstance(value, str):
        return _scrub_display(value)
    if isinstance(value, dict):
        return {
            k: (v if k in _DISPLAY_FUNCTIONAL_KEYS else _scrub_display_deep(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub_display_deep(v) for v in value]
    return value


# ---------------------------------------------------------------------
# Translation: Hermes JSON-RPC notification → portal event frame
# ---------------------------------------------------------------------


def translate(
    hermes_msg: dict,
    accumulator: DeltaAccumulator,
    *,
    default_agent_id: str = "main",
) -> Optional[dict]:
    """Translate one Hermes notification into a portal event frame.
    Output is deep-scrubbed of Hermes brand strings at the chokepoint
    so every translator path (including passthrough/unknown methods)
    gets the brand-leak protection without needing per-handler care.

    Returns None if the notification doesn't map to a portal event
    (some Hermes internal events are dropped).
    """
    result = _translate_impl(
        hermes_msg, accumulator, default_agent_id=default_agent_id,
    )
    if result is None:
        return None
    # Chokepoint — scoped brand scrub (Chief 2026-06-03).
    #   - event=="chat"  → the agent's PROSE reply (+ the user's echoed text):
    #     left VERBATIM. The chat bubble shows exactly what was typed/said.
    #   - everything else (tool-progress cards, tool.start command labels,
    #     tool results, thinking, status, session.info) → scrubbed via
    #     `_scrub_display_deep` so the engine brand never leaks in tool/system
    #     surfaces on /app. Path/MEDIA spans stay verbatim (media safe).
    if result.get("event") == "chat":
        # Prose (delta/final text) is VERBATIM, but a chat-event with
        # state=="error" carries `errorMessage` — a SYSTEM error string (e.g.
        # "provider hermes misconfigured", "/home/hermes/... not found"), not
        # user/agent prose. Scrub that one field display-safe so the engine
        # brand never leaks via a chat error bubble.
        payload = result.get("payload")
        if isinstance(payload, dict) and payload.get("state") == "error":
            em = payload.get("errorMessage")
            if isinstance(em, str) and em:
                payload["errorMessage"] = _scrub_display(em)
        return result
    return _scrub_display_deep(result)


def _translate_impl(
    hermes_msg: dict,
    accumulator: DeltaAccumulator,
    *,
    default_agent_id: str = "main",
) -> Optional[dict]:
    """Internal translator implementation. Public `translate()` wraps
    this with the brand-scrub chokepoint."""
    method = hermes_msg.get("method")
    if not method:
        return None

    # Hermes wraps notifications: {"method": "event", "params": {"type": "<event-name>", "session_id": "...", "payload": {...}}}
    # We need to unwrap before dispatching so each translator sees just the payload.
    # See `_emit()` in tui_gateway/server.py:385.
    raw_params = hermes_msg.get("params") or {}
    if not isinstance(raw_params, dict):
        raw_params = {}

    if method == "event":
        event_type = raw_params.get("type")
        if not event_type:
            return None
        # Flatten: surface session_id + nested payload into params dict so
        # downstream translators see the shape they expect.
        params = {
            "session_id": raw_params.get("session_id"),
            **(raw_params.get("payload") or {}),
        }
        method = event_type
    else:
        params = raw_params

    # ----- message.* (chat streaming — Hermes' actual event names) -----
    # tui_gateway/server.py emits message.start, message.delta, message.complete.
    # Bridge maps them to the portal's OpenClaw-style chat event states.
    if method == "message.start":
        # No portal-side event needed; the optimistic UI bubble is already
        # placed by sendMessage. Returning None silently drops it.
        return None

    if method == "message.delta":
        return _translate_message_delta(params, accumulator, default_agent_id)

    if method == "message.complete":
        return _translate_message_complete(params, accumulator, default_agent_id)

    # Generic Hermes "error" event from _emit("error", sid, {message}). Used
    # on agent init failure and (rarely) prompt-path failures. Maps to portal
    # chat-event state=error so the UI can show an error bubble + retry chip.
    if method == "error":
        return _translate_error_event(params, accumulator, default_agent_id)

    # ----- thinking.delta + reasoning.{delta,available} -----
    # Hermes' reasoning chain surfaces as two related event streams:
    #   thinking.delta → Claude-style thinking blocks (full merged text each frame)
    #   reasoning.delta → mid-turn reasoning chunks (full merged each frame)
    #   reasoning.available → end-of-turn snapshot ({text: <full reasoning>})
    # Portal /app's UI renders both as a single "thinking" block under the
    # assistant turn (chat-thread.tsx applyThinkingAgentEvent).
    if method in ("thinking.delta", "reasoning.delta"):
        # Hermes 0.14 emits two distinct kinds of `thinking.delta`:
        #   1. PLACEHOLDER kaomoji `( ͡° ͜ʖ ͡°) cogitating...` — TUI status
        #      indicator content, ephemeral. Drop here because the portal's
        #      LiveActivityPill (chat-composer.tsx) animates the SAME face
        #      + verb set locally with the same 2.5s tick, full Hermes
        #      parity, but without polluting the chat transcript with a
        #      "Pemikiran agen" card per placeholder.
        #   2. REAL reasoning chunks (model with native thinking mode,
        #      e.g. Claude extended-thinking, DeepSeek R1) — long-form
        #      sentence text. Keep and surface as a thinking block.
        text = params.get("text") or ""
        if isinstance(text, str) and _is_placeholder_thinking(text):
            return None
        return _translate_thinking_delta(params, accumulator, default_agent_id)

    if method == "reasoning.available":
        # ALWAYS DROP. Hermes 0.14 fires this post-`message.complete` with
        # `payload.text` set to the assistant text itself when the model
        # has no native thinking (Gemini Flash, etc.) — relaying it
        # would duplicate the chat bubble inside a thinking card.
        # Real-reasoning models emit reasoning incrementally via
        # `thinking.delta` during streaming (long-form chunks); those
        # land as proper thinking blocks. The post-turn snapshot is
        # always redundant. Confirmed in trace 2026-05-22 + chief UX.
        return None

    # ----- tool.* — relay ALL four Hermes tool-lifecycle events. -----
    #
    # Hermes 0.14 flow:
    #   tool.generating { name }            ← LLM is generating args, no tool_id
    #   tool.progress   { name, preview }   ← preview of args during gen
    #   tool.start      { tool_id, name, context } ← execution started
    #   tool.complete   { tool_id, name, summary, duration_s, ... }
    #
    # tool.generating + tool.progress arrive BEFORE tool.start and lack a
    # real tool_id. We emit them with a synth id `pending-<session>-<name>`
    # so the UI can show a "generating ..." card immediately. The store is
    # responsible for migrating the synth id to the real `call_xxx` id
    # when tool.start arrives (so we end with ONE coherent tool card, not
    # two split cards).
    if method == "tool.start":
        return _translate_tool_start(params, default_agent_id)

    if method == "tool.complete":
        return _translate_tool_complete(params, default_agent_id)

    if method == "tool.progress":
        return _translate_tool_progress(params, default_agent_id)

    if method == "tool.generating":
        return _translate_tool_generating(params, default_agent_id)

    # ----- subagent.* — delegated multi-agent execution. -----
    # Hermes emits these via the unified `_on_tool_progress` callback when
    # the agent uses delegate_task tool. They form a tree:
    #   subagent.start    { goal, task_count, task_index, subagent_id, ... }
    #   subagent.tool     { tool_name, text|tool_preview, ...spawn fields }
    #   subagent.complete { input_tokens, output_tokens, cost_usd, summary, ... }
    if method in ("subagent.start", "subagent.tool", "subagent.complete"):
        return _translate_subagent(method, params, default_agent_id)

    # ----- status.update — background process / cron / bg task. -----
    # `{ kind: "process", text }` — Hermes surfaces these in TUI status
    # bar + toast. Map to portal agent stream=status so UI can show as a
    # transient pill inline in the transcript.
    if method == "status.update":
        return _translate_status_update(params, default_agent_id)

    # ----- review.summary — agent's self-improvement post-turn summary.
    # Hermes fires this via background_review_callback when the agent's
    # memory/skills get updated during a turn (`tui_gateway/server.py:1954`).
    # In Telegram channels this surfaces as `💾 Self-improvement review:
    # User profile updated · Memory updated`. Same parity for /app.
    # Routed as a status.update kind="review" so /app's existing
    # status renderer picks it up uniformly.
    if method == "review.summary":
        return _translate_review_summary(params, default_agent_id)

    # ----- Wave 6-3G rich block emission. Hermes' poll/dice/location/
    # contact/sticker/embed tools (or future ones) can fire these events
    # to inject typed blocks into the assistant message. Each translator
    # produces a wire event the /app store maps to a ContentBlock via
    # the agent-events stream + message append pipeline.
    if method in (
        "poll.show",
        "dice.show",
        "location.show",
        "contact.show",
        "sticker.show",
        "embed.show",
        "select.show",
        "modal.show",
    ):
        return _translate_rich_block(method, params, default_agent_id)

    # ----- approval.request / clarify.request — interactive prompts. -----
    # Engine pauses waiting for user input. Portal renders these as
    # inline action blocks with buttons.
    if method == "approval.request":
        return _translate_approval_request(params, default_agent_id)

    if method == "clarify.request":
        return _translate_clarify_request(params, default_agent_id)

    # ----- browser.progress — auto-browser tool live feed. -----
    if method == "browser.progress":
        return _translate_browser_progress(params, default_agent_id)

    # ----- approval.request — agent asking for human approval -----
    # Hermes emits `approval.request` (not `approval.needed` — verified
    # via _emit catalog in tui_gateway/server.py). Forward as-is for UI.
    if method == "approval.request":
        return {
            "type": "event",
            "event": "approval.request",
            "payload": {
                "sessionKey": canonicalize_session_key(
                    params.get("session_id") or "main",
                    default_agent_id,
                ),
                **params,
            },
        }

    # ----- session.info — refresh capability cache when emitted -----
    # Hermes fires this on session create + on model/tool config changes.
    # Forward an ALLOWLIST of cap fields only. The raw engine payload also
    # carries cwd ('/home/<engine-home>'), update_command ('pip install
    # --upgrade <engine-pkg>'), version/release_date, mcp_servers, profile_name
    # — all engine-internal + brand-bearing. Even `skills` leaks a brand value
    # (a bundled skill is literally named 'hermes-agent'). /app drops
    # session.info entirely (zero consumers), but the raw WS frame is
    # DevTools-visible, so the hard "no engine brand anywhere" constraint means
    # we forward ONLY the clean model string (e.g. 'gpt-5.5') + sessionKey.
    if method == "session.info":
        _SESSION_INFO_ALLOW = ("model", "agent_id", "agentId")
        safe = {k: params[k] for k in _SESSION_INFO_ALLOW if k in params}
        return {
            "type": "event",
            "event": "session.info",
            "payload": {
                "sessionKey": canonicalize_session_key(
                    params.get("session_id") or "main",
                    default_agent_id,
                ),
                **safe,
            },
        }

    # ----- compression.status (informational) -----
    if method == "compression.status":
        return {
            "type": "event",
            "event": "compression.status",
            "payload": params,
        }

    # ----- gateway.stderr (forwarded for debug; UI usually ignores) -----
    if method == "gateway.stderr":
        return {
            "type": "event",
            "event": "gateway.stderr",
            "payload": params,
        }

    # ----- Default: passthrough unknown Hermes events as-is -----
    # The UI knows to ignore unfamiliar event names; better to forward than
    # silently drop in case we missed a new Hermes event type.
    log.debug("event_translator: passthrough unknown Hermes method=%s", method)
    return {
        "type": "event",
        "event": method,
        "payload": params,
    }


# ---------------------------------------------------------------------
# Per-event-type translators
# ---------------------------------------------------------------------


def _translate_message_delta(
    params: dict,
    accumulator: DeltaAccumulator,
    default_agent_id: str,
) -> dict:
    """Hermes message.delta → portal chat-event state=delta.

    Hermes 0.16.0's streaming payload ships `text` as an INCREMENTAL chunk
    (verified live: deltas ['Ap','el',',',' mang',...] concat to the final,
    NOT cumulative). Earlier builds shipped the full-merged text each frame.
    /app's G5 contract REPLACES the streaming bubble with content[].text each
    delta (and turnTextOffset slices assume cumulative-from-turn-start text), so
    we MUST emit the cumulative text, not the raw chunk. The accumulator's
    append_text is wire-shape tolerant (append for incremental, replace for a
    full-merged frame), so this is correct on 0.16.0 and any future revert.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    # Accumulate the chunk → cumulative text for the wire (G5 REPLACE-safe).
    full_text = accumulator.append_text(
        session_key, scrub_brand(params.get("text") or ""),
    )

    return {
        "type": "event",
        "event": "chat",
        "payload": {
            "state": "delta",
            "sessionKey": session_key,
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": full_text},
                ],
            },
        },
    }


def _translate_message_complete(
    params: dict,
    accumulator: DeltaAccumulator,
    default_agent_id: str,
) -> dict:
    """Hermes message.complete → portal chat-event state=final.

    Hermes payload (tui_gateway/server.py:3320):
        {text: str, usage: {...}, status: "complete"|..., reasoning?, warning?}

    `text` is the full final assistant response. `usage` carries token
    counts. `status` distinguishes complete vs error vs aborted —
    although errors usually arrive via their own _emit("error", ...).

    On every final, we ALSO extract bot-emitted media (via Hermes'
    `BasePlatformAdapter.extract_media/extract_images/extract_local_files`)
    so /app can render image_generate / text_to_speech / video_generate
    / write_file output as native attachment cards — same UX channels
    (Telegram/WA/Discord/Slack) already enjoy via their own platform
    adapters. The bridge serves these files over HTTP via opaque
    token URLs (`media_serve.register_media`) so the browser can fetch
    them without a portal-side proxy.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    raw_text = params.get("text") or ""
    usage = params.get("usage") or {}
    status = params.get("status") or "complete"

    # Reset the per-session accumulator now that the turn is done.
    accumulator.reset(session_key)

    if status not in ("complete", "ok", "done"):
        # Surface non-success completion as error state so UI can react
        # (e.g. show retry chip). Source: server-chat status semantics.
        # The engine often hands us a useless "error"/"failed" status here, so
        # localize from the most recent RAW provider error (stderr-captured) →
        # a clear layperson Bahasa message (credit vs throttle vs auth, etc).
        raw_status_msg = params.get("warning") or status
        try:
            import provider_errors
            error_message = provider_errors.localize(str(raw_status_msg))
        except Exception:
            error_message = str(raw_status_msg)
        return {
            "type": "event",
            "event": "chat",
            "payload": {
                "state": "error",
                "sessionKey": session_key,
                "errorMessage": error_message,
            },
        }

    # Extract media BEFORE brand-scrubbing so we get the raw MEDIA: paths
    # (the agent emits them verbatim per `PLATFORM_HINTS["webui"]`).
    bot_attachments: list[dict] = []
    try:
        from bot_media_extractor import extract_bot_media

        cleaned_text, bot_attachments = extract_bot_media(raw_text)
    except Exception:
        # Never let extraction crash the final event — fall through to
        # raw text so chat still works even if media plumbing breaks.
        cleaned_text = raw_text
        import logging as _log
        _log.getLogger("bridge.event_translator").exception(
            "_translate_message_complete: extract_bot_media crashed; "
            "delivering raw text only",
        )

    # Fallback: if agent USED a media-producing tool but FORGOT to embed
    # MEDIA: in its text, scan the relevant cache dir for files created
    # during this turn and auto-attach. Observed 2026-05-23: agent used
    # text_to_speech then wrote a conversational reply without the
    # MEDIA: tag — UI showed no AudioCard. This recovers the audio file
    # without requiring the agent to remember the tag.
    pending_tools = _pop_pending_media_tools(session_key)
    if pending_tools:
        already_attached_paths = {
            a["displayUrl"].split("/")[-1]  # rough dedup by filename
            for a in bot_attachments
            if isinstance(a, dict)
        }
        try:
            extra = _scan_recent_tool_outputs(
                pending_tools, exclude_filenames=already_attached_paths,
            )
            if extra:
                bot_attachments.extend(extra)
        except Exception:
            import logging as _log
            _log.getLogger("bridge.event_translator").exception(
                "cache scan fallback crashed; agent text used as-is",
            )

    # If the engine handed us one of its own provider-error templates AS the
    # assistant reply (status="complete" but text is "⏱️ The model provider is
    # rate-limiting…" etc), remap it to a clear layperson Bahasa message keyed
    # off the real raw cause (credit vs throttle vs auth). Otherwise leave the
    # agent's actual reply verbatim.
    try:
        import provider_errors
        if provider_errors.looks_like_engine_error_reply(cleaned_text):
            cleaned_text = provider_errors.localize(cleaned_text)
    except Exception:
        pass

    text = scrub_brand(cleaned_text)

    # Stamp the assistant final message with a STABLE agentbuff id derived
    # from its position in the session JSON. Hermes writes the message to
    # session_<dbkey>.json BEFORE emitting message.complete, so the assistant
    # row we're emitting is always the last entry in messages[]. /app uses
    # this id immediately for pin/delete/edit/react — without it, the
    # client falls back to a fresh UUID that the bridge can never anchor
    # back to JSON, and every persistence RPC silently fails (the bug
    # chief reported: pin marks vanish, deletes don't stick, etc.).
    agb_id: str | None = None
    try:
        from pathlib import Path as _Path
        import json as _json
        session_id_raw = params.get("session_id") or ""
        if session_id_raw:
            # Hermes' message.complete emits the SHORT sid form (e.g.
            # "50833386") not the dbkey (e.g. "20260523_183353_ded2bb").
            # Resolve via the bridge's sid↔dbkey alias map maintained by
            # rpc_router. Fall back to using the raw value as dbkey if no
            # alias is known yet (covers the first message on a session
            # whose alias hasn't been recorded — uncommon since
            # sessions.create + sessions.get both populate it).
            from rpc_router import get_dbkey_for_sid
            dbkey = get_dbkey_for_sid(session_id_raw) or session_id_raw
            json_path = _Path("/home/hermes/.hermes/sessions") / f"session_{dbkey}.json"
            if json_path.is_file():
                data = _json.loads(json_path.read_text(encoding="utf-8"))
                msgs = data.get("messages") or []
                if isinstance(msgs, list) and len(msgs) > 0:
                    # The assistant we're emitting is the last one.
                    # Suffix `:chat` matches what rpc_router._claude_blocks_from_raw_messages
                    # stamps for the chat-bubble half of an assistant row,
                    # so RPC lookups parse to the same source index.
                    agb_id = f"agb_{dbkey}_{len(msgs) - 1}:chat"
    except Exception:
        # Stable-id stamping is best-effort. If it fails, /app falls back to
        # a client-side UUID — pin/delete still works after a refresh
        # (when rpc_router._claude_blocks_from_raw_messages re-stamps).
        agb_id = None

    message_obj: dict = {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
    }
    if agb_id:
        message_obj["__agentbuff"] = {"id": agb_id}

    payload: dict = {
        "state": "final",
        "sessionKey": session_key,
        "message": message_obj,
        "usage": usage,
    }
    if bot_attachments:
        payload["attachments"] = bot_attachments

    # Auto-title PROFILE (per-agent) sessions. The engine titles only the ROOT
    # db (its title generator uses the launch SessionDB handle), so a
    # non-default agent's session row in profiles/<agent>/state.db stays
    # title=NULL forever -> /app shows the "Sesi utama" fallback no matter how
    # long the chat. Re-run the engine's OWN titler against the correct profile
    # db here, where we have the final assistant text. Fully isolated in its own
    # try/except + UPDATE-only + skips when already titled / row deleted, so it
    # can NEVER break or alter the chat-final event the user sees. (2026-06-09)
    try:
        if status in ("complete", "ok", "done") and text.strip():
            _agent_id, _sid = decanonicalize_session_key(session_key)
            if _agent_id and _agent_id.lower() not in ("", "main", "default"):
                # session_key is already canonical (sid->dbkey resolved), so
                # _sid is the dbkey; resolve defensively anyway.
                try:
                    from rpc_router import get_dbkey_for_sid as _gdb
                    _dbkey = _gdb(_sid) or _sid
                except Exception:
                    _dbkey = _sid
                from profile_title import maybe_title_profile_session

                maybe_title_profile_session(_agent_id, _dbkey, text)
    except Exception:
        import logging as _log

        _log.getLogger("bridge.event_translator").debug(
            "profile-title hook failed (non-fatal)", exc_info=True
        )

    return {
        "type": "event",
        "event": "chat",
        "payload": payload,
    }


def _translate_error_event(
    params: dict,
    accumulator: DeltaAccumulator,
    default_agent_id: str,
) -> dict:
    """Translate Hermes' generic `error` event to portal chat-event state=error.

    Hermes emits this from `_emit("error", sid, {"message": "..."})` on
    agent init failure (e.g. provider misconfigured, network down). The
    payload carries the user-facing message string at `params.message`.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    accumulator.reset(session_key)

    # G6: error text lives at top-level `message`, not in a nested error
    # object — mirrors OpenClaw's wire convention. Fall back to `error`
    # for any third-party bridge fork that nests differently.
    error_message = (
        params.get("message")
        or params.get("error")
        or "unknown error"
    )
    if not isinstance(error_message, str):
        error_message = str(error_message)

    # If this is a provider failure (or the engine handed us a coarse
    # "rate-limiting"/"failed" string), remap to a clear layperson Bahasa
    # message keyed off the real raw cause. Non-provider errors pass through.
    try:
        import provider_errors
        if provider_errors.looks_like_engine_error_reply(error_message) or provider_errors.recent():
            error_message = provider_errors.localize(error_message)
    except Exception:
        pass

    return {
        "type": "event",
        "event": "chat",
        "payload": {
            "state": "error",
            "sessionKey": session_key,
            "errorMessage": error_message,
        },
    }


def _translate_thinking_delta(
    params: dict,
    accumulator: DeltaAccumulator,
    default_agent_id: str,
) -> dict:
    """Hermes thinking.delta / reasoning.delta → portal agent stream=thinking.

    Hermes' payload carries the FULL merged reasoning text in `text` (NOT
    an incremental chunk). Earlier (broken) handler read `delta` which
    Hermes never emits → UI saw empty thinking blocks. Fixed to use
    `text` and replace the accumulator wholesale (same wire gotcha G5
    as message.delta).
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    full_text = params.get("text") or ""
    if isinstance(full_text, str) and full_text:
        accumulator.replace_thinking(session_key, full_text)

    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "thinking",
            "data": {
                "text": full_text,
                "signature": params.get("signature"),
                "redacted": bool(params.get("redacted", False)),
            },
        },
    }


def _translate_reasoning_available(
    params: dict,
    accumulator: DeltaAccumulator,
    default_agent_id: str,
) -> dict:
    """Hermes reasoning.available → portal agent stream=thinking final.

    Fires once at end-of-turn with the complete reasoning snapshot.
    Bridge resets the thinking accumulator after surfacing the final
    text (next turn starts fresh).
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    text = params.get("text") or ""
    if isinstance(text, str) and text:
        accumulator.replace_thinking(session_key, text)

    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "thinking",
            "data": {
                "text": text,
                "signature": params.get("signature"),
                "redacted": bool(params.get("redacted", False)),
            },
        },
    }


# ---------------------------------------------------------------------
# tool.* translators
# ---------------------------------------------------------------------
# Hermes emits 4 tool-lifecycle events with their own payload shapes;
# the portal's UI consumes a unified "agent stream=tool" stream with
# `phase` discriminator. Mapping:
#
#   Hermes event           → phase     UI uses for
#   ─────────────────────────────────────────────────────────────────
#   tool.start             → start     create tool_use card
#   tool.generating        → start*    show "generating..." indicator
#                                      (* deduped against real start)
#   tool.progress          → update    inject preview into card body
#   tool.complete          → result    finalize tool_result block
#
# UI dedupes by `toolCallId`. Events MUST share the same toolCallId
# across phases or the card splits into two. Hermes' tool.generating
# + tool.progress do NOT carry tool_id (only name), so we synthesize a
# stable id from name+session — best-effort, real tool.start will
# replace it once it arrives.


def _synthesize_tool_id(name: str, session_id: str) -> str:
    """Stable placeholder tool_id for tool.generating/progress frames
    that don't carry an explicit tool_id from Hermes."""
    return f"pending-{session_id}-{name}"


# Per-session bookkeeping of media-producing tool calls fired during the
# current turn. When the agent uses `text_to_speech` / `image_generate` /
# `video_generate` we record the timestamp + tool name. On
# `message.complete`, if the agent forgot to embed `MEDIA:/path` in its
# text (observed 2026-05-23: bot replied conversationally without
# embedding TTS file path), the bridge scans the relevant Hermes cache
# directory for files created in this turn and auto-attaches them.
#
# Keyed by canonical session_key → list of {tool_name, started_at}.
_MEDIA_TOOL_TURNS: dict[str, list[dict]] = {}

# Tool name → cache dir under HERMES_HOME where its output lands. Hermes
# tools write to consistent paths per `gateway/platforms/base.py:548-898`.
_TOOL_OUTPUT_DIRS = {
    "text_to_speech": ["cache/audio", "audio_cache"],
    "image_generate": ["cache/images", "image_cache"],
    "video_generate": ["cache/videos", "video_cache"],
}


def _record_media_tool_start(session_key: str, tool_name: str) -> None:
    import time as _time
    if tool_name not in _TOOL_OUTPUT_DIRS:
        return
    _MEDIA_TOOL_TURNS.setdefault(session_key, []).append({
        "tool_name": tool_name,
        "started_at": _time.time(),
    })


def _pop_pending_media_tools(session_key: str) -> list[dict]:
    return _MEDIA_TOOL_TURNS.pop(session_key, [])


def _scan_recent_tool_outputs(
    pending_tools: list[dict],
    *,
    exclude_filenames: set[str] | None = None,
) -> list[dict]:
    """For each pending media-producing tool, scan its cache dir for
    files created after the tool started. Register them with media_serve
    + return attachment dicts.

    The 60-second window is generous — fast generations land in <5s, but
    edge TTS for long text can take 30-40s. We use earliest tool start
    time as the lower bound so multi-tool turns work.
    """
    import os as _os
    import time as _time
    from pathlib import Path as _Path

    if not pending_tools:
        return []
    earliest_start = min(t.get("started_at", _time.time()) for t in pending_tools)
    earliest_start -= 2.0  # tolerance for clock skew
    home = _os.environ.get("HERMES_HOME") or str(_Path.home() / ".hermes")
    home_path = _Path(home)

    tool_names = {t["tool_name"] for t in pending_tools}
    dirs_to_scan: list[_Path] = []
    for tool_name in tool_names:
        for rel in _TOOL_OUTPUT_DIRS.get(tool_name, []):
            d = home_path / rel
            if d.is_dir():
                dirs_to_scan.append(d)

    if not dirs_to_scan:
        return []

    candidates: list[_Path] = []
    for d in dirs_to_scan:
        try:
            for entry in d.iterdir():
                if not entry.is_file():
                    continue
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                if mtime < earliest_start:
                    continue
                if exclude_filenames and entry.name in exclude_filenames:
                    continue
                candidates.append(entry)
        except OSError:
            continue

    if not candidates:
        return []

    # Sort newest-first; cap at 3 to avoid surprise multi-attach.
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    candidates = candidates[:3]

    try:
        from bot_media_extractor import _process_media_path  # type: ignore
    except ImportError:
        import logging as _log
        _log.getLogger("bridge.event_translator").warning(
            "_scan_recent_tool_outputs: cannot import _process_media_path",
        )
        return []

    bridge_host = _os.environ.get("BRIDGE_PUBLIC_HOST", "127.0.0.1")
    try:
        bridge_port = int(_os.environ.get("BRIDGE_PUBLIC_HEALTH_PORT", "18790"))
    except (TypeError, ValueError):
        bridge_port = 18790

    attachments: list[dict] = []
    for p in candidates:
        display_url, kind, size, mime = _process_media_path(
            str(p), bridge_host, bridge_port,
        )
        if not display_url:
            continue
        # Voice-note naming heuristic so AudioCard styling kicks in for
        # short TTS audio (matches the inbound VN behaviour where
        # filename starts with `voice-note-`). Optional — keeps UX
        # consistent between recorded VN and TTS reply.
        filename = p.name
        if kind == "audio" and not filename.startswith("voice-note-"):
            stem = p.stem
            ext = p.suffix
            filename = f"voice-note-{stem}{ext}"
        attachments.append({
            "kind": kind,
            "name": filename,
            "displayUrl": display_url,
            "sizeBytes": size,
            "mimeType": mime,
        })

    if attachments:
        import logging as _log
        _log.getLogger("bridge.event_translator").info(
            "cache scan fallback: agent forgot MEDIA: but %d file(s) "
            "found in %s — auto-attaching",
            len(attachments),
            [str(d) for d in dirs_to_scan],
        )
    return attachments


def _translate_tool_start(params: dict, default_agent_id: str) -> dict:
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    tool_id = params.get("tool_id") or _synthesize_tool_id(
        params.get("name") or "tool", params.get("session_id") or "main",
    )
    name = params.get("name") or "tool"
    # Track media-producing tools so we can auto-attach if agent forgets
    # to embed MEDIA: in its final response.
    _record_media_tool_start(session_key, name)
    # Hermes' `context` carries a human-readable preview of args (often
    # a Python expression for execute_code). Pass it as input.preview
    # so UI can show it in the tool_use card.
    raw_ctx = params.get("context")
    args: dict = {}
    if isinstance(raw_ctx, dict):
        args = raw_ctx
    elif isinstance(raw_ctx, str) and raw_ctx:
        # Stringly context → wrap so UI ToolUseCard can render it.
        args = {"preview": raw_ctx}
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "tool",
            "data": {
                "toolCallId": tool_id,
                "name": name,
                "phase": "start",
                "args": args,
            },
        },
    }


def _translate_tool_complete(params: dict, default_agent_id: str) -> dict:
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    tool_id = params.get("tool_id") or _synthesize_tool_id(
        params.get("name") or "tool", params.get("session_id") or "main",
    )
    name = params.get("name") or "tool"
    # Hermes' tool.complete payload: {tool_id, name, duration_s, summary,
    # [todos], [inline_diff]}. Assemble a result body the UI ToolResultCard
    # can render — prefer inline_diff > summary > "ok" placeholder.
    inline_diff = params.get("inline_diff")
    summary = params.get("summary")
    todos = params.get("todos")
    duration_s = params.get("duration_s")
    if inline_diff and isinstance(inline_diff, str):
        result_body = scrub_brand(inline_diff)
    elif summary and isinstance(summary, str):
        result_body = scrub_brand(summary)
    elif todos:
        import json as _json
        try:
            result_body = _json.dumps(todos, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            result_body = str(todos)
        result_body = scrub_brand(result_body)
    elif duration_s is not None:
        result_body = f"completed in {duration_s:.2f}s"
    else:
        result_body = "ok"
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "tool",
            "data": {
                "toolCallId": tool_id,
                "name": name,
                "phase": "result",
                "result": result_body,
                "isError": False,  # Hermes signals errors via the `error` event, not here
            },
        },
    }


def _translate_tool_progress(params: dict, default_agent_id: str) -> dict:
    """tool.progress → phase=update with `preview` as partial result.

    Hermes emits this mid-execution (e.g. tool prints progress to stdout).
    Without an explicit tool_id, we synthesize one from name+session;
    a subsequent tool.start arriving with a real id will reset the card.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    name = params.get("name") or "tool"
    tool_id = params.get("tool_id") or _synthesize_tool_id(
        name, params.get("session_id") or "main",
    )
    preview = params.get("preview") or ""
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "tool",
            "data": {
                "toolCallId": tool_id,
                "name": name,
                "phase": "update",
                "partialResult": preview,
            },
        },
    }


def _translate_tool_generating(params: dict, default_agent_id: str) -> dict:
    """tool.generating → phase=start placeholder.

    Fires when the LLM is generating tool input but tool hasn't started
    executing yet. UI shows "generating ..." in the card. No tool_id —
    we synthesize so the eventual tool.start can replace.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    name = params.get("name") or "tool"
    tool_id = _synthesize_tool_id(name, params.get("session_id") or "main")
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "tool",
            "data": {
                "toolCallId": tool_id,
                "name": name,
                "phase": "start",
                "args": {},
                # `pendingSynth=true` is a signal to the store: when a later
                # tool.start arrives with the real tool_id and same name,
                # merge/replace this pending card instead of creating a new
                # one. Without this hint the store can't tell which cards
                # are eligible for ID migration.
                "pendingSynth": True,
            },
        },
    }


# ---------------------------------------------------------------------
# subagent.* translators
# ---------------------------------------------------------------------
# Hermes' delegate_task tool spawns subagents. Each subagent's lifecycle
# emits 3 event types that form a tree:
#   subagent.start    → spawn tree node opens with goal + position
#   subagent.tool     → nested tool call within the subagent
#   subagent.complete → spawn tree node closes with token/cost stats
#
# Portal /app renders these as agent stream=subagent so chat-thread can
# show a nested execution tree (or at least a collapsible card per
# subagent run, matching TUI's tree view).


def _translate_subagent(method: str, params: dict, default_agent_id: str) -> dict:
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    # Discriminate by the last segment of the event name.
    phase_map = {
        "subagent.start": "start",
        "subagent.tool": "tool",
        "subagent.complete": "complete",
    }
    phase = phase_map.get(method, "unknown")
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "subagent",
            "data": {
                "phase": phase,
                "subagentId": params.get("subagent_id"),
                "parentId": params.get("parent_id"),
                "depth": params.get("depth"),
                "goal": params.get("goal"),
                "taskIndex": params.get("task_index"),
                "taskCount": params.get("task_count"),
                "model": params.get("model"),
                "toolName": params.get("tool_name"),
                "toolPreview": params.get("tool_preview") or params.get("text"),
                "inputTokens": params.get("input_tokens"),
                "outputTokens": params.get("output_tokens"),
                "costUsd": params.get("cost_usd"),
                "summary": params.get("summary"),
                "durationSeconds": params.get("duration_seconds"),
            },
        },
    }


# ---------------------------------------------------------------------
# status.update translator
# ---------------------------------------------------------------------
# Hermes emits `{kind, text}` for background process / cron / async task
# completions. TUI shows in status bar + toast. We surface as inline
# transient status pill via agent stream=status — store will render in
# transcript so chief sees activity inline.


def _translate_status_update(params: dict, default_agent_id: str) -> dict:
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "status",
            "data": {
                "kind": params.get("kind") or "info",
                "text": params.get("text") or "",
            },
        },
    }


def _translate_rich_block(
    method: str,
    params: dict,
    default_agent_id: str,
) -> dict:
    """Translate a rich-block emit RPC (poll.show, dice.show, etc) into
    a portal `agent` event with the typed block payload. /app store
    appends the block to the active assistant message's blocks array
    (via _applyAgentEvent stream="rich_block" branch).

    The wire event shape is intentionally generic — `kind` field
    differentiates poll vs dice vs location, and `data` carries the
    full block payload (already shaped per `rpc-types.ts`).
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or params.get("sessionKey") or "main",
        default_agent_id,
    )
    # `kind` mirrors the rpc-types ContentBlock `type` field exactly so
    # /app can directly construct the typed block.
    kind = method.split(".", 1)[0]  # "poll.show" → "poll"
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "rich_block",
            "data": {
                "kind": kind,
                "block": params.get("block") or params,
            },
        },
    }


def _translate_review_summary(params: dict, default_agent_id: str) -> dict:
    """Telegram parity: `💾 Pembaruan profil: <summary>` after each turn
    where the agent's background review actually committed changes
    (memory write, user profile update, skill create/update).

    Hermes' Telegram + Discord adapters render this verbatim as a
    plain message at end of turn. /app renders via status.update kind
    so existing StatusUpdateRow picks it up uniformly. The text is
    LOCALIZED here to Indonesian so mass-market users see Bahasa
    instead of the English `Self-improvement review:` prefix Hermes
    uses for English channels.
    """
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    raw_text = (params.get("text") or "").strip()
    # Hermes' English prefix → Bahasa Indonesia for /app.
    # Pattern: "Self-improvement review: User profile updated · ..."
    bahasa_text = raw_text
    if raw_text.lower().startswith("self-improvement review"):
        # Strip prefix, prepend Bahasa label + emoji.
        rest = raw_text.split(":", 1)
        if len(rest) == 2:
            bahasa_text = f"💾 Pembaruan profil:{rest[1]}"
    elif raw_text and not raw_text.startswith(("💾", "📝", "🧠")):
        # Plain summary without prefix — wrap.
        bahasa_text = f"💾 Pembaruan profil: {raw_text}"
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "status",
            "data": {
                "kind": "review",
                "text": bahasa_text,
            },
        },
    }


# ---------------------------------------------------------------------
# approval.request / clarify.request translators
# ---------------------------------------------------------------------
# Engine pauses for user input. Portal renders these as inline action
# blocks with buttons. Bridge passes through the full request envelope —
# store + UI handle interactive response submission separately.


def _translate_approval_request(params: dict, default_agent_id: str) -> dict:
    """Translate Hermes' `approval.request` wire event into a portal
    chat-block payload. Hermes ships the prompt envelope via
    `tools.approval.notify_gateway(data)` where `data` is a dict
    `{command, pattern_key, pattern_keys, description, id}` (verified
    via `tools/approval.py:1195-1200`). We pass everything through so
    /app can render the full command preview + reason without an
    extra round-trip."""
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "approval",
            "data": {
                "requestId":
                    params.get("id")
                    or params.get("request_id")
                    or params.get("approval_id"),
                "title": params.get("title") or "Perlu persetujuan",
                "summary": params.get("summary") or params.get("message"),
                # NEW fields — full Telegram parity. Hermes' approval
                # payload always includes `command` and `description`.
                "command": params.get("command"),
                "description": params.get("description"),
                "patternKeys": params.get("pattern_keys")
                    or ([params.get("pattern_key")] if params.get("pattern_key") else []),
                "kind": params.get("kind") or "generic",
                "details": params.get("details"),
                "raw": params,  # full envelope for action handler
            },
        },
    }


def _translate_clarify_request(params: dict, default_agent_id: str) -> dict:
    """Translate the bridge-injected (via `interactive_bridge.py`
    plugin patch) `clarify.request` wire event into a portal chat-block
    payload. Hermes' clarify primitive carries
    `{request_id, session_key, question, choices}` per
    `tools/clarify_gateway.py::_ClarifyEntry` dataclass — see
    `hermes_plugin_files/interactive_bridge.py::_clarify_entry_to_payload`
    for the exact shape produced."""
    session_key = canonicalize_session_key(
        params.get("session_id")
        or params.get("session_key")
        or "main",
        default_agent_id,
    )
    choices_raw = params.get("choices") or []
    # Defensive: dedupe + cap at Hermes' 4-choice limit (the 5th slot
    # is the "Other / type answer" textarea, which /app adds client-side).
    choices = [str(c) for c in choices_raw if c is not None][:4]
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "clarify",
            "data": {
                "requestId":
                    params.get("id")
                    or params.get("request_id")
                    or params.get("clarify_id"),
                "question":
                    params.get("question") or params.get("prompt") or "",
                "choices": choices,
                "sessionKey": session_key,
            },
        },
    }


# ---------------------------------------------------------------------
# browser.progress translator
# ---------------------------------------------------------------------
# Auto-browser tool live feed — `{message, level}`. Store renders as a
# progress pill in transcript so chief sees what browser tool is doing.


def _translate_browser_progress(params: dict, default_agent_id: str) -> dict:
    session_key = canonicalize_session_key(
        params.get("session_id") or "main", default_agent_id,
    )
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "sessionKey": session_key,
            "runId": params.get("run_id"),
            "stream": "browser",
            "data": {
                "message": params.get("message") or "",
                "level": params.get("level") or "info",
                "url": params.get("url"),
            },
        },
    }
