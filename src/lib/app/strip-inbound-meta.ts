/**
 * Splits a user-role message text into:
 *   · `cleanText`  — ONLY what the user actually typed
 *   · `context`    — the gateway-injected preamble layers (bootstrap, channel
 *                    envelope, leading timestamp, and the six inbound-meta
 *                    sentinel blocks), captured as structured data.
 *
 * Ported from the upstream stripper (FROZEN regression surface):
 *   `Reff/openclaw/src/auto-reply/reply/strip-inbound-meta.ts`
 *   `Reff/openclaw/src/shared/chat-envelope.ts`
 * Openclaw injects three layers of envelope on top of the raw user input:
 *   1. Bootstrap prelude                          ← local add-on stripper
 *   2. Inbound-meta sentinel blocks + JSON fence  ← ported verbatim
 *   3. Channel envelope `[WebChat ...] `          ← ported verbatim
 * Leading `[Wed YYYY-MM-DD HH:MM UTC] ` timestamp also stripped.
 *
 * Pipeline: bootstrap → envelope → timestamp → inbound-meta → result.
 * Returns `cleanText === ""` only if the message collapses to whitespace.
 *
 * Design note — this file used to expose only `cleanUserText`, which threw
 * away every captured layer. The UI now surfaces them as a collapsible
 * "Konteks yang AI terima" card below the user bubble, so we keep the
 * captured bits alongside `cleanText`. `cleanUserText` still exists as a
 * thin wrapper for callers that only want the stripped text.
 */

// ── Types ─────────────────────────────────────────────────────────────────

/** A media reference extracted from a bridge-injected prefix when the
 *  original attachment file is no longer available (history rehydrate
 *  path — Hermes stores prompt text but not the attachment metadata).
 *
 *  Used to render a synthetic "VN/video/document bubble" in the user
 *  message so chief sees a proper media chip instead of raw context
 *  prose like `[The user sent a voice message~ Here's what they said:
 *  "..."]`. */
export type MediaSummary =
  | { kind: "audio"; transcript: string }
  | { kind: "video"; description: string }
  | { kind: "document"; name: string; docKind?: string; extractedContent?: string }
  | { kind: "image"; description?: string };

export type UserContextMeta = {
  /** `[Bootstrap pending]` prose block (first-message onboarding prelude). */
  bootstrap?: string;
  /** Channel label parsed from envelope header (`WebChat`, `WhatsApp`, …). */
  channel?: string;
  /** Raw envelope header when it didn't match a known channel (fallback). */
  channelHeader?: string;
  /** `[Wed 2026-04-22 04:01 UTC]` timestamp prefix injected by the transport. */
  timestamp?: string;
  /** "Conversation info (untrusted metadata):" JSON payload. */
  conversation?: unknown;
  /** "Sender (untrusted metadata):" JSON payload. */
  sender?: unknown;
  /** "Thread starter (untrusted, for context):" JSON payload. */
  threadStarter?: unknown;
  /** "Replied message (untrusted, for context):" JSON payload. */
  replied?: unknown;
  /** "Forwarded message context (untrusted metadata):" JSON payload. */
  forwarded?: unknown;
  /** "Chat history since last reply (untrusted, for context):" JSON payload. */
  history?: unknown;
  /** Bridge / Hermes plugin-injected media summaries. Extracted from the
   *  rehydrated message text by `parseMediaPrefixes`. When the original
   *  attachment file is gone (history reload, container restart) the
   *  renderer falls back to these to show a proper VN/video/document
   *  chip with transcript instead of the raw `[The user sent ...]` prose. */
  mediaSummaries?: MediaSummary[];
  /** Persistent HTTP token URLs for each user-uploaded attachment.
   *  Bridge embeds these as a `[[PORTAL_ATTACHMENT_URLS:<json>]]`
   *  sentinel in the prefix text BEFORE submitting to Hermes, so the
   *  URLs survive session persistence + page refresh. On reload, the
   *  store reads these into `message.attachments` so the same per-kind
   *  card (AudioCard / ImageCard / VideoCard / DocumentCard) renders
   *  with a real playable/openable URL — telegram-grade UX. */
  portalAttachmentUrls?: Array<{
    kind: "image" | "audio" | "video" | "document";
    name: string;
    displayUrl: string;
    sizeBytes?: number;
    mimeType?: string;
  }>;
  /** True when ANY of the above captured a value — lets the UI cheaply skip
   *  rendering the context row when nothing was injected. */
  hasAny: boolean;
};

