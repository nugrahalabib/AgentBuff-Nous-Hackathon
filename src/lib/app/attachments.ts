/**
 * Client-side attachment handling for /app chat.
 *
 * Multimodal support (post-Hermes migration): the bridge preprocesses each
 * kind by caching the binary to Hermes' cache directories + invoking the
 * appropriate enrichment path (`image.attach` RPC for images, context-note
 * injection for audio / video / binary docs, inline-content injection for
 * text MIMEs). Caps below mirror `attachment_preprocessor.py`'s per-kind
 * size limits so the UI never accepts something the bridge would reject.
 *
 * Kinds:
 *   - image: jpg / png / webp / gif → vision pipeline
 *   - audio: ogg / mp3 / wav / m4a → STT (if installed) or path note
 *   - video: mp4 / mov / webm / mkv / avi → path note
 *   - document: pdf / docx / xlsx / pptx / etc → path note
 *     (Text-MIME documents are still inlined CLIENT-SIDE via the B2 path
 *      in chat-composer.tsx — see `isTextLikeFile`. That path is faster
 *      because it never crosses the wire as base64.)
 */

import type { ChatAttachmentInput } from "@/lib/hermes/rpc-types";

export type AttachmentKind = "image" | "audio" | "video" | "document";

export const ACCEPTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const ACCEPTED_AUDIO_MIMES = [
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",      // .mp3
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/mp4",       // .m4a often arrives as audio/mp4
  "audio/webm",
] as const;

export const ACCEPTED_VIDEO_MIMES = [
  "video/mp4",
  "video/quicktime", // .mov
  "video/webm",
  "video/x-matroska", // .mkv
  "video/x-msvideo",  // .avi
] as const;

export const ACCEPTED_DOCUMENT_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/zip",
  "application/msword",     // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.oasis.opendocument.text",       // .odt
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
] as const;

/** Combined list for the file-picker `accept` attr generator. Text/code
 *  files are NOT here — they're handled client-side by the composer's
 *  `isTextLikeFile` path which extracts content into the textarea
 *  directly (B2 feature, faster than crossing the wire). */
export const ACCEPTED_MIME_TYPES = [
  ...ACCEPTED_IMAGE_MIMES,
  ...ACCEPTED_AUDIO_MIMES,
  ...ACCEPTED_VIDEO_MIMES,
  ...ACCEPTED_DOCUMENT_MIMES,
] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

/** Per-kind size caps. MUST stay in lock-step with the bridge's
 *  `attachment_preprocessor.py` constants — the bridge rejects anything
 *  larger so the UI must enforce the same limit BEFORE encoding to base64
 *  (which inflates 33%). */
// Per-kind upload caps. Chief asked for liberal limits — these match
// what mass-market apps (WhatsApp Web ~100 MB, Telegram ~2 GB, Slack
// ~1 GB) allow. Base64 encoding inflates ~33% over the wire; the
// bridge WS frame ceiling (raised in lock-step to 256 MB below) is
// the next hard limit after these.
export const MAX_FILE_BYTES_BY_KIND: Record<AttachmentKind, number> = {
  image: 50_000_000,    // 50 MB — high-res photos, screenshots, scans
  audio: 100_000_000,   // 100 MB — long VN, podcast clip, music
  video: 200_000_000,   // 200 MB — short clips, screen recordings
  document: 100_000_000, // 100 MB — large PDFs, datasets, archives
};
/** Legacy alias: existing call sites that don't yet split by kind keep the
 *  image cap. */
export const MAX_FILE_BYTES = MAX_FILE_BYTES_BY_KIND.image;
/** UX cap; bridge has no per-message ceiling. Bumped from 5 to 10 so
 *  chief can attach a whole batch (e.g. 10 screenshots). */
export const MAX_FILES_PER_MESSAGE = 10;
/** UX cap guarding composer UI. Bumped to 300 MB to comfortably allow
 *  a 200 MB video + a 100 MB document together. */
export const MAX_TOTAL_BYTES = 300_000_000;

