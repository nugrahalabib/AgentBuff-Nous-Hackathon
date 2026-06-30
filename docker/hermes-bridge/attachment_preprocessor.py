"""
attachment_preprocessor.py — Multimodal attachment preprocessing for chat.send.

Hermes' TUI gateway (which the bridge talks to over JSON-RPC) does NOT
accept arbitrary attachment arrays via `prompt.submit` — only `session_id`
and `text` parameters are honored. Multimodal input on the channel side
(Telegram / WhatsApp / Discord / Slack) works because the channel adapters
write the binary to Hermes' cache directories and then the gateway's
internal `_run_message_enrichment` path hooks vision / STT / document
context-note injection before forwarding to the agent.

To support multimodal in /app (web UI) without modifying the engine, the
bridge replicates the channel-adapter side of that pipeline:

  1. Decode each portal-sent attachment from base64 to bytes.
  2. Cache to the appropriate Hermes cache directory (mirrors what
     `gateway/platforms/base.py::cache_*_from_bytes` would write).
  3. For each kind, do what the channel adapter would do:
       - image/*    → register via `image.attach` RPC; Hermes will run
                      `_enrich_with_attached_images` (vision_analyze) on
                      the next `prompt.submit`. Caller does NOT need to
                      mention the image in the text — Hermes does it.
       - audio/*    → cache + prepend a context note pointing at the
                      cached path. STT is NOT done here (would require
                      `faster-whisper` extras which Dockerfile.hermes
                      doesn't install). Agent can call a transcription
                      tool on the path if the user wants.
       - text MIME  → read content + inline directly into the message text
                      (mirrors gateway/run.py:7715 channel adapter behavior
                      for .md/.txt files).
       - PDF / DOCX / XLSX / PPTX / other binary → cache + prepend a
                      context note pointing at the cached path; the agent
                      uses its file-reading tools on the path.
       - video/*    → cache + prepend a context note.

  4. Build a `prefix_text` from all the context notes + inlined content.
  5. Caller prepends `prefix_text` to the user message before calling
     `prompt.submit`.

Hard constraint: we do NOT modify any Hermes source. We only USE the
public `image.attach` RPC and write to the public cache directories.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("bridge.attachment_preprocessor")


# ─────────────────────────────────────────────────────────────────────
# Multi-encoding text decoder (matches OpenClaw apply.ts UTF-16/CP1252
# fallback logic). Returns decoded str or None if no encoding works.
# ─────────────────────────────────────────────────────────────────────

# CP1252 (Windows-1252) extension mapping for bytes 0x80-0x9F that
# DON'T have CP1252 mappings (matches OpenClaw apply.ts:147-180).
_CP1252_MAP: list[Optional[str]] = [
    "€", None, "‚", "ƒ", "„", "…", "†",
    "‡", "ˆ", "‰", "Š", "‹", "Œ", None,
    "Ž", None, None, "‘", "’", "“", "”",
    "•", "–", "—", "˜", "™", "š",
    "›", "œ", None, "ž", "Ÿ",
]


def _resolve_utf16_charset(buffer: bytes) -> Optional[str]:
    """BOM + zero-byte heuristic for UTF-16 detection. Mirrors OpenClaw
    apply.ts:114-144."""
    if not buffer or len(buffer) < 2:
        return None
    b0, b1 = buffer[0], buffer[1]
    # BOM detection
    if b0 == 0xff and b1 == 0xfe:
        return "utf-16-le"
    if b0 == 0xfe and b1 == 0xff:
        return "utf-16-be"
    # Heuristic: in UTF-16, ASCII text has zero bytes interleaved.
    # If >20% of first 2KB is zero bytes AND zeros cluster on even or
    # odd indices, it's likely UTF-16 LE or BE respectively.
    sample_len = min(len(buffer), 2048)
    zero_even = 0
    zero_odd = 0
    for i in range(sample_len):
        if buffer[i] != 0:
            continue
        if i % 2 == 0:
            zero_even += 1
        else:
            zero_odd += 1
    zero_count = zero_even + zero_odd
    if zero_count / sample_len > 0.2:
        return "utf-16-le" if zero_odd >= zero_even else "utf-16-be"
    return None


def _decode_cp1252_legacy(buffer: bytes) -> str:
    """Decode bytes as CP1252 with custom map for 0x80-0x9F range.
    Mirrors OpenClaw apply.ts:182-193."""
    out_chars: list[str] = []
    for byte in buffer:
        if 0x80 <= byte <= 0x9f:
            mapped = _CP1252_MAP[byte - 0x80]
            out_chars.append(mapped if mapped is not None else chr(byte))
        else:
            out_chars.append(chr(byte))
    return "".join(out_chars)


def _decode_text_multiencoding(data: bytes) -> Optional[str]:
    """Try UTF-8 → UTF-16 LE/BE (via BOM/heuristic) → CP1252 legacy.

    Returns decoded text or None if decoded text contains too many
    replacement chars / non-printables to be useful.
    """
    # Strip UTF-8 BOM if present
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]

    # Try UTF-8 first (most common)
    try:
        text = data.decode("utf-8")
        if text:
            return text
    except UnicodeDecodeError:
        pass

    # UTF-16 BE/LE via BOM + heuristic
    utf16_charset = _resolve_utf16_charset(data)
    if utf16_charset:
        try:
            text = data.decode(utf16_charset, errors="replace")
            if text and text.count("�") < len(text) * 0.05:
                # Strip remaining BOM character if present
                return text.lstrip("﻿")
        except (UnicodeDecodeError, LookupError):
            pass

    # CP1252 legacy decode (covers most Windows-encoded files)
    try:
        return _decode_cp1252_legacy(data)
    except Exception:
        pass

    # Last resort: UTF-8 with replacement (lossy)
    return data.decode("utf-8", errors="replace") or None

# Max payload sizes per kind. These mirror /app's client-side caps so the
# bridge never accepts something the UI would have rejected; serves as
# defense in depth.
# Per-kind caps — kept in lock-step with `src/lib/app/attachments.ts::
# MAX_FILE_BYTES_BY_KIND`. Raised 2026-05-23 from the legacy 5/10/25/10
# MB to 50/100/200/100 MB so chief can attach realistic media (high-res
# photos, long VN, screen recordings, large PDFs) without hitting the
# UI rejection chief saw on a 4.8 MB image upload.
# Per-tier override (D7): the portal injects AGENTBUFF_MAX_*_BYTES at provision
# time (resolved from the user's tier). Absent / invalid env = the default below,
# so behavior is unchanged until a per-tier cap is actually set. Frozen at process
# start; a tier change takes effect on the next provision/restart.
def _env_bytes(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw:
        try:
            v = int(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return default


MAX_IMAGE_BYTES = _env_bytes("AGENTBUFF_MAX_IMAGE_BYTES", 50 * 1024 * 1024)
MAX_AUDIO_BYTES = _env_bytes("AGENTBUFF_MAX_AUDIO_BYTES", 100 * 1024 * 1024)
MAX_VIDEO_BYTES = _env_bytes("AGENTBUFF_MAX_VIDEO_BYTES", 200 * 1024 * 1024)
MAX_DOCUMENT_BYTES = _env_bytes("AGENTBUFF_MAX_DOCUMENT_BYTES", 100 * 1024 * 1024)

# Aggregate per-message caps (admin-panel D7). filesPerMessage is a COUNT cap;
# totalBytes is the combined decoded size across ALL attachments in one message.
# Both default to the marketing baseline (limits.ts MEDIA_DEFAULT) and are
# overridden per-tier via env at provision. `_env_bytes` is a generic positive-int
# env reader — it parses the count too. These are the SERVER-SIDE enforcement; the
# /app client caps are UX-only and forgeable.
MAX_FILES_PER_MESSAGE = _env_bytes("AGENTBUFF_MAX_FILES_PER_MESSAGE", 10)
MAX_TOTAL_BYTES = _env_bytes("AGENTBUFF_MAX_TOTAL_BYTES", 300 * 1024 * 1024)


def _mb(n: int) -> int:
    # Caps are injected as DECIMAL bytes (docker.ts MB = 1_000_000), so decode in
    # the same unit — dividing by MiB here under-reports (50 MB cap -> "47 MB").
    return max(1, round(n / 1_000_000))

# When inlining text content directly into the message, cap at 100 KB —
# same cap Hermes' channel adapter uses for .md/.txt injection
# (gateway/platforms/telegram.py:5010).
MAX_TEXT_INJECT_BYTES = 100 * 1024

# Text MIME prefixes/exact matches that we inline directly. Mirror of
# Hermes' SUPPORTED_DOCUMENT_TYPES text subset + gateway/run.py:7691.
TEXT_INLINE_MIMES_EXACT = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "text/x-markdown",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
}

# Image, audio, video MIME prefixes that route to their own caches.
IMAGE_PREFIXES = ("image/",)
AUDIO_PREFIXES = ("audio/",)
VIDEO_PREFIXES = ("video/",)


# Extension fallbacks when MIME is missing or "application/octet-stream".
# Mirrors gateway/run.py:7691.
EXT_TEXT_INLINE = {
    ".txt", ".md", ".csv", ".tsv", ".log",
    ".json", ".xml", ".yaml", ".yml", ".toml",
    ".ini", ".cfg",
}

# Document extensions (non-text) we accept + their canonical MIME.
EXT_DOCUMENT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
}


@dataclass
class ProcessedAttachments:
    """Aggregated output of attachment preprocessing."""
    image_paths: list[str]   # absolute cache paths to register via image.attach
    prefix_text: str         # context notes + inlined content; prepended to user msg
    errors: list[str]        # human-readable per-file failures (size cap, bad b64, ...)
    # Persistent HTTP URLs for EACH cached attachment, in the same shape
    # as /app's `AttachmentPart`. Caller embeds these as a metadata
    # sentinel in the message text (see rpc_router.handle_chat_send) so
    # the URLs survive Hermes session persistence + page refresh —
    # otherwise the optimistic blob: URLs die and chief loses access to
    # their own uploaded files after one refresh. Added 2026-05-23.
    user_attachment_urls: list[dict]  # [{kind, name, displayUrl, sizeBytes, mimeType}]


def _sanitize_filename(name: str) -> str:
    """Strip path traversal + control chars from a user-supplied filename.

    Mirror of gateway/platforms/base.py::cache_document_from_bytes sanitization.
    """
    safe = Path(name or "file").name
    safe = safe.replace("\x00", "").strip()
    if not safe or safe in {".", ".."}:
        safe = "file"
    # Strip anything that isn't word chars, dot, dash, or space — same
    # rule Hermes uses for the display_name in gateway/run.py:7708.
    safe = re.sub(r"[^\w.\- ]", "_", safe)
    return safe[:128]  # cap length so cached_name doesn't explode


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _get_cache_root() -> Path:
    """Locate Hermes' cache root. Bridge + Hermes share the same container
    + same filesystem, so we use HERMES_HOME (set by agentbuff_bridge.py
    at startup; defaults to ~/.hermes)."""
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home)


def _cache_dir_for_kind(kind: str) -> Path:
    """Map our internal kind to the Hermes cache directory layout. Mirrors
    `get_hermes_dir` semantics: prefer legacy flat name if it already
    exists on disk, else fall back to the consolidated `cache/<x>` path.
    Since the channel adapters use the same lookup, the bridge writing
    here lands files in the exact same dir Hermes' agent reads from."""
    home = _get_cache_root()
    layout = {
        "image":    ("image_cache",    "cache/images"),
        "audio":    ("audio_cache",    "cache/audio"),
        "video":    ("video_cache",    "cache/video"),
        "document": ("document_cache", "cache/documents"),
    }[kind]
    legacy = home / layout[0]
    if legacy.exists():
        return _ensure_dir(legacy)
    return _ensure_dir(home / layout[1])