export type ParsedUserPayload = {
  cleanText: string;
  context: UserContextMeta;
};

// ── Bootstrap preamble ────────────────────────────────────────────────────
// Gateway prepends a `[Bootstrap pending]` block to the user's first message
// while the workspace is booting. Shape observed in the wild: header line
// `[Bootstrap pending]` followed by prose that can span MULTIPLE paragraphs
// (internal `\n\n` blanks), a trailing `Current time: …` line, and only
// THEN the next gateway layer (sender sentinel, envelope, timestamp, or
// EOF). The older `indexOf("\n\n")` heuristic cut the block at the first
// internal blank, leaving paragraph 2 + `Current time: …` leaked into the
// user bubble.
//
// Correct terminator: the first line that looks like the START of a known
// later layer — inbound-meta sentinel, untrusted-context header, channel
// envelope, or leading timestamp. Between the header and that marker,
// everything (blank lines included) belongs to the bootstrap block.
//
// Position — the header USUALLY appears at offset 0, but
// `pi-embedded-runner/run/attempt.ts:1842` prepends `hookResult.prependContext`
// AFTER the bootstrap is composed, which pushes the header forward. So we
// scan for it at any line-start, not just the very start of the string.
export function stripBootstrapPreamble(text: string): string {
  const { rest } = extractBootstrapBlock(text);
  return rest;
}

const BOOTSTRAP_HEADER = "[Bootstrap pending]";

/** Find the offset where `[Bootstrap pending]` starts at a line boundary
 *  (start-of-text or immediately after a newline). Returns -1 if not found.
 *  The line-boundary constraint avoids false-matching the header inside
 *  prose that happens to quote the literal string. */
function findBootstrapHeaderStart(text: string): number {
  let idx = text.indexOf(BOOTSTRAP_HEADER);
  while (idx !== -1) {
    if (idx === 0 || text.charAt(idx - 1) === "\n") return idx;
    idx = text.indexOf(BOOTSTRAP_HEADER, idx + 1);
  }
  return -1;
}

/** Walk `text` line by line and return the first line-start at which
 *  `pattern` (anchored at `^`) fires. Used to find channel envelope +
 *  leading timestamp tokens that `attempt.ts` hook-prepend can push off the
 *  very start of the string — same fix-class as `findBootstrapHeaderStart`.
 *  Returns `{ match, offset }` where `offset` is the absolute index into
 *  `text` at which the match begins, or `null` if no line matches. */
function findLayerAtLineStart(
  text: string,
  pattern: RegExp,
): { match: string; offset: number } | null {
  let pos = 0;
  while (pos <= text.length) {
    const m = pattern.exec(text.slice(pos));
    if (m && m.index === 0) {
      return { match: m[0], offset: pos };
    }
    const nl = text.indexOf("\n", pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}

/** Splice `match` out of `text` starting at `offset`. Helper around the
 *  layer-at-line-start strip pattern. */
function spliceOut(text: string, offset: number, matchLen: number): string {
  return text.slice(0, offset) + text.slice(offset + matchLen);
}

function extractBootstrapBlock(text: string): { prose: string; rest: string } {
  const headerAt = findBootstrapHeaderStart(text);
  if (headerAt === -1) {
    return { prose: "", rest: text };
  }
  const before = text.slice(0, headerAt);
  const fromHeader = text.slice(headerAt);
  const lines = fromHeader.split("\n");
  // Line 0 is the `[Bootstrap pending]` header — always consumed.
  let cursor = 1;
  while (cursor < lines.length) {
    if (isNextLayerMarkerLine(lines[cursor])) break;
    cursor += 1;
  }
  const proseLines = lines.slice(1, cursor);
  const restLines = lines.slice(cursor);
  const rest = before + restLines.join("\n");
  return {
    prose: proseLines.join("\n").trim(),
    rest,
  };
}

function isNextLayerMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  if (INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed)) {
    return true;
  }
  if (trimmed === UNTRUSTED_CONTEXT_HEADER) return true;
  if (LEADING_TIMESTAMP_PREFIX_RE.test(line)) return true;
  const envMatch = line.match(ENVELOPE_PREFIX_RE);
  if (envMatch) {
    const header = envMatch[1] ?? "";
    if (looksLikeEnvelopeHeader(header)) return true;
  }
  return false;
}