// ── Per-tier override (D7) ────────────────────────────────────────────────
// The constants above are the DEFAULTS. When the /app client hydrates the user's
// tier limits (useLimitsHydration → setAttachmentLimits), the getters below return
// the per-tier caps instead. Before hydration (and on any fetch failure) they fall
// through to the constants, so behavior is identical to today. 1 MB = 1_000_000
// (decimal) to match the constants above.
const MB = 1_000_000;
let runtimeMedia: {
  image: number;
  audio: number;
  video: number;
  document: number;
  filesPerMessage: number;
  totalBytes: number;
} | null = null;

/** Hydrate the per-tier media caps (MB in, bytes stored). Empty = revert to defaults. */
export function setAttachmentLimits(media: {
  imageMb: number;
  audioMb: number;
  videoMb: number;
  documentMb: number;
  filesPerMessage: number;
  totalMb: number;
}): void {
  runtimeMedia = {
    image: media.imageMb * MB,
    audio: media.audioMb * MB,
    video: media.videoMb * MB,
    document: media.documentMb * MB,
    filesPerMessage: media.filesPerMessage,
    totalBytes: media.totalMb * MB,
  };
}

/** Per-kind byte cap — the per-tier override if hydrated, else the default. */
export function getMaxFileBytesForKind(kind: AttachmentKind): number {
  return runtimeMedia ? runtimeMedia[kind] : MAX_FILE_BYTES_BY_KIND[kind];
}
/** Max attachments per message — per-tier override if hydrated, else the default. */
export function getMaxFilesPerMessage(): number {
  return runtimeMedia ? runtimeMedia.filesPerMessage : MAX_FILES_PER_MESSAGE;
}
/** Aggregate byte cap per message — per-tier override if hydrated, else the default. */
export function getMaxTotalBytes(): number {
  return runtimeMedia ? runtimeMedia.totalBytes : MAX_TOTAL_BYTES;
}

/** A file the user picked but we haven't sent yet. Owns a revocable blob URL
 *  for thumbnail preview — caller MUST call `revokeDraft()` on removal so we
 *  don't leak memory over a long session. */
export type AttachmentDraft = {
  /** Stable local id — used as React key and for remove operations. */
  id: string;
  /** Discriminated kind for renderer + bridge routing. */
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Object URL created by `URL.createObjectURL`. Revoke on remove.
   *  Always present for images (used as thumbnail src). For audio/video
   *  this powers an inline <audio>/<video> control. For documents it's
   *  set but typically unused — the chip shows just a doc icon. */
  previewUrl: string;
  /** Original File handle — kept around so we can base64-encode on send. */
  file: File;
};

/** Server-visible attachment part attached to a committed user message, either
 *  via optimistic echo (we remember what we sent) or history rehydrate (parsed
 *  from the transcript). */
export type AttachmentPart = {
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  /** Preferred display source for the current render. EITHER a blob URL
   *  (optimistic — held for the session lifetime) OR a data: URL rebuilt from
   *  base64 on history rehydrate. Never both. Consumers just `<img src>`. */
  displayUrl: string;
  /** Gap #7: the bridge marked this audio as a true voice note (agent emitted
   *  `[[audio_as_voice]]` / TTS). AudioCard renders the round voice-bubble
   *  style. Replaces the brittle `voice-note-` filename heuristic, which is
   *  kept only as a fallback for sessions persisted before this flag existed. */
  isVoiceNote?: boolean;
  /** Gap #5: the agent emitted `[[as_document]]` next to this media — render it
   *  as a downloadable DocumentCard instead of an inline photo (kind is already
   *  set to "document" bridge-side; this flag lets the UI offer an image
   *  preview affordance while still treating it as a download). */
  forceDocument?: boolean;
};

/** Resolve which AttachmentKind a file belongs to. Lookup is MIME-first
 *  with extension fallback (matches the bridge's classifier in
 *  `attachment_preprocessor.py::_classify`). image/audio/video get rich
 *  players; EVERYTHING ELSE falls back to "document" (download card) so a user
 *  can upload ANY file type — matching Telegram, where any file is sendable as
 *  a document. Never returns null; the only hard limits are the size caps in
 *  validateFiles. (2026-06-09) */