def _decode_b64(content: str) -> Optional[bytes]:
    """Decode a portal-side base64 payload. Accepts both raw and
    data-URL-prefixed forms (defensive — /app strips data: prefix already
    in attachments.ts::fileToBase64 but rest of the world might not)."""
    if not isinstance(content, str) or not content:
        return None
    payload = content
    # data: URL prefix handling — split off the "data:<mime>;base64," head
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma == -1:
            return None
        payload = payload[comma + 1:]
    payload = payload.strip().replace("\n", "").replace("\r", "")
    if not payload:
        return None
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None


def _classify(att: dict) -> tuple[str, str, str]:
    """Resolve (kind, mime, ext) for a portal attachment.

    `kind` is one of: "image", "audio", "video", "document_text",
    "document_binary", "unknown". `mime` is the resolved MIME string.
    `ext` is the file extension (with leading dot, lowercased), or "".
    """
    name = str(att.get("fileName") or att.get("name") or "")
    raw_type = str(att.get("type") or "").lower()
    raw_mime = str(att.get("mimeType") or "").lower()
    ext = ""
    if name:
        _, ext = os.path.splitext(name)
        ext = ext.lower()

    # Use type discriminator first (explicit caller intent), then MIME,
    # then extension as last-resort fallback.
    if raw_type == "image" or raw_mime.startswith(IMAGE_PREFIXES):
        return ("image", raw_mime or "image/*", ext)
    if raw_type == "audio" or raw_mime.startswith(AUDIO_PREFIXES):
        return ("audio", raw_mime or "audio/*", ext)
    if raw_type == "video" or raw_mime.startswith(VIDEO_PREFIXES):
        return ("video", raw_mime or "video/*", ext)

    # Document path: text MIME → inline, else binary doc → cache + note.
    if raw_mime in TEXT_INLINE_MIMES_EXACT or raw_mime.startswith("text/"):
        return ("document_text", raw_mime or "text/plain", ext)
    if ext in EXT_TEXT_INLINE and (raw_mime == "" or raw_mime == "application/octet-stream"):
        return ("document_text", "text/plain", ext)

    if ext in EXT_DOCUMENT:
        return ("document_binary", raw_mime or EXT_DOCUMENT[ext], ext)
    # The portal marks ANY non-media upload as type="document" (2026-06-09:
    # classifyAttachmentKind falls back to "document" for every file), so trust
    # that discriminator and accept arbitrary files (.bin/.exe/.iso/exotic) as a
    # binary document — cached + a context note, exactly like Telegram accepts
    # any file. Was previously gated on `application/*` mime, which dropped
    # empty-mime / octet-stream uploads to "unknown" (silently discarded).
    if raw_type == "document":
        return ("document_binary", raw_mime or "application/octet-stream", ext)

    return ("unknown", raw_mime, ext)


