"""
bot_media_extractor.py — Extract bot-emitted media from agent response text.

Reuses Hermes' own `BasePlatformAdapter.extract_media`,
`extract_images`, and `extract_local_files` static methods (see
`HermesAgent/gateway/platforms/base.py:1971-2267`) so /app receives
exactly the same media delivery semantics as Telegram/WA/Discord/Slack
channel adapters — no re-implementation, no behaviour drift.

What the agent emits (per `HermesAgent/agent/prompt_builder.py:587-598`
when HERMES_PLATFORM=webui is set):
  * `MEDIA:/absolute/path/to/file` — generic media tag, routed by ext
  * `MEDIA:https://...` — remote URL pulled into chat
  * `[[audio_as_voice]]` — directive forcing audio = voice bubble
  * `[[as_document]]` — directive forcing image-ext = document download
  * `![alt](url)` markdown image syntax (for remote URLs only)
  * Bare absolute local paths (e.g. `~/output/x.png` in plain text)

The agent uses the SAME tools that produce media on channels:
  * `image_generate` → returns `{image: "url-or-path"}` → agent embeds in text
  * `video_generate` → returns `{video: "url-or-path"}` → embedded
  * `text_to_speech` → returns `{media_tag: "MEDIA:/path/x.mp3"}` →
                       agent appends the media_tag verbatim

After extraction:
  * Local file paths → registered with `media_serve.register_media()`
    to obtain a one-time HTTP token, then a public URL built off the
    bridge's health-server hostname:port.
  * Remote URLs (HTTPS) → emitted as-is for direct browser fetch.
  * The cleaned text (with MEDIA tags + directives stripped) is what
    `/app` displays as the assistant bubble's prose.

This module is the SOLE point of integration between Hermes' outbound
media pipeline and AgentBuff's `/app` web UI.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
from pathlib import Path
from typing import Optional

import media_serve

log = logging.getLogger("bridge.bot_media_extractor")

# Matches `MEDIA:http://...` or `MEDIA:https://...` tags in agent text.
# Hermes' `BasePlatformAdapter.extract_media` only matches LOCAL paths,
# so URL-based MEDIA tags pass through unextracted and leak as plaintext
# (markdown auto-linkified into a clickable link). Observed 2026-05-23
# when chief asked agent to reflect his VN — agent grabbed the URL from
# the PORTAL_ATTACHMENT_URLS sentinel context and emitted
# `MEDIA:http://127.0.0.1:38800/media/<token>/audio.webm` which the UI
# rendered as a link instead of an AudioCard. Pre-pass extracts these
# BEFORE the local-path pass so the URL goes through `_process_media_path`
# (which handles HTTP at lines 278-281) and emits an attachment dict.
#
# Pattern: \bMEDIA: + http(s) URL, stop at whitespace or `]` (Markdown
# bracket boundary). Trailing punctuation (`.`,`,`)`,`}`,`>`) is stripped
# from the captured URL since agents sometimes write `MEDIA:http://x.png.`
# at end of a sentence.
MEDIA_HTTP_RE = re.compile(
    r"\bMEDIA:(https?://\S+?)(?=\s|\]|$)",
    re.MULTILINE,
)
# Companion directive `[[audio_as_voice]]` — must be stripped from the
# remaining text after URL extraction so it doesn't render as plaintext.
AUDIO_AS_VOICE_RE = re.compile(r"\[\[audio_as_voice\]\]")
# Gap #5: `[[as_document]]` — agent's "deliver this as a downloadable file"
# directive. Telegram routes the file through send_document; on /app we set
# forceDocument on the matching attachment + MUST strip the literal directive
# so it never leaks as plaintext (the brand-protect span keeps `[[...]]`
# verbatim, so without this strip it would survive into the bubble).
AS_DOCUMENT_RE = re.compile(r"\[\[as_document\]\]")
# Local `MEDIA:<path>` matcher used ONLY for the [[as_document]] pre-scan so we
# can correlate the directive with a specific path (the engine's extract_media
# strips the path before we'd otherwise see the trailing directive). Extraction
# itself still goes through BasePlatformAdapter.extract_media — this is just a
# position probe. Mirrors the engine's path anchor (drive-letter / abs / ~).
MEDIA_LOCAL_RE = re.compile(r"\bMEDIA:((?:[A-Za-z]:[\\/]|/|~/)\S+)")


def _classify_by_extension(path_or_url: str) -> str:
    """Classify a file path or URL by extension into one of:
    `image`, `audio`, `video`, `document`, `unknown`.
    Mirrors the bridge's per-kind routing for inbound attachments
    (`attachment_preprocessor.py`) so /app renders the right card."""
    ext = ""
    # Strip query string + hash from URLs first.
    cleaned = path_or_url.split("?", 1)[0].split("#", 1)[0]
    dot = cleaned.rfind(".")
    if dot >= 0:
        ext = cleaned[dot:].lower()
    if ext in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".bmp", ".svg"}:
        return "image"
    if ext in {".mp3", ".ogg", ".opus", ".wav", ".m4a", ".flac", ".oga", ".aac", ".weba"}:
        return "audio"
    # `.webm` is a container that can hold audio OR video. Hermes stores voice
    # notes under audio_cache/ as `.webm`; disambiguate by cache dir so a voice
    # note classifies as audio (AudioCard player) not video (black VideoCard).
    if ext == ".webm":
        low = cleaned.lower()
        return "audio" if ("/audio_cache/" in low or "/audio/" in low) else "video"
    if ext in {".mp4", ".mov", ".mkv", ".avi", ".mpeg", ".mpg", ".qt", ".m4v", ".3gp"}:
        return "video"
    if ext in {
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".txt", ".csv", ".tsv", ".md", ".json", ".xml", ".yaml", ".yml",
        ".zip", ".rar", ".7z", ".epub", ".apk", ".ipa",
        ".html", ".htm", ".log", ".ini", ".cfg", ".env",
    }:
        return "document"
    return "unknown"


def _build_url_for_local(
    path: Path, host: str, health_port: int
) -> Optional[str]:
    """Build a DURABLE public URL for a local file (survives the 24h cache TTL
    + container restart); falls back to the legacy token URL internally.
    Returns None if path is outside allowed roots."""
    return media_serve.public_url_durable(path, host=host, port=health_port)


def _attachment_dict(
    kind: str,
    filename: str,
    display_url: str,
    size_bytes: Optional[int],
    mime_type: Optional[str],
    *,
    is_voice_note: bool = False,
    force_document: bool = False,
) -> dict:
    """Shape consumed by /app rpc-types AttachmentPart.

    `is_voice_note` (gap #7): explicit typed flag replacing the brittle
    `voice-note-<name>` filename heuristic. Telegram sends a true `send_voice`
    message for `[[audio_as_voice]]`/TTS replies; /app's AudioCard renders the
    round voice-bubble style off this flag (with the filename heuristic kept as
    a fallback for sessions persisted before the flag existed).

    `force_document` (gap #5): the agent emitted `[[as_document]]` next to this
    media so it should render as a downloadable DocumentCard rather than an
    inline photo (Telegram routes these through `send_document` to preserve
    original bytes; on web the browser never recompresses, so we only need the
    download affordance + to make sure the directive itself never leaks)."""
    # A voice-note `.webm` guesses `video/webm`; the <audio> element needs
    # `audio/webm` to negotiate the right decoder. Mirrors the history-side
    # rewrite in extract-bot-media.ts so live + refresh agree.
    if is_voice_note and mime_type and mime_type.startswith("video/"):
        mime_type = "audio/" + mime_type.split("/", 1)[1]
    d = {
        "kind": kind,
        "name": filename,
        "displayUrl": display_url,
        "sizeBytes": size_bytes,
        "mimeType": mime_type,
    }
    if is_voice_note:
        d["isVoiceNote"] = True
    if force_document:
        d["forceDocument"] = True
    return d


def _default_bridge_public_host() -> str:
    """External hostname browsers use to reach this bridge's HTTP server.
    Defaults to 127.0.0.1 (host loopback). Overridable via env."""
    return (
        os.environ.get("BRIDGE_PUBLIC_HOST")
        # OPENCLAW_PUBLIC_HOST fallback removed 2026-06-03 (OpenClaw purge —
        # never set; the canonical var is BRIDGE_PUBLIC_HOST).
        or "127.0.0.1"
    )


def _default_bridge_public_health_port() -> int:
    """External port the bridge HTTP server is published on. Container
    binds health server on `BRIDGE_HEALTH_PORT` (18790 default), but
    Docker maps that to a different host port (e.g. 18801) — set this
    env so attachment URLs we hand /app point at the host-facing port."""
    raw = (
        os.environ.get("BRIDGE_PUBLIC_HEALTH_PORT")
        or os.environ.get("BRIDGE_HEALTH_PORT")
        or "18790"
    )
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 18790


def extract_bot_media(
    text: str,
    *,
    bridge_host: Optional[str] = None,
    health_port: Optional[int] = None,
) -> tuple[str, list[dict]]:
    """Extract media from an assistant response.

    Returns:
        (cleaned_text, attachments)

        cleaned_text: same text with MEDIA tags + audio_as_voice/as_document
                      directives + local-file path references stripped.
                      This is what /app displays in the bubble.
        attachments:  list of attachment dicts ready to ship in the chat
                      event's `attachments` field. Each dict has
                      {kind, name, displayUrl, sizeBytes, mimeType}.

    Defensive: any exception during extraction is caught and logged; we
    return the original text + empty list so the bot message at least
    surfaces as plain prose if extraction fails. Never crash the event
    pipeline.
    """
    if not text:
        return text, []

    # Normalise markdown-local media the agent emits on RESEND (gpt/codex) —
    # `![alt](sandbox:/x.jpg)` (image syntax) / `[Voice note](sandbox:/x.webm)`
    # (link syntax) — into MEDIA: tags FIRST, so the proven passes below extract
    # them into rich AttachmentPart cards (rendered OUTSIDE the bubble) instead
    # of leaving a broken inline <img> / dead link inside the prose.
    text = media_serve.normalize_markdown_media_to_tags(text)

    if bridge_host is None:
        bridge_host = _default_bridge_public_host()
    if health_port is None:
        health_port = _default_bridge_public_health_port()

    try:
        from gateway.platforms.base import BasePlatformAdapter
    except ImportError as exc:
        # Hermes' gateway module unavailable — should NEVER happen since
        # the bridge runs in the same Python env as hermes-agent. But
        # belt-and-suspenders: degrade to passthrough so chat still works.
        log.warning(
            "bot_media_extractor: cannot import BasePlatformAdapter (%s) "
            "— extraction skipped, bot media will leak as raw MEDIA: text",
            exc,
        )
        return text, []

    attachments: list[dict] = []
    cleaned = text

    # ── Pre-scan: correlate each MEDIA local path with the directive that
    # FOLLOWS it ([[as_document]] = gap #5, [[audio_as_voice]] = gap #7). We
    # must do this on the ORIGINAL text because (a) the engine's extract_media
    # strips the path before we'd see the trailing directive and (b) we strip
    # the directives ourselves later — so probe positions up-front. This makes
    # voice/document detection independent of the engine's own (order-sensitive)
    # is_voice flag.
    force_doc_paths: set[str] = set()
    force_voice_paths: set[str] = set()
    try:
        for _m in MEDIA_LOCAL_RE.finditer(text):
            _raw = _m.group(1).strip().rstrip(".,)]}>")
            _tail = text[_m.end():_m.end() + 80]
            if AS_DOCUMENT_RE.search(_tail):
                force_doc_paths.add(_raw)
                force_doc_paths.add(os.path.expanduser(_raw))
            if AUDIO_AS_VOICE_RE.search(_tail):
                force_voice_paths.add(_raw)
                force_voice_paths.add(os.path.expanduser(_raw))
    except Exception:
        log.debug("bot_media_extractor: directive pre-scan failed", exc_info=True)

    # ── Pass 0: MEDIA:http(s)://... URLs (Hermes' extract_media regex
    # matches LOCAL paths only — this catches URL-form MEDIA tags that
    # would otherwise leak as plaintext links). Bug 2 fix, 2026-05-23.
    try:
        url_matches = list(MEDIA_HTTP_RE.finditer(cleaned))
        for match in url_matches:
            url = match.group(1).strip().rstrip(".,)]}>")
            # Look ~80 chars ahead for the [[audio_as_voice]] / [[as_document]]
            # companion directives (agent typically emits them on the next line).
            tail = cleaned[match.end():match.end() + 80]
            is_voice = "[[audio_as_voice]]" in tail
            is_doc = "[[as_document]]" in tail
            display_url, kind, size, mime = _process_media_path(
                url, bridge_host, health_port,
            )
            if not display_url:
                continue
            base_name = os.path.basename(url.split("?", 1)[0].split("#", 1)[0]) or "attachment"
            voice = kind == "audio" and is_voice
            force_doc = is_doc and kind == "image"
            attachments.append(
                _attachment_dict(
                    "document" if force_doc else kind,
                    base_name, display_url, size, mime,
                    is_voice_note=voice,
                    force_document=force_doc,
                ),
            )
        # Strip MEDIA:URL tags only. The [[audio_as_voice]]/[[as_document]]
        # directives are stripped at the END (after Pass 1) — stripping them
        # here would hide [[audio_as_voice]] from the engine's extract_media in
        # Pass 1, killing local-path voice detection (the directive pre-scan
        # above already captured positions, so detection is safe either way).
        cleaned = MEDIA_HTTP_RE.sub("", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    except Exception:
        # Defensive — fall through to Pass 1 below (local paths still extract)
        # so chat survives even if this pre-pass blows up.
        log.exception(
            "bot_media_extractor: MEDIA:URL pre-pass crashed; falling through",
        )

    # ── Pass 1: MEDIA:<path> tags (highest precedence, most explicit) ──
    try:
        media_list, cleaned_after_media = BasePlatformAdapter.extract_media(cleaned)
        for raw_path, is_voice in media_list:
            display_url, kind, size, mime = _process_media_path(
                raw_path, bridge_host, health_port,
            )
            if not display_url:
                continue
            # Gap #7: `[[audio_as_voice]]` (engine's is_voice) now rides as an
            # explicit `isVoiceNote` flag — the REAL filename is preserved (no
            # more brittle `voice-note-` rename). Gap #5: a path tagged
            # [[as_document]] (pre-scanned above) becomes a downloadable doc.
            voice = kind == "audio" and (
                is_voice
                or raw_path in force_voice_paths
                or os.path.expanduser(raw_path) in force_voice_paths
            )
            force_doc = kind == "image" and (
                raw_path in force_doc_paths
                or os.path.expanduser(raw_path) in force_doc_paths
            )
            attachments.append(
                _attachment_dict(
                    "document" if force_doc else kind,
                    os.path.basename(raw_path),
                    display_url, size, mime,
                    is_voice_note=voice,
                    force_document=force_doc,
                ),
            )
        cleaned = cleaned_after_media
    except Exception:
        log.exception("bot_media_extractor: extract_media crashed; skipping")

    # ── Pass 1.5 (catch-all): ANY-extension MEDIA:<local path> ──────────
    # The engine's extract_media regex only matches a FIXED set of "deliverable"
    # extensions (images/audio/video + a doc whitelist). MEDIA: tags for ANY
    # other type the agent generates (.py, .bin, .epub, .ipynb, …) slip through
    # unextracted — they'd leak as plaintext AND never deliver, so /app couldn't
    # show files the channel adapters also can't. Catch every remaining
    # MEDIA:<local path> (any extension) so /app delivers EVERY file type the
    # agent emits — strictly more complete than Telegram. Pass 1 already stripped
    # the known-extension matches, so this only sees the leftovers (no dupes).
    # _process_media_path classifies (unknown -> "document" download card) and
    # registers via media_serve, whose _is_sensitive_file still refuses secrets.
    try:
        for _m in MEDIA_LOCAL_RE.finditer(cleaned):
            _raw = _m.group(1).strip().rstrip(".,)]}>")
            _disp, _kind, _size, _mime = _process_media_path(
                _raw, bridge_host, health_port,
            )
            if not _disp:
                continue
            # Honor the [[audio_as_voice]] / [[as_document]] directives the
            # pre-scan captured (Pass 1 already does this; the catch-all didn't,
            # so a `.webm` voice note normalised from `[Voice note](…)` would
            # classify as VIDEO and render a black VideoCard instead of an
            # AudioCard player). A voice-tagged ref is always audio.
            _exp = os.path.expanduser(_raw)
            _is_voice = _raw in force_voice_paths or _exp in force_voice_paths
            _force_doc = _raw in force_doc_paths or _exp in force_doc_paths
            if _is_voice:
                _kind = "audio"
                # `.webm` guesses video/webm; the <audio> element needs
                # audio/webm to pick the right decoder path.
                if _mime and _mime.startswith("video/"):
                    _mime = "audio/" + _mime.split("/", 1)[1]
            if _force_doc:
                _kind = "document"
            attachments.append(
                _attachment_dict(
                    _kind, os.path.basename(_raw), _disp, _size, _mime,
                    is_voice_note=_is_voice,
                    force_document=_force_doc,
                ),
            )
        cleaned = MEDIA_LOCAL_RE.sub("", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    except Exception:
        log.exception("bot_media_extractor: catch-all MEDIA pass crashed; skipping")

    # ── Pass 2: ![alt](url) markdown images + <img src> ──
    # Hermes' extract_images only emits REMOTE URLs (HTTP/HTTPS or known
    # fal.media CDN domains). Local file paths in markdown img syntax
    # are NOT extracted here (per Hermes' design; agents are told to use
    # MEDIA: for local files).
    try:
        image_list, cleaned_after_imgs = BasePlatformAdapter.extract_images(cleaned)
        for image_url, _alt in image_list:
            # Remote URL — no media_serve registration needed, browser
            # fetches direct. Classify by URL ext when possible.
            kind = _classify_by_extension(image_url)
            if kind == "unknown":
                kind = "image"  # extract_images only returns images by design
            attachments.append(
                _attachment_dict(
                    kind=kind,
                    filename=os.path.basename(
                        image_url.split("?", 1)[0].split("#", 1)[0],
                    ) or "image",
                    display_url=image_url,
                    size_bytes=None,
                    mime_type=mimetypes.guess_type(image_url)[0],
                ),
            )
        cleaned = cleaned_after_imgs
    except Exception:
        log.exception("bot_media_extractor: extract_images crashed; skipping")

    # ── Pass 3: bare absolute local paths in plain text ──
    # Catches the agent saying "saved to /tmp/x.pdf" without an explicit
    # MEDIA tag — Hermes' extract_local_files validates `os.path.isfile()`
    # so we won't fabricate cards for paths that don't exist.
    try:
        local_list, cleaned_after_local = BasePlatformAdapter.extract_local_files(cleaned)
        for raw_path in local_list:
            display_url, kind, size, mime = _process_media_path(
                raw_path, bridge_host, health_port,
            )
            if not display_url:
                continue
            attachments.append(
                _attachment_dict(
                    kind, os.path.basename(raw_path), display_url, size, mime,
                ),
            )
        cleaned = cleaned_after_local
    except Exception:
        log.exception("bot_media_extractor: extract_local_files crashed; skipping")

    # Strip the companion directives now that extraction (which needs to SEE
    # [[audio_as_voice]]) is done — they must never survive to the bubble.
    # Idempotent + whitespace-tidied. Covers both local-path (Pass 1) and any
    # floating URL-pass directives.
    if "[[audio_as_voice]]" in cleaned or "[[as_document]]" in cleaned:
        cleaned = AUDIO_AS_VOICE_RE.sub("", cleaned)
        cleaned = AS_DOCUMENT_RE.sub("", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    if attachments:
        log.info(
            "bot_media_extractor: extracted %d attachment(s) from agent response "
            "(text reduced from %d to %d chars)",
            len(attachments), len(text), len(cleaned),
        )

    return cleaned, attachments


def _process_media_path(
    raw_path: str,
    bridge_host: str,
    health_port: int,
) -> tuple[Optional[str], str, Optional[int], Optional[str]]:
    """Resolve a single MEDIA path/URL into (displayUrl, kind, size, mime).

    For HTTPS URLs: passes through unchanged.
    For local paths: registers with media_serve + builds public URL.
    Returns (None, "unknown", None, None) if path doesn't exist OR isn't
    in an allowed root — caller skips it.
    """
    if raw_path.startswith(("http://", "https://")):
        kind = _classify_by_extension(raw_path)
        if kind == "unknown":
            # Mirror the local-path remap below: a remote URL with no / unknown
            # extension (e.g. a presigned link without a file ext) still delivers
            # as a downloadable document card rather than the renderless
            # 'unknown' kind /app has no card for.
            kind = "document"
        mime = mimetypes.guess_type(raw_path)[0]
        return raw_path, kind, None, mime

    # Local path — expand ~ + register.
    path = Path(os.path.expanduser(raw_path))
    try:
        if not path.is_file():
            log.debug("bot_media_extractor: path not a file: %s", raw_path)
            return None, "unknown", None, None
    except OSError:
        return None, "unknown", None, None
    url = _build_url_for_local(path, bridge_host, health_port)
    if not url:
        # Registration refused (path outside allowed roots).
        return None, "unknown", None, None
    kind = _classify_by_extension(str(path))
    if kind == "unknown":
        kind = "document"  # default for files Hermes thinks worth delivering
    try:
        size = path.stat().st_size
    except OSError:
        size = None
    mime = mimetypes.guess_type(str(path))[0]
    return url, kind, size, mime