export function classifyAttachmentKind(file: File): AttachmentKind {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  // Documents — check explicit MIME first, then by extension.
  if ((ACCEPTED_DOCUMENT_MIMES as readonly string[]).includes(mime)) {
    return "document";
  }
  const name = (file.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot);
    const DOC_EXTS = new Set([
      ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
      ".odt", ".ods", ".zip",
    ]);
    if (DOC_EXTS.has(ext)) return "document";
    // Audio/video extension fallback (some Linux/Android mime tables empty)
    const AUDIO_EXTS = new Set([".mp3", ".ogg", ".opus", ".wav", ".m4a", ".webm", ".oga"]);
    if (AUDIO_EXTS.has(ext)) return "audio";
    const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
    if (VIDEO_EXTS.has(ext)) return "video";
  }
  // Any other file (e.g. .bin, .exe, .iso, exotic extensions) → deliver as a
  // downloadable document, exactly like Telegram accepts arbitrary files. Text/
  // code files (.py/.md/.csv/…) are intercepted earlier by the composer's
  // isTextLikeFile branch (inlined into the message) before this runs.
  return "document";
}

export type AttachmentValidationError = {
  fileName: string;
  reason: string;
};

export type AttachmentValidationResult = {
  accepted: AttachmentDraft[];
  errors: AttachmentValidationError[];
};

function newDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function prettyFileSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
  return formatBytes(bytes);
}

function isAcceptedMime(mime: string): mime is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mime);
}

// ──────────────────────────────────────────────────────────────────────
// B2 — Text file paste support
// ──────────────────────────────────────────────────────────────────────
//
// Hermes' bridge `chat-attachments.ts` silently drops non-image attachments.
// Instead of failing silently OR blowing them away with a cryptic rejection,
// we detect text-shaped files and ingest their content directly into the
// composer textarea as a fenced code block. That way the user gets a useful
// outcome from a drag-drop OR file-picker pick of "I want the model to read
// this code/log/CSV", which is the dominant non-image use case anyway.
//
// What's a "text file"? Anything matching one of:
//   · MIME starts with `text/` (text/plain, text/markdown, text/csv, ...)
//   · MIME is one of the structured-data whitelist below (json, yaml, xml, sh)
//   · OR extension matches the whitelist (Windows + macOS sometimes ship
//     code files with an empty MIME so we fall back on extension).

const TEXT_MIME_PREFIXES: readonly string[] = ["text/"];
const TEXT_MIME_EXACT: readonly string[] = [
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-toml",
  "application/javascript",
  "application/typescript",
  "application/x-httpd-php",
];
const TEXT_EXTENSIONS: readonly string[] = [
  "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "json5",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm",
  "css", "scss", "sass", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc",
  "cpp", "hpp", "cs", "php", "pl", "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql", "proto", "vue", "svelte", "astro", "dart",
  "lua", "r", "scala", "tf", "tfvars", "dockerfile", "makefile", "gitignore",
];

const TEXT_FILE_MAX_BYTES = 1_000_000; // 1 MB cap — paste larger files = truncated

export type TextFileExtraction = {
  fileName: string;
  language: string; // hint for the fenced block, e.g. "ts" or "" if unknown
  content: string;
  truncated: boolean;
};

function lookupExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/** True when the file's MIME or extension shape says it's a text file we
 *  can read and inline into the composer textarea. Does NOT read the file. */
export function isTextLikeFile(file: File): boolean {
  const mime = (file.type || "").toLowerCase();
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  if (TEXT_MIME_EXACT.includes(mime)) return true;
  const ext = lookupExtension(file.name || "");
  if (ext && TEXT_EXTENSIONS.includes(ext)) return true;
  // Some Linux distros send `application/octet-stream` for plain text —
  // last-ditch fallback by extension above already covers this if the user
  // has a recognisable extension. Otherwise we let it fall to the rejection
  // path so users aren't surprised by binary garbage in their composer.
  return false;
}

/** Read a text-like file as UTF-8 and produce a `{ language, content }`
 *  payload suitable for inlining into the composer. Truncates at 1 MB to
 *  protect the textarea + composer perf. Returns null if read fails. */
export async function extractTextFromFile(
  file: File,
): Promise<TextFileExtraction | null> {
  try {
    let slice: Blob = file;
    let truncated = false;
    if (file.size > TEXT_FILE_MAX_BYTES) {
      slice = file.slice(0, TEXT_FILE_MAX_BYTES);
      truncated = true;
    }
    const content = await slice.text();
    const ext = lookupExtension(file.name || "");
    return {
      fileName: file.name || "file.txt",
      // map a few common extensions to richer language hints for the fence
      language: mapExtensionToLanguage(ext),
      content,
      truncated,
    };
  } catch {
    return null;
  }
}