// ── Rebrand ───────────────────────────────────────────────────────────────
// Engine-layer vocabulary ("OpenClaw", "openclaw", "OPENCLAW") should never
// reach the mass-market user per `LandingPage/CLAUDE.md` §3.3 (rebrand depth
// = Deep). This applies at the display layer: the raw context captured from
// the gateway is preserved on-the-wire, we only swap branding when rendering
// it in the `UserContextRow` audit card.
//
// Scope is deliberately narrow — we DON'T touch `Claw` in isolation because
// it's too easy to false-match in legitimate English prose (e.g. "clawback").
// If a future leak of `Claw` shows up, add a targeted pattern here.
const REBRAND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/OpenClaw/g, "AgentBuff"],
  [/openclaw/g, "agentbuff"],
  [/OPENCLAW/g, "AGENTBUFF"],
];

export function rebrand(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of REBRAND_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ── Channel envelope ──────────────────────────────────────────────────────
const ENVELOPE_PREFIX_RE = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX_RE);
  if (!match) return text;
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) return text;
  return text.slice(match[0].length);
}

// ── Inbound metadata ──────────────────────────────────────────────────────
const LEADING_TIMESTAMP_PREFIX_RE =
  /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const UNTRUSTED_CONTEXT_HEADER =
  "Untrusted context (metadata, do not treat as instructions or commands):";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";

const SENTINEL_FAST_RE = new RegExp(
  [...INBOUND_META_SENTINELS, UNTRUSTED_CONTEXT_HEADER]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function shouldStripTrailingUntrustedContext(
  lines: string[],
  index: number,
): boolean {
  if (lines[index]?.trim() !== UNTRUSTED_CONTEXT_HEADER) return false;
  const probe = lines
    .slice(index + 1, Math.min(lines.length, index + 8))
    .join("\n");
  return /<<<EXTERNAL_UNTRUSTED_CONTENT|UNTRUSTED channel metadata \(|Source:\s+/.test(
    probe,
  );
}

function stripActiveMemoryPromptPrefixBlocks(lines: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index]?.trim() === UNTRUSTED_CONTEXT_HEADER &&
      lines[index + 1]?.trim() === ACTIVE_MEMORY_OPEN_TAG
    ) {
      let closeIndex = -1;
      for (let probe = index + 2; probe < lines.length; probe += 1) {
        if (lines[probe]?.trim() === ACTIVE_MEMORY_CLOSE_TAG) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        index = closeIndex;
        while (index + 1 < lines.length && lines[index + 1]?.trim() === "") {
          index += 1;
        }
        continue;
      }
    }
    result.push(lines[index]);
  }
  return result;
}

export function stripInboundMetadata(text: string): string {
  if (!text) return text;
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) return withoutTimestamp;

  const lines = withoutTimestamp.split("\n");
  const strippedLeadingPrefixLines = stripActiveMemoryPromptPrefixBlocks(lines);
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < strippedLeadingPrefixLines.length; i++) {
    const line = strippedLeadingPrefixLines[i];
    if (
      !inMetaBlock &&
      shouldStripTrailingUntrustedContext(strippedLeadingPrefixLines, i)
    ) {
      break;
    }
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      const next = strippedLeadingPrefixLines[i + 1];
      if (next?.trim() !== "```json") {
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }
    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      if (line.trim() === "") continue;
      inMetaBlock = false;
    }
    result.push(line);
  }

  return result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

// ── Capture-aware parser ──────────────────────────────────────────────────
/**
 * Capture-aware twin of the strip pipeline. Mirrors `stripBootstrapPreamble`
 * → `stripEnvelope` → `stripInboundMetadata` line-for-line so the regression
 * surface stays identical, but each pass TEE's its captured data into a
 * `UserContextMeta` side channel. The renderer uses this to show the raw
 * layers as a collapsible "Konteks yang AI terima" card below the user
 * bubble — transparency win without polluting the bubble itself.
 */