def _write_to_cache(kind: str, data: bytes, filename: str, ext: str) -> str:
    """Write `data` to the kind's cache dir, return absolute path string.

    File-naming convention matches Hermes':
      image    → image_<uuid12>.<ext>
      audio    → audio_<uuid12>.<ext>
      video    → video_<uuid12>.<ext>
      document → doc_<uuid12>_<originalname>
    """
    import uuid
    cache_dir = _cache_dir_for_kind(kind if kind != "document_text" and kind != "document_binary" else "document")
    uid = uuid.uuid4().hex[:12]
    if kind == "image":
        safe_ext = ext if ext else ".bin"
        fname = f"image_{uid}{safe_ext}"
    elif kind == "audio":
        safe_ext = ext if ext else ".ogg"
        fname = f"audio_{uid}{safe_ext}"
    elif kind == "video":
        safe_ext = ext if ext else ".mp4"
        fname = f"video_{uid}{safe_ext}"
    else:
        safe_name = _sanitize_filename(filename) or f"document{ext or ''}"
        fname = f"doc_{uid}_{safe_name}"
    path = cache_dir / fname
    # Defensive: refuse if path escapes cache_dir (cache_document_from_bytes
    # does the same check at gateway/platforms/base.py:892)
    if not path.resolve().is_relative_to(cache_dir.resolve()):
        raise ValueError("path traversal rejected")
    path.write_bytes(data)
    return str(path)