function mapExtensionToLanguage(ext: string): string {
  switch (ext) {
    case "ts": case "tsx": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "py": return "python";
    case "rb": return "ruby";
    case "go": return "go";
    case "rs": return "rust";
    case "java": return "java";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "c": case "h": return "c";
    case "cc": case "cpp": case "hpp": return "cpp";
    case "cs": return "csharp";
    case "php": return "php";
    case "sh": case "bash": case "zsh": return "bash";
    case "ps1": return "powershell";
    case "sql": return "sql";
    case "graphql": case "gql": return "graphql";
    case "proto": return "protobuf";
    case "vue": return "vue";
    case "svelte": return "svelte";
    case "json": case "json5": return "json";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "xml": return "xml";
    case "html": case "htm": return "html";
    case "css": return "css";
    case "scss": case "sass": return "scss";
    case "less": return "less";
    case "md": case "markdown": return "markdown";
    case "csv": return "csv";
    case "tsv": return "tsv";
    case "log": return "log";
    case "env": return "ini";
    case "ini": case "cfg": case "conf": return "ini";
    case "dockerfile": return "dockerfile";
    default: return ext || "";
  }
}

/** Render a text-file extraction as a string the user can paste/append into
 *  the composer textarea. Wraps the content in a fenced code block with the
 *  language hint + a header line naming the file + a truncation footer. */
export function textExtractionToMarkdown(ext: TextFileExtraction): string {
  const header = `[File: ${ext.fileName}]`;
  const fence = "```" + (ext.language || "");
  const footer = ext.truncated
    ? "\n\n_(File terlalu besar — hanya 1 MB pertama yang dimuat.)_"
    : "";
  return `${header}\n${fence}\n${ext.content}\n\`\`\`${footer}`;
}

/**
 * Validate a batch of picked/pasted/dropped files against existing drafts.
 * Returns accepted drafts (already wrapped with blob URLs) + human-readable
 * rejection reasons per file. Drafts in `existing` are NOT touched — the
 * caller merges them however it wants.
 */
export function validateFiles(
  picked: File[],
  existing: AttachmentDraft[],
): AttachmentValidationResult {
  const accepted: AttachmentDraft[] = [];
  const errors: AttachmentValidationError[] = [];

  // Running totals seeded from the existing drafts so the validator enforces
  // caps across successive drag-drops in the same composer turn.
  let currentCount = existing.length;
  let currentBytes = existing.reduce((acc, d) => acc + d.sizeBytes, 0);
  const existingKeys = new Set(
    existing.map((d) => `${d.name}:${d.sizeBytes}`),
  );

  for (const file of picked) {
    const mime = (file.type || "").toLowerCase();
    const label = file.name || "file";

    // Never null now: image/audio/video → rich player, everything else →
    // "document" (download card). Any file type is accepted, like Telegram.
    const kind = classifyAttachmentKind(file);

    if (file.size <= 0) {
      errors.push({ fileName: label, reason: "File kosong." });
      continue;
    }

    const perKindCap = getMaxFileBytesForKind(kind);
    if (file.size > perKindCap) {
      errors.push({
        fileName: label,
        reason:
          `Ukuran ${formatBytes(file.size)} melebihi batas ${formatBytes(perKindCap)} untuk ${KIND_LABEL[kind]}.`,
      });
      continue;
    }

    const filesCap = getMaxFilesPerMessage();
    if (currentCount >= filesCap) {
      errors.push({
        fileName: label,
        reason: `Maksimal ${filesCap} lampiran per pesan.`,
      });
      continue;
    }

    const totalCap = getMaxTotalBytes();
    if (currentBytes + file.size > totalCap) {
      errors.push({
        fileName: label,
        reason: `Total lampiran melebihi ${formatBytes(totalCap)}.`,
      });
      continue;
    }

    // De-duplicate name+size exact matches — common when the user re-picks the
    // same file or pastes the same clipboard image twice.
    const dedupeKey = `${label}:${file.size}`;
    if (existingKeys.has(dedupeKey)) {
      errors.push({
        fileName: label,
        reason: "File yang sama sudah dipilih.",
      });
      continue;
    }
    existingKeys.add(dedupeKey);

    const previewUrl =
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : "";

    accepted.push({
      id: newDraftId(),
      kind,
      name: label,
      mimeType: mime,
      sizeBytes: file.size,
      previewUrl,
      file,
    });
    currentCount += 1;
    currentBytes += file.size;
  }

  return { accepted, errors };
}