export function parseUserPayload(text: string): ParsedUserPayload {
  const context: UserContextMeta = { hasAny: false };
  if (!text) return { cleanText: text, context };

  let remaining = text;

  // ── Pass 1: Bootstrap preamble ──────────────────────────────────────────
  // Loop because the header CAN appear mid-text (hook-prepended context
  // shifts it off offset 0) and, in rare cases, more than once across a
  // single message (e.g. a follow-up turn that inherits its own preamble).
  // Each iteration peels one bootstrap block out of `remaining`; stop when
  // no more headers are found.
  while (true) {
    const headerAt = findBootstrapHeaderStart(remaining);
    if (headerAt === -1) break;
    const { prose, rest } = extractBootstrapBlock(remaining);
    if (prose) {
      // Concatenate if a second block slips through — keep every captured
      // layer visible in the audit card rather than dropping one silently.
      context.bootstrap = context.bootstrap
        ? `${context.bootstrap}\n\n${prose}`
        : prose;
      context.hasAny = true;
    }
    remaining = rest;
  }
  if (!remaining.trim() && context.hasAny) {
    // Entire message was bootstrap — no further layers to parse, and the
    // user bubble collapses to empty (the context card carries the prose
    // via `context.bootstrap`).
    return { cleanText: "", context };
  }

  // ── Pass 2: Channel envelope ────────────────────────────────────────────
  // Same fix-class as Pass 1 above — `findLayerAtLineStart` scans every line
  // boundary, not just offset 0, so hook-prepended context before the
  // envelope doesn't cause us to miss the tag. The regex is anchored at `^`
  // which, combined with slicing at a newline boundary, means we only match
  // at true line-starts (no false hits inside prose that happens to contain
  // a square-bracket pattern mid-line).
  while (true) {
    const envHit = findLayerAtLineStart(remaining, ENVELOPE_PREFIX_RE);
    if (!envHit) break;
    const headerMatch = envHit.match.match(ENVELOPE_PREFIX_RE);
    const header = headerMatch?.[1] ?? "";
    if (!looksLikeEnvelopeHeader(header)) break; // unknown tag, leave intact
    if (!context.channel && !context.channelHeader) {
      const channel = ENVELOPE_CHANNELS.find((label) =>
        header.startsWith(`${label} `),
      );
      if (channel) context.channel = channel;
      else context.channelHeader = header;
    }
    context.hasAny = true;
    remaining = spliceOut(remaining, envHit.offset, envHit.match.length);
    // Loop once more in case a second envelope was stacked (e.g. a forwarded
    // message that still carries its original envelope). Only the first tag
    // is kept in `context.channel`; subsequent ones are stripped without
    // clobbering the captured value.
  }

  // ── Pass 3: Leading timestamp ───────────────────────────────────────────
  while (true) {
    const tsHit = findLayerAtLineStart(remaining, LEADING_TIMESTAMP_PREFIX_RE);
    if (!tsHit) break;
    if (!context.timestamp) {
      context.timestamp = tsHit.match.trim().replace(/\]$/, "]");
    }
    context.hasAny = true;
    remaining = spliceOut(remaining, tsHit.offset, tsHit.match.length);
  }

  // ── Portal attachment URLs sentinel — handle BEFORE other passes ────────
  // Bridge appends `[[PORTAL_ATTACHMENT_URLS:<json>]]` as the LAST line
  // of any message that carried user-uploaded attachments. Strip it
  // first so subsequent passes don't trip on the JSON content. Added
  // 2026-05-23 to persist user media playback across page refresh.
  remaining = _extractPortalAttachmentUrls(remaining, context);

  // ── Pass 4: Inbound-meta sentinel blocks ────────────────────────────────
  // Fast-skip when no sentinel block present in text. CRITICAL: do NOT
  // early-return out of the function here — Pass 5 (media prefix
  // extraction below) MUST run for VN-only messages where the entire
  // text is just `[The user sent a voice message~ ...]` with no
  // sentinel JSON blocks. Bug observed 2026-05-23 (chief's screenshot):
  // raw `[The user sent...]` text leaked into user bubble because this
  // early-return skipped Pass 5. Fix: skip Pass 4's body via flag,
  // continue to Pass 5.
  const hasSentinel = SENTINEL_FAST_RE.test(remaining);
  if (!hasSentinel) {
    // Skip sentinel parsing — go straight to media extraction below.
    const { stripped: mediaStripped, summaries: mediaSummaries } =
      extractMediaPrefixes(remaining);
    if (mediaSummaries.length > 0) {
      context.mediaSummaries = mediaSummaries;
      context.hasAny = true;
    }
    // Always use the stripped text — the defense-in-depth scrub inside
    // extractMediaPrefixes removes internal-path/brand annotations even when
    // no media summary was produced.
    return { cleanText: mediaStripped.trim(), context };
  }

  const lines = remaining.split("\n");
  const strippedLeadingPrefixLines = stripActiveMemoryPromptPrefixBlocks(lines);
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;
  let currentSentinel: string | null = null;
  let jsonBuffer: string[] = [];

  for (let i = 0; i < strippedLeadingPrefixLines.length; i++) {
    const line = strippedLeadingPrefixLines[i];
    if (
      !inMetaBlock &&
      shouldStripTrailingUntrustedContext(strippedLeadingPrefixLines, i)
    ) {
      break;
    }
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      const next = strippedLeadingPrefixLines[i + 1];
      if (next?.trim() !== "```json") {
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      currentSentinel = line.trim();
      jsonBuffer = [];
      continue;
    }
    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          if (currentSentinel) {
            const payload = tryParseJson(jsonBuffer.join("\n"));
            attachSentinelPayload(context, currentSentinel, payload);
            context.hasAny = true;
          }
          inMetaBlock = false;
          inFencedJson = false;
          currentSentinel = null;
          jsonBuffer = [];
          continue;
        }
        jsonBuffer.push(line);
        continue;
      }
      if (line.trim() === "") continue;
      inMetaBlock = false;
    }
    result.push(line);
  }

  let cleanText = result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  // Mirror openclaw: re-strip any timestamp prefix revealed AFTER the meta
  // block cleanup. Capture too if we haven't yet.
  const trailingTs = cleanText.match(LEADING_TIMESTAMP_PREFIX_RE);
  if (trailingTs) {
    if (!context.timestamp) {
      context.timestamp = trailingTs[0].trim().replace(/\]$/, "]");
      context.hasAny = true;
    }
    cleanText = cleanText.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  }

  // ── Pass 5: Bridge media prefix extraction ─────────────────────────────
  // The bridge attachment_preprocessor and Hermes multimodal plugin both
  // inject a `[The user sent a <kind>...]` prose block in front of the
  // user message text whenever an attachment is processed. On history
  // rehydrate the original file is gone (Hermes session only stores
  // text), so we recover a usable "media bubble" UI by parsing these
  // prefixes back into structured `mediaSummaries` and stripping the
  // prose from `cleanText`.
  const { stripped, summaries } = extractMediaPrefixes(cleanText);
  cleanText = stripped;
  if (summaries.length > 0) {
    context.mediaSummaries = summaries;
    context.hasAny = true;
  }

  return { cleanText: cleanText.trim(), context };
}

