/**
 * TypeScript twin of `docker/hermes-bridge/bot_media_extractor.py` for the
 * HISTORY rehydrate path.
 *
 * Why we need this:
 *   - Bridge's `extract_bot_media` runs ONLY on the LIVE `message.complete`
 *     wire event — it produces the cleaned text + AttachmentPart[] that the
 *     bubble commits via `_applyChatEvent` state="final".
 *   - But Hermes' SESSION STORAGE persists the agent's RAW reply text
 *     verbatim (including `MEDIA:/abs/path` + `[[audio_as_voice]]`). When
 *     `/app` loads history via `sessions.get` (initial mount, session
 *     switch, refresh), `rawToMessage` reads that raw text — so the
 *     assistant bubble shows MEDIA: tag as plaintext + no AudioCard.
 *   - This module duplicates the extraction logic on the TS side so
 *     rehydrated assistant messages produce the SAME shape live messages
 *     do — same bubble UX whether fresh or refreshed.
 *
 * Scope (matches bridge):
 *   1. `MEDIA:http(s)://...` URL form  → AttachmentPart with that URL
 *   2. `MEDIA:/abs/path/to/file`       → can't register from browser, but
 *                                         we still STRIP the tag so the
 *                                         bubble doesn't show it (bridge's
 *                                         token registration is bridge-side
 *                                         only; on history load, the bridge
 *                                         media-serve has already lost the
 *                                         token if bridge restarted)
 *   3. `[[audio_as_voice]]` directive  → stripped + marks audio as voice
 *
 * Symmetric with bridge regex (mirrors `bot_media_extractor.py:MEDIA_HTTP_RE`)
 */

import type { AttachmentKind, AttachmentPart } from "./attachments";

// Match `MEDIA:` followed by either http URL or absolute path; stop at
// whitespace or `]` (markdown bracket boundary). Trailing punctuation
// gets trimmed off the captured URL.
const MEDIA_TAG_RE = /\bMEDIA:(\S+?)(?=\s|\]|$)/g;
const AUDIO_AS_VOICE_RE = /\[\[audio_as_voice\]\]/g;
// Gap #5: `[[as_document]]` — render the adjacent media as a downloadable
// document. Mirrors the bridge's bot_media_extractor so client-side extraction
// (history rehydrate / slipped-through MEDIA tags) behaves identically.
const AS_DOCUMENT_RE = /\[\[as_document\]\]/g;

// Extension → kind map mirrors `bot_media_extractor.py::_classify_by_extension`
const EXT_KIND_MAP: Record<string, AttachmentKind> = {
  // Images
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".svg": "image",
  // Audio
  ".mp3": "audio",
  ".ogg": "audio",
  ".opus": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  ".oga": "audio",
  // Video
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".avi": "video",
  ".mpeg": "video",
  ".mpg": "video",
  ".qt": "video",
  // Documents
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
  ".xls": "document",
  ".xlsx": "document",
  ".ppt": "document",
  ".pptx": "document",
  ".txt": "document",
  ".csv": "document",
  ".tsv": "document",
  ".md": "document",
  ".json": "document",
  ".xml": "document",
  ".yaml": "document",
  ".yml": "document",
  ".zip": "document",
  ".rar": "document",
  ".7z": "document",
  ".epub": "document",
};

// Common MIME from extension (mirrors `mimetypes.guess_type` in Python)
const EXT_MIME_MAP: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function classifyByExtension(pathOrUrl: string): AttachmentKind {
  const cleaned = pathOrUrl.split("?", 1)[0]?.split("#", 1)[0] ?? pathOrUrl;
  const dot = cleaned.lastIndexOf(".");
  if (dot < 0) return "document";
  const ext = cleaned.slice(dot).toLowerCase();
  return EXT_KIND_MAP[ext] ?? "document";
}

function mimeFromExtension(pathOrUrl: string): string | undefined {
  const cleaned = pathOrUrl.split("?", 1)[0]?.split("#", 1)[0] ?? pathOrUrl;
  const dot = cleaned.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = cleaned.slice(dot).toLowerCase();
  return EXT_MIME_MAP[ext];
}

/**
 * Extract bot media references from an assistant text reply.
 *
 * Returns `{cleanedText, attachments}` where:
 * - `cleanedText`  : prose with all MEDIA: tags and [[audio_as_voice]]
 *                    directives stripped, ready to render as the bubble
 *                    body. Whitespace collapsed.
 * - `attachments`  : AttachmentPart[] for every HTTP-form MEDIA tag we
 *                    can reasonably display from the browser. Local-path
 *                    MEDIA tags (e.g. `MEDIA:/home/hermes/.hermes/...`)
 *                    are STRIPPED from text but NOT promoted to an
 *                    attachment — the bridge holds the token registry
 *                    and the browser has no way to fetch a local path
 *                    directly. (Future work: bridge could intercept
 *                    `sessions.get` and re-register cache files into
 *                    fresh tokens, then rewrite the persisted text
 *                    with URLs before /app sees it.)
 */