/** Human label per kind — used in validator copy + composer chip text. */
const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "gambar",
  audio: "audio",
  video: "video",
  document: "dokumen",
};
export { KIND_LABEL };

/** Revoke the blob URL backing a draft. Caller is responsible for clearing the
 *  draft from state separately — this is purely memory hygiene. */
export function revokeDraft(draft: AttachmentDraft): void {
  if (
    draft.previewUrl &&
    typeof URL !== "undefined" &&
    typeof URL.revokeObjectURL === "function"
  ) {
    try {
      URL.revokeObjectURL(draft.previewUrl);
    } catch {
      /* already revoked or cross-realm — ignore */
    }
  }
}

/** Encode a File to base64 (no data-URL prefix). Uses `FileReader` since
 *  `Blob.arrayBuffer()` + manual btoa trips "InvalidCharacterError" on large
 *  binary data in older Safaris; FileReader's `readAsDataURL` is universal. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        new Error(
          `Gagal membaca file "${file.name}": ${reader.error?.message ?? "unknown error"}`,
        ),
      );
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Format FileReader tidak terduga: ${typeof result}`));
        return;
      }
      const commaIdx = result.indexOf(",");
      if (commaIdx < 0) {
        reject(new Error("Data URL tidak memiliki payload base64."));
        return;
      }
      resolve(result.slice(commaIdx + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Convert drafts into the wire-format attachments expected by `chat.send`.
 *  The `type` discriminant routes the bridge's `attachment_preprocessor.py`
 *  to the right cache dir + enrichment path (image.attach for images,
 *  context-note injection for audio/video/binary docs). Each encode is
 *  async (FileReader) so we parallelise — the bridge accepts them in any
 *  order. */
export async function draftsToWireAttachments(
  drafts: AttachmentDraft[],
): Promise<ChatAttachmentInput[]> {
  if (drafts.length === 0) return [];
  const encoded = await Promise.all(
    drafts.map(async (d) => {
      const content = await fileToBase64(d.file);
      const input: ChatAttachmentInput = {
        type: d.kind,
        mimeType: d.mimeType,
        fileName: d.name,
        content,
      };
      return input;
    }),
  );
  return encoded;
}

/** Build an AttachmentPart from a draft — used as the optimistic echo on the
 *  user bubble. The blob URL lives for the session so the thumbnail keeps
 *  rendering even after we've discarded the File handle. */
export function draftToPart(draft: AttachmentDraft): AttachmentPart {
  return {
    kind: draft.kind,
    name: draft.name,
    mimeType: draft.mimeType,
    sizeBytes: draft.sizeBytes,
    displayUrl: draft.previewUrl,
  };
}

/** Reconstruct an AttachmentPart from an image block loaded via
 *  `sessions.get`. Claude-shaped blocks look like:
 *    { type: "image", source: { type: "base64", media_type, data } }
 *  Returns null on malformed input so the caller can drop it. */
export function attachmentPartFromImageBlock(
  block: Record<string, unknown>,
): AttachmentPart | null {
  if (!block || typeof block !== "object") return null;
  if (block.type !== "image" && block.type !== "document") return null;
  const source = block.source as
    | { type?: unknown; media_type?: unknown; data?: unknown }
    | undefined;
  if (!source || typeof source !== "object") return null;
  const mime =
    typeof source.media_type === "string" ? source.media_type : "";
  const data = typeof source.data === "string" ? source.data : "";
  if (!mime || !data) return null;
  // Only surface parts we can actually RENDER. Others fall through.
  if (!mime.startsWith("image/")) return null;
  const name =
    typeof (block as { fileName?: unknown }).fileName === "string"
      ? ((block as { fileName?: string }).fileName ?? "image")
      : "image";
  return {
    kind: "image",
    name,
    mimeType: mime,
    displayUrl: `data:${mime};base64,${data}`,
  };
}