// ── Media prefix patterns (matches bridge + Hermes plugin output) ─────────
// Positional capturing groups only (avoids ES2018 named-groups target bump).
//
// CRITICAL: bridge writes ASCII apostrophe `'` (U+0027) and ASCII double
// quote `"` (U+0022) literally — Python f-string in attachment_preprocessor
// produces e.g. `Here's what they said: "..."` with ASCII chars. The regex
// character classes MUST include both ASCII and curly variants because
// the transcript itself may contain Unicode quotes from STT output.
//
//   Apostrophe class: ['‘’]  →  '  '  '
//   Quote class:      ["“”]  →  "  "  "

// Group 1 = transcript
const VN_PREFIX_RE =
  /\[The user sent a voice message[~\s]*Here['‘’]s what they said:\s*["“”]([^"“”]*)["“”]\s*\]/u;

// Group 1 = description
const VIDEO_PREFIX_RE =
  /\[The user sent a video\.\s*Here['‘’]s what['‘’]s in it:\s*["“”]([^"“”]*)["“”]\s*\]/u;

// Group 1 = file path
const VIDEO_FALLBACK_RE =
  /\[The user sent a video at\s+([^.\]]+)\.[^\]]*\]/u;

// Group 1 = name, Group 2 = docKind, Group 3 = extracted content
const DOC_EXTRACTED_RE =
  /\[The user sent a document:\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”]\s*\(([A-Z]+)\)\.\s*Extracted content below[^\]]*\]\s*\n+\s*---\s*BEGIN\s+[^\n-]+---\s*\n([\s\S]*?)\n\s*---\s*END\s+[^\n-]+---/u;

// Group 1 = name
const DOC_BINARY_RE =
  /\[The user sent a document:\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”][^\]]*\]/u;

// Group 1 = name
const DOC_TEXT_RE =
  /\[The user sent a text document:\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”][^\]]*\]/u;