export function extractAssistantBotMedia(rawText: string): {
  cleanedText: string;
  attachments: AttachmentPart[];
} {
  if (!rawText || typeof rawText !== "string") {
    return { cleanedText: rawText ?? "", attachments: [] };
  }
  const attachments: AttachmentPart[] = [];

  // First pass: extract HTTP-form MEDIA tags as attachments.
  // Note `MEDIA_TAG_RE` is global → use matchAll for safe iteration.
  for (const m of rawText.matchAll(MEDIA_TAG_RE)) {
    const captured = m[1] ?? "";
    // Strip trailing punctuation that may have been attached to the URL.
    const url = captured.replace(/[.,)\]}>]+$/, "");
    if (!url) continue;

    if (/^https?:\/\//i.test(url)) {
      // Look ~60 chars ahead for the [[audio_as_voice]] companion directive.
      const startIdx = (m.index ?? 0) + (m[0]?.length ?? 0);
      const tail = rawText.slice(startIdx, startIdx + 80);
      const isVoice = AUDIO_AS_VOICE_RE.test(tail);
      AUDIO_AS_VOICE_RE.lastIndex = 0;
      const isDoc = AS_DOCUMENT_RE.test(tail);
      AS_DOCUMENT_RE.lastIndex = 0;

      // `[[audio_as_voice]]` directive overrides extension-based kind.
      // Important for `.webm` files which can be either audio (Opus
      // codec) or video — Telegram + MediaRecorder produce audio webm
      // for voice notes, but classifyByExtension defaults to "video".
      // Without this override, voice notes render as VideoCard which
      // breaks the playback affordance + waveform UX.
      // Derive the filename from the LAST url segment so it works for BOTH the
      // legacy `/media/<token>/<name>` and the durable `/media/d/<hash>.<ext>/
      // <name>` shapes. Decode percent-encoding so names with spaces render
      // cleanly. Classify kind + mime from this filename (not the whole url) so
      // the durable url's content-hash segment can't confuse extension lookup.
      const rawSeg =
        url.split("?", 1)[0]?.split("#", 1)[0]?.split("/").pop() ||
        "attachment";
      let base = rawSeg;
      try {
        base = decodeURIComponent(rawSeg);
      } catch {
        /* malformed %-encoding — keep the raw segment */
      }
      let kind = classifyByExtension(base);
      if (isVoice) kind = "audio";
      // Gap #7: emit the typed isVoiceNote flag (no more `voice-note-` rename —
      // the bridge keeps the real filename + flag, so the client mirrors that).
      const voice = kind === "audio" && isVoice;
      // Gap #5: an image tagged [[as_document]] becomes a download card.
      const forceDoc = isDoc && kind === "image";

      const mime = mimeFromExtension(base);
      // Override MIME too when voice — `.webm` extension defaults to
      // `video/webm` per the mime table, but the audio element needs
      // `audio/webm` to negotiate the right decoder path.
      const finalMime = isVoice && mime?.startsWith("video/")
        ? mime.replace("video/", "audio/")
        : mime;
      attachments.push({
        kind: forceDoc ? "document" : kind,
        name: base,
        displayUrl: url,
        ...(voice ? { isVoiceNote: true } : {}),
        ...(forceDoc ? { forceDocument: true } : {}),
        mimeType: finalMime ?? (
          kind === "image"
            ? "image/*"
            : kind === "audio"
              ? "audio/*"
              : kind === "video"
                ? "video/*"
                : "application/octet-stream"
        ),
      });
    }
    // Local-path form (starts with `/`, `~/`, `./`, etc) — we intentionally
    // strip the tag below but don't synthesize an attachment. The bridge's
    // token registry is per-bridge-process; on history rehydrate the token
    // may be gone, so showing a card that 404s would be worse UX than
    // letting the bubble just be prose.
  }

  // Strip ALL MEDIA: tags + [[audio_as_voice]] + [[as_document]] directives
  // from text. Reset lastIndex between calls since the regexes are global.
  MEDIA_TAG_RE.lastIndex = 0;
  AUDIO_AS_VOICE_RE.lastIndex = 0;
  AS_DOCUMENT_RE.lastIndex = 0;
  let cleaned = rawText
    .replace(MEDIA_TAG_RE, "")
    .replace(AUDIO_AS_VOICE_RE, "")
    .replace(AS_DOCUMENT_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Reset again (matchAll/replace can leave state on global regexes
  // depending on the engine — belt-and-suspenders).
  MEDIA_TAG_RE.lastIndex = 0;
  AUDIO_AS_VOICE_RE.lastIndex = 0;

  return { cleanedText: cleaned, attachments };
}