def process_attachments(attachments: list[dict]) -> ProcessedAttachments:
    """Pure (non-async) preprocessor. Takes the portal-side attachment
    array verbatim and returns the data needed to enrich a chat.send
    call. Caller is responsible for the image.attach RPC + prepending
    `prefix_text` to the user message.

    Each attachment dict shape (FROZEN — see rpc-types.ts ChatAttachmentInput):
      { type: "image"|"audio"|"video"|"document",
        mimeType: string,
        fileName: string,
        content: string (base64) }
    """
    if not attachments or not isinstance(attachments, list):
        return ProcessedAttachments([], "", [], [])

    image_paths: list[str] = []
    prefix_parts: list[str] = []
    errors: list[str] = []
    # Aggregate per-message file-count cap (D7). Excess attachments beyond the
    # per-tier cap are dropped with a single error so the user knows why. This
    # is the real server-side enforcement — the /app client cap is UX-only.
    if len(attachments) > MAX_FILES_PER_MESSAGE:
        dropped = len(attachments) - MAX_FILES_PER_MESSAGE
        errors.append(
            f"Terlalu banyak lampiran ({len(attachments)}); batas "
            f"{MAX_FILES_PER_MESSAGE} file per pesan. {dropped} lampiran terakhir "
            f"tidak dikirim."
        )
        attachments = attachments[:MAX_FILES_PER_MESSAGE]
    # Running total of decoded bytes across accepted attachments (D7 totalMb cap).
    total_size = 0
    # Persistent HTTP token-URLs for each cached attachment so /app can
    # play/preview/download them across page refreshes. Built via
    # `media_serve.register_media` + `media_serve.public_url`. Same
    # registration scheme bot-side media uses (`bot_media_extractor.py`).
    user_attachment_urls: list[dict] = []

    def _register_and_record(
        kind: str, cache_path: str, display_name: str,
        size_bytes: int, mime_type: str,
    ) -> None:
        """Register the cached file with media_serve, append result to
        user_attachment_urls. Silently skips on registration failure
        (e.g. path outside allowed roots) — the file is still cached for
        Hermes' agent to access, just not browser-fetchable."""
        try:
            import media_serve
            url = media_serve.public_url_durable(
                cache_path,
                host=os.environ.get("BRIDGE_PUBLIC_HOST", "127.0.0.1"),
                port=int(os.environ.get("BRIDGE_PUBLIC_HEALTH_PORT", "18790")),
            )
            if not url:
                return
            user_attachment_urls.append({
                "kind": kind,
                "name": display_name,
                "displayUrl": url,
                "sizeBytes": size_bytes,
                "mimeType": mime_type,
            })
        except Exception:
            log.exception(
                "_register_and_record: failed for %s (non-fatal)",
                cache_path,
            )

    for att in attachments:
        if not isinstance(att, dict):
            errors.append("Attachment must be an object")
            continue
        name = str(att.get("fileName") or att.get("name") or "file")
        kind, mime, ext = _classify(att)
        data = _decode_b64(str(att.get("content") or ""))
        if data is None:
            errors.append(f"{name}: invalid base64 content")
            continue

        size = len(data)
        # Size guards per-kind.
        if kind == "image" and size > MAX_IMAGE_BYTES:
            errors.append(f"{name}: ukuran gambar melebihi batas {_mb(MAX_IMAGE_BYTES)} MB")
            continue
        if kind == "audio" and size > MAX_AUDIO_BYTES:
            errors.append(f"{name}: ukuran audio melebihi batas {_mb(MAX_AUDIO_BYTES)} MB")
            continue
        if kind == "video" and size > MAX_VIDEO_BYTES:
            errors.append(f"{name}: ukuran video melebihi batas {_mb(MAX_VIDEO_BYTES)} MB")
            continue
        if kind in {"document_text", "document_binary"} and size > MAX_DOCUMENT_BYTES:
            errors.append(f"{name}: ukuran dokumen melebihi batas {_mb(MAX_DOCUMENT_BYTES)} MB")
            continue

        if kind == "unknown":
            errors.append(
                f"{name}: format {mime or 'tidak dikenal'} belum didukung — "
                f"hanya gambar, audio, video, PDF, Word/Excel/PowerPoint, "
                f"atau file teks."
            )
            continue

        # Aggregate total-bytes cap (D7 totalMb). Checked AFTER the per-kind size
        # guard so an individually-oversized file (already rejected above) does
        # not consume the shared budget. Reject + skip the file that would push
        # the running total over the cap.
        if total_size + size > MAX_TOTAL_BYTES:
            errors.append(
                f"{name}: total ukuran lampiran melebihi batas "
                f"{_mb(MAX_TOTAL_BYTES)} MB"
            )
            continue
        total_size += size

        try:
            cache_path = _write_to_cache(kind, data, name, ext)
        except Exception as exc:
            errors.append(f"{name}: failed to cache ({type(exc).__name__})")
            log.warning("attachment cache write failed: %s", exc, exc_info=True)
            continue

        display = _sanitize_filename(name) or "file"

        # Register cached file with media_serve for persistent HTTP
        # serving. This is what makes user-uploaded media playable
        # across page refresh — without it the only URL /app has is the
        # blob: URL which dies on tab unload. Maps internal kinds to
        # /app's AttachmentPart kinds (text + binary docs collapse to
        # "document"; everything else passes through).
        manifest_kind = (
            "document" if kind in ("document_text", "document_binary") else kind
        )
        _register_and_record(
            manifest_kind, cache_path, display, size, mime,
        )

        if kind == "image":
            # Register via image.attach later; Hermes vision pipeline handles
            # the description injection. No prefix text needed here.
            image_paths.append(cache_path)
            log.info("Cached image: %s (%d bytes) -> %s", display, size, cache_path)

        elif kind == "audio":
            # ─────────────────────────────────────────────────────────
            # Universal STT pipeline — model-agnostic, multi-provider.
            #
            # Architecture: port of OpenClaw's media-understanding STT
            # pipeline (Reff/.archive-openclaw-2026-05-21/
            # src/media-understanding/). Owned end-to-end by the bridge
            # so it survives Hermes engine updates. See
            # `stt_providers.py` for the full provider registry +
            # active-chat-model fallback chain.
            #
            # Chain order:
            #   Tier 0: Currently-active chat-model provider (read from
            #           ~/.hermes/config.yaml). Most users pay for one
            #           LLM provider; re-using its key for STT means
            #           voice works out of the box without separate
            #           configuration.
            #   Tier 1+: Bundled priority chain — openai (10) → groq
            #           (20) → deepgram (30) → gemini (40) → mistral
            #           (50) → xai (60). Skips providers with no key.
            #
            # If everything fails, bridge falls through to Hermes' own
            # `transcribe_audio` as a last-ditch Tier-99 (covers users
            # who only have faster-whisper local install configured).
            # ─────────────────────────────────────────────────────────
            transcript: Optional[str] = None
            stt_provider: Optional[str] = None
            stt_attempts: list[str] = []

            try:
                from stt_providers import (
                    transcribe_audio_via_chain,
                    list_configured_providers,
                )
                t, p, attempts = transcribe_audio_via_chain(data, mime)
                stt_attempts = attempts
                if t is not None:
                    transcript = t
                    stt_provider = p
            except Exception as exc:
                log.warning(
                    "STT chain crashed for %s: %s",
                    cache_path, exc, exc_info=True,
                )
                stt_attempts.append(f"chain_crash: {type(exc).__name__}: {exc}")

            # Tier-99: Hermes' built-in transcribe_audio (covers users
            # whose only STT is the local faster-whisper). Wrapped in a
            # try/except so a future Hermes refactor that moves this
            # function doesn't break the bridge's chain entry points
            # above.
            if transcript is None:
                try:
                    from tools.transcription_tools import (  # type: ignore[import]
                        transcribe_audio,
                    )
                    result = transcribe_audio(cache_path)
                    if isinstance(result, dict) and result.get("success"):
                        transcript = str(result.get("transcript") or "").strip()
                        stt_provider = (
                            "hermes:" + str(result.get("provider") or "local")
                        )
                        stt_attempts.append(f"{stt_provider}: ok")
                    elif isinstance(result, dict):
                        stt_attempts.append(
                            f"hermes_transcribe: {result.get('error') or 'failed'}"
                        )
                except ImportError:
                    stt_attempts.append("hermes_transcribe: module unavailable")
                except Exception as exc:
                    stt_attempts.append(
                        f"hermes_transcribe: {type(exc).__name__}: {exc}"
                    )

            if transcript:
                # Match the channel-adapter injection format verbatim so
                # the agent treats /app voice notes identically to TG /
                # WA / Discord voice notes (gateway/run.py:14302-14305).
                prefix_parts.append(
                    f"[The user sent a voice message~ "
                    f"Here's what they said: \"{transcript}\"]"
                )
                log.info(
                    "Transcribed audio %s via %s -> %d chars",
                    display, stt_provider or "?", len(transcript),
                )
            elif transcript == "":
                # Silent audio — let the agent acknowledge gracefully.
                prefix_parts.append(
                    f"[The user sent a voice message but it appears to be "
                    f"silent or unintelligible. Audio file is saved at: "
                    f"{cache_path}. Ask the user to try recording again.]"
                )
                log.info(
                    "Silent audio %s via %s",
                    display, stt_provider or "?",
                )
            else:
                # No provider produced a transcript. Build a diagnostic
                # context note so the agent can give the user actionable
                # info (which keys are configured, which providers
                # errored, etc.).
                try:
                    from stt_providers import list_configured_providers
                    configured = list_configured_providers()
                except Exception:
                    configured = []
                if configured:
                    diag = (
                        f"STT providers configured ({', '.join(configured)}) "
                        f"but all failed: {' | '.join(stt_attempts[-4:])}"
                    )
                else:
                    diag = (
                        "No STT API keys configured. Easiest fix: set any of "
                        "GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, "
                        "DEEPGRAM_API_KEY, MISTRAL_API_KEY, or XAI_API_KEY "
                        "in the container env."
                    )
                prefix_parts.append(
                    f"[The user sent a voice message but I can't listen "
                    f"to it right now. Audio file is saved at: {cache_path}. "
                    f"Tell the user: {diag}]"
                )
                log.info(
                    "STT failed for %s — attempts: %s",
                    display, stt_attempts,
                )

        elif kind == "video":
            # Try our universal video-description chain (Gemini / Qwen /
            # Moonshot via OpenAI-compatible chat.completions with
            # video_url part). Matches what the Hermes plugin does for
            # channel-side videos via pre_gateway_dispatch hook.
            description: Optional[str] = None
            video_provider: Optional[str] = None
            video_attempts: list[str] = []
            try:
                from media_providers import transcribe_video_via_chain
                description, video_provider, video_attempts = (
                    transcribe_video_via_chain(data, mime)
                )
            except ImportError:
                video_attempts.append("media_providers: module unavailable")
            except Exception as exc:
                video_attempts.append(
                    f"video_chain: {type(exc).__name__}: {exc}"
                )

            if description:
                prefix_parts.append(
                    f"[The user sent a video. Here's what's in it: "
                    f"\"{description}\"]"
                )
                log.info(
                    "Described video %s via %s -> %d chars",
                    display, video_provider or "?", len(description),
                )
            else:
                diag = " | ".join(video_attempts[-3:]) if video_attempts else "no providers"
                prefix_parts.append(
                    f"[The user sent a video attachment: '{display}'. "
                    f"AgentBuff couldn't auto-describe it ({diag}). "
                    f"File saved at: {cache_path}. Ask the user what they "
                    f"want you to do with it, or use the video_analyze "
                    f"tool manually.]"
                )
                log.info(
                    "Cached video: %s (%d bytes) -> %s (auto-describe failed)",
                    display, size, cache_path,
                )

        elif kind == "document_text":
            # Inline content directly — mirrors gateway/run.py:7715 behavior
            # for text/* MIMEs. Try multi-encoding decode chain (matches
            # OpenClaw's media-understanding/apply.ts: UTF-8 → UTF-16 LE/BE
            # via BOM + heuristic → CP1252/Latin-1 legacy fallback).
            if size <= MAX_TEXT_INJECT_BYTES:
                text_content = _decode_text_multiencoding(data)
                if text_content is not None:
                    prefix_parts.append(
                        f"[Content of {display}]:\n{text_content}"
                    )
                    log.info("Inlined text document: %s (%d bytes)", display, size)
                    continue
                log.warning(
                    "Text doc %s could not be decoded in any encoding "
                    "(UTF-8/UTF-16/CP1252) — falling back to path note",
                    display,
                )
            prefix_parts.append(
                f"[The user sent a text document: '{display}'. "
                f"File saved at: {cache_path}. "
                f"Content is too large to inline ({size} bytes > {MAX_TEXT_INJECT_BYTES}). "
                f"Read it from the path if needed.]"
            )

        else:  # document_binary
            # Two strategies, depending on active chat model:
            #   A) Native PDF passthrough — Anthropic Claude + Gemini
            #      both ingest PDF inline via their multimodal APIs.
            #      Leave context note pointing at file path; the model
            #      reads PDF directly. Matches OpenClaw's
            #      `nativeDocumentInputs: ["pdf"]` behaviour.
            #   B) Text extraction — for any other model (OpenAI /
            #      DeepSeek / Mistral / etc), extract text via
            #      pdfplumber / python-docx / openpyxl / python-pptx
            #      and inline the extracted text into the message.
            extracted_text: Optional[str] = None
            doc_kind: Optional[str] = None
            extract_err: Optional[str] = None
            native_pdf_available = False
            try:
                from media_providers import (
                    extract_document_text as _extract_doc,
                    active_supports_native_pdf,
                )
                native_pdf_available = active_supports_native_pdf()
                # Try extraction unless we'd rather hand PDF directly to
                # a native model. For non-PDF docs (DOCX/XLSX/PPTX) we
                # ALWAYS extract — no model ingests these natively.
                from pathlib import Path as _Path
                ext = _Path(cache_path).suffix.lower()
                if ext == ".pdf" and native_pdf_available:
                    pass  # let context note path handle native pass-through
                else:
                    extracted_text, doc_kind, extract_err = _extract_doc(
                        cache_path, mime,
                    )
            except ImportError:
                extract_err = "media_providers module unavailable"
            except Exception as exc:
                extract_err = f"{type(exc).__name__}: {exc}"

            if extracted_text:
                kind_label = (doc_kind or "document").upper()
                prefix_parts.append(
                    f"[The user sent a document: '{display}' ({kind_label}). "
                    f"Extracted content below — original file at {cache_path}.]"
                    f"\n\n--- BEGIN {display} ---\n{extracted_text}"
                    f"\n--- END {display} ---"
                )
                log.info(
                    "Extracted %d chars from %s (%s)",
                    len(extracted_text), display, doc_kind or "?",
                )
            else:
                # Fall back to plain context note. Either we deferred to
                # native PDF model (extract_err is None) or extraction
                # failed (extract_err set).
                detail = ""
                if extract_err and not native_pdf_available:
                    detail = f" Extraction skipped: {extract_err}."
                prefix_parts.append(
                    f"[The user sent a document: '{display}' "
                    f"({mime or 'unknown type'}). It is saved at: {cache_path}. "
                    f"Read from this path with your file-reading tool if you "
                    f"need its content, or ask the user what they'd like you "
                    f"to do with it.{detail}]"
                )
                log.info(
                    "Cached binary doc: %s (%d bytes) -> %s "
                    "(native_pdf=%s extract_err=%s)",
                    display, size, cache_path,
                    native_pdf_available, extract_err,
                )

    prefix = "\n\n".join(prefix_parts).strip()
    return ProcessedAttachments(
        image_paths=image_paths,
        prefix_text=prefix,
        errors=errors,
        user_attachment_urls=user_attachment_urls,
    )


__all__ = [
    "ProcessedAttachments",
    "process_attachments",
    "MAX_IMAGE_BYTES",
    "MAX_AUDIO_BYTES",
    "MAX_VIDEO_BYTES",
    "MAX_DOCUMENT_BYTES",
    "MAX_FILES_PER_MESSAGE",
    "MAX_TOTAL_BYTES",
    "MAX_TEXT_INJECT_BYTES",
]