// Broadened: matches BOTH `[The user sent an image at <path>]` and the
// current engine's `[The user attached an image:\n<multiline description>]`.
// Non-greedy to the first `]` (engine descriptions never contain `]`).
const IMAGE_NOTE_RE =
  /\[The user (?:sent|attached) an? image[:\s][\s\S]*?\]/iu;

// Alt engine phrasing seen live: `[Image attached at: /home/hermes/.hermes/...]`
// — the exact path leak Chief screenshotted. Captured here so it both produces
// an image summary AND gets stripped from the bubble.
const IMAGE_ATTACHED_AT_RE = /\[Image attached at:[^\]]*\]/iu;

// ── Drift-proof defense-in-depth ──────────────────────────────────────────
// ANY bracketed block carrying an internal path / engine cache dir / vision
// tool token is engine/bridge-injected meta, never user prose — strip it no
// matter the phrasing, so brand/path leaks can't survive an engine-version
// drift that changes the wording. A user's own bracket like `[konsep ini]`
// has none of these tokens and is left verbatim.
const VISION_COMPANION_RE = /\[[^\]]*vision_analyze[^\]]*\]/giu;
const INTERNAL_ANNOT_RE =
  /\[[^\]]*(?:\/home\/hermes\/\.hermes|\/tmp\/hermes_sandbox_|image_cache|audio_cache|video_cache|document_cache|vision_analyze)[^\]]*\]/giu;
// Bare engine `[screenshot]` tag the engine appends after an image note.
const SCREENSHOT_TAG_RE = /\[screenshot\]/giu;

export function extractMediaPrefixes(text: string): {
  stripped: string;
  summaries: MediaSummary[];
} {
  if (!text) return { stripped: text, summaries: [] };
  let remaining = text;
  const summaries: MediaSummary[] = [];

  // Walk patterns most-specific-first so e.g. "Extracted content" docs
  // are matched before the bare-name "binary doc" fallback.
  const patterns: Array<{
    re: RegExp;
    build: (m: RegExpExecArray) => MediaSummary;
  }> = [
    {
      re: VN_PREFIX_RE,
      build: (m) => ({
        kind: "audio",
        transcript: (m[1] ?? "").trim(),
      }),
    },
    {
      re: VIDEO_PREFIX_RE,
      build: (m) => ({
        kind: "video",
        description: (m[1] ?? "").trim(),
      }),
    },
    {
      re: VIDEO_FALLBACK_RE,
      build: (m) => ({
        kind: "video",
        description: `(belum di-deskripsikan — file ada di ${m[1] ?? "cache"})`,
      }),
    },
    {
      re: DOC_EXTRACTED_RE,
      build: (m) => ({
        kind: "document",
        name: m[1] ?? "Dokumen",
        docKind: m[2],
        extractedContent: (m[3] ?? "").trim(),
      }),
    },
    {
      re: DOC_BINARY_RE,
      build: (m) => ({
        kind: "document",
        name: m[1] ?? "Dokumen",
      }),
    },
    {
      re: DOC_TEXT_RE,
      build: (m) => ({
        kind: "document",
        name: m[1] ?? "Dokumen",
        docKind: "TXT",
      }),
    },
    {
      re: IMAGE_NOTE_RE,
      build: () => ({ kind: "image" }),
    },
    {
      re: IMAGE_ATTACHED_AT_RE,
      build: () => ({ kind: "image" }),
    },
  ];

  for (const { re, build } of patterns) {
    // Iterate in case the same message has multiple media notes (e.g.
    // chief sent 2 voice notes back to back).
    let safety = 0;
    while (safety < 10) {
      const m = re.exec(remaining);
      if (!m) break;
      summaries.push(build(m));
      remaining =
        remaining.slice(0, m.index) +
        remaining.slice(m.index + m[0].length);
      safety += 1;
    }
  }

  // Drift-proof defense-in-depth strip — runs even when NO phrase pattern
  // produced a summary, so a brand/path-leaking bracket the phrase patterns
  // miss still never reaches the bubble.
  remaining = remaining
    .replace(VISION_COMPANION_RE, "")
    .replace(INTERNAL_ANNOT_RE, "")
    .replace(SCREENSHOT_TAG_RE, "");
  return { stripped: remaining.replace(/\n{3,}/g, "\n\n").trim(), summaries };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    // Wire contract says the payload is JSON, but if the gateway ever ships
    // malformed content we keep the raw text so the UI still has something
    // to surface rather than silently swallowing it.
    return trimmed;
  }
}

// ── Portal attachment URL sentinel ────────────────────────────────────────
// Bridge embeds `[[PORTAL_ATTACHMENT_URLS:<json>]]` in the prefix text right
// before submitting to Hermes when the user message carried uploaded
// attachments. The JSON payload is a list of `{kind, name, displayUrl,
// sizeBytes?, mimeType?}` rows — one per uploaded file — pointing at the
// bridge's persistent `/media/<token>/<filename>` HTTP endpoint.
//
// Why a sentinel rather than a fenced JSON block: it must survive Hermes
// session persistence unmodified (Hermes only stores message text), it must
// be invisible in the user bubble (we strip it here), and it must not
// confuse the agent (a single-line bracketed token reads as obvious
// metadata that the agent ignores).
//
// Telegram-grade UX win: after a page refresh, history rehydrate finds the
// sentinel here, the store maps it back into `message.attachments` with
// real HTTP URLs, and the per-kind card (AudioCard / ImageCard /
// VideoCard / DocumentCard) renders playable + downloadable just like
// the moment of send.
// Non-greedy capture `(.+?)` + line-end lookahead `(?=\n|$)` is the safe
// way to grab JSON content that contains `]` characters (array closings).
// Previous regex `[^\]]+` stopped at the FIRST `]` inside JSON, leaving
// trailing `]]` to leak into the user bubble as a stray "]" character
// (Bug 1, observed 2026-05-23 in chief's screenshots). Bridge always
// appends the sentinel at the END of the prefix text (see
// `rpc_router.py:346`), so the line-end anchor is reliable.
const PORTAL_ATTACHMENT_URLS_RE = /\[\[PORTAL_ATTACHMENT_URLS:(.+?)\]\](?=\n|$)/;

const ATTACHMENT_KINDS = new Set(["image", "audio", "video", "document"] as const);

function _extractPortalAttachmentUrls(
  text: string,
  context: UserContextMeta,
): string {
  const m = text.match(PORTAL_ATTACHMENT_URLS_RE);
  if (!m) return text;
  try {
    const parsed = JSON.parse(m[1] ?? "[]");
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((row): row is {
        kind: "image" | "audio" | "video" | "document";
        name: string;
        displayUrl: string;
        sizeBytes?: number;
        mimeType?: string;
      } => {
        if (!row || typeof row !== "object") return false;
        const r = row as Record<string, unknown>;
        if (typeof r.kind !== "string" || !ATTACHMENT_KINDS.has(r.kind as "image" | "audio" | "video" | "document")) {
          return false;
        }
        if (typeof r.name !== "string" || typeof r.displayUrl !== "string") {
          return false;
        }
        return true;
      });
      if (valid.length > 0) {
        // Concatenate if the sentinel ever shows up twice in one message —
        // last-write-wins would silently drop earlier attachments.
        context.portalAttachmentUrls = context.portalAttachmentUrls
          ? [...context.portalAttachmentUrls, ...valid]
          : valid;
        context.hasAny = true;
      }
    }
  } catch {
    // Malformed sentinel — strip it anyway so the user never sees the raw
    // `[[PORTAL_ATTACHMENT_URLS:...]]` token in their bubble.
  }
  return text.replace(PORTAL_ATTACHMENT_URLS_RE, "").trim();
}

function attachSentinelPayload(
  context: UserContextMeta,
  sentinel: string,
  payload: unknown,
): void {
  switch (sentinel) {
    case "Conversation info (untrusted metadata):":
      context.conversation = payload;
      return;
    case "Sender (untrusted metadata):":
      context.sender = payload;
      return;
    case "Thread starter (untrusted, for context):":
      context.threadStarter = payload;
      return;
    case "Replied message (untrusted, for context):":
      context.replied = payload;
      return;
    case "Forwarded message context (untrusted metadata):":
      context.forwarded = payload;
      return;
    case "Chat history since last reply (untrusted, for context):":
      context.history = payload;
      return;
  }
}

// ── Public one-stop cleaner ───────────────────────────────────────────────
/**
 * Full pipeline for user-role messages. Idempotent — runs bootstrap strip
 * first so envelope + inbound-meta operate on the payload of interest.
 * Thin wrapper around `parseUserPayload` for callers that only need the
 * stripped text (e.g. copy-to-clipboard, search indexing).
 */
export function cleanUserText(text: string): string {
  if (!text) return text;
  return parseUserPayload(text).cleanText;
}
