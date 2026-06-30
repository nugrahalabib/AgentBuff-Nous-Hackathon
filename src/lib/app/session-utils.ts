/**
 * Session helpers — keep these pure (no store / WS dependencies) so they're
 * trivially testable and reusable across the store + provider.
 *
 * Canonical key handling (wire gotcha G3):
 *   The gateway rewrites any key the client sends into an `agent:<agentId>:<sessionKey>`
 *   shape for its internal bookkeeping, and it emits events with that canonical
 *   form. We store the canonical form in local state to avoid double-booking.
 */

import type {
  ContentBlock,
  GatewaySessionRow,
  GatewayTranscriptMessage,
} from "@/lib/hermes/rpc-types";
import {
  attachmentPartFromImageBlock,
  type AttachmentPart,
} from "./attachments";

/**
 * Best-effort canonicalization for a session key. The gateway is the true
 * canonicalizer; this helper only bridges short forms (e.g. "main") to the
 * same namespace emitted by gateway events so our Record<sessionKey, ...>
 * maps don't end up with both "main" and "agent:main:main" pointing to the
 * same underlying session.
 *
 * Agent id defaults to "main" — the gateway's default agent. Any session key
 * already starting with "agent:" is returned unchanged.
 */
export function canonicalizeSessionKey(
  key: string,
  agentId: string = "main",
): string {
  if (!key) return `agent:${agentId}:main`;
  if (key.startsWith("agent:")) return key;
  // "global" and "unknown" are sentinel keys the gateway keeps unprefixed.
  const lower = key.toLowerCase();
  if (lower === "global" || lower === "unknown") return lower;
  return `agent:${agentId}:${key}`;
}

/**
 * Filter to the subset of sessions a dashboard user should see — i.e. any
 * `agent:<agentId>:*` session EXCEPT recognised channel adapters
 * (Telegram / WhatsApp / Discord / Slack / Google Chat etc, those are
 * administered via the channels surface).
 *
 * Key formats we accept:
 *   agent:<agentId>:main                              ← legacy OpenClaw default
 *   agent:<agentId>:dashboard:<uuid>                  ← OpenClaw "Thread Baru"
 *   agent:<agentId>:<YYYYMMDD_HHMMSS_hash>            ← Hermes per-prompt session
 *   agent:<agentId>:<any-non-channel-suffix>          ← future engines
 *
 * Keys we reject (channel sessions — handled in the Channels tab):
 *   agent:<agentId>:telegram-<chat>-<sender>
 *   agent:<agentId>:whatsapp-...
 *   agent:<agentId>:discord-...
 *   agent:<agentId>:slack-...
 *   agent:<agentId>:google-chat-...
 */
const CHANNEL_KEY_PREFIXES = [
  "telegram-",
  "whatsapp-",
  "discord-",
  "slack-",
  "google-chat-",
  "googlechat-",
];

/**
 * Classify a session by its Hermes `source` string. Hermes encodes the origin
 * in `source` (NOT the key): "tui"/"cli"/"api_server" are the web/portal
 * surface; everything else (whatsapp__<acc>, telegram, discord, slack,
 * google_chat, …) is a real messaging channel.
 *
 * Channel sessions are LOCKED in the web UI (read-only) so chatting here never
 * disrupts the live conversation happening in the actual channel.
 */
export type SessionOrigin = {
  /** "web" = portal/CLI/API; "channel" = a messaging channel. */
  kind: "web" | "channel";
  /** Base channel id: "web" | "whatsapp" | "telegram" | "discord" | … */
  channel: string;
  /** Friendly label: "Web" | "WhatsApp" | "Telegram" | … */
  label: string;
  /** Synthetic multi-account id (e.g. "default-1"), if any. */
  accountId?: string;
  /** Channel sessions are read-only in the web UI. */
  locked: boolean;
};

const WEB_SOURCES = new Set(["tui", "cli", "api_server", "web", "dashboard", ""]);
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  google_chat: "Google Chat",
  googlechat: "Google Chat",
  signal: "Signal",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

export function classifySessionSource(source?: string | null): SessionOrigin {
  const raw = (source ?? "").trim().toLowerCase();
  if (WEB_SOURCES.has(raw)) {
    return { kind: "web", channel: "web", label: "Web", locked: false };
  }
  // Synthetic platform: "whatsapp__default-1" → base "whatsapp", acc "default-1".
  const [base, accountId] = raw.includes("__") ? raw.split("__", 2) : [raw, undefined];
  const label = CHANNEL_LABELS[base] ?? base.charAt(0).toUpperCase() + base.slice(1);
  return { kind: "channel", channel: base, label, accountId, locked: true };
}

export function isDashboardSessionKey(key: string): boolean {
  if (!key) return false;
  const parts = key.split(":");
  if (parts[0] !== "agent") return false;
  if (parts.length < 3) return false;
  const suffix = parts.slice(2).join(":");
  if (!suffix) return false;
  for (const prefix of CHANNEL_KEY_PREFIXES) {
    if (suffix.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Extract the agent that owns a canonical session key
 * (`agent:<agentId>:<suffix>`). Returns null for non-agent / malformed keys
 * ("global", "unknown", or legacy unprefixed forms).
 *
 * Default-agent normalization: the gateway stamps the default agent's keys
 * with the "main" sentinel, but `agents.list` reports the default profile as
 * "default" (DEFAULT_PROFILE). We fold "main" → "default" so per-agent
 * grouping / filtering in the Sessions tab lines up with the agents catalog.
 */
export function agentIdFromSessionKey(key: string): string | null {
  if (!key) return null;
  const parts = key.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const raw = parts[1]?.trim();
  if (!raw) return null;
  return raw === "main" ? "default" : raw;
}

/**
 * Pull a user-readable title out of a raw gateway session row. Preference:
 *   label (manual rename) > derivedTitle (server-derived from first user
 *   message, requires includeDerivedTitles:true on sessions.list) >
 *   displayName > subject > room > space > fallback.
 *
 * User's manual rename always wins — once `label` is set on the server via
 * `sessions.patch`, it pins the title. Clear the label (`label: null`) to
 * fall back to auto-derivation.
 */
export function sessionRowTitle(row: GatewaySessionRow): string {
  return (
    row.label ||
    row.derivedTitle ||
    row.displayName ||
    (isDashboardSessionKey(row.key) && /:(dashboard):/.test(row.key)
      ? "Thread baru"
      : "Sesi utama")
  );
}

type TextPart = { type?: string; text?: string };
type ContentValue = string | TextPart[] | undefined | null;

/**
 * Extract plain text from a message's `content` field, which may either be a
 * plain string or an array of typed parts. Non-text parts (tool_use /
 * tool_result / image / etc.) are ignored for now — M4 will render them
 * properly; M3 just needs the text skeleton.
 */
export function extractMessageText(content: ContentValue): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

/**
 * Quick detector — does this message carry tool_use / tool_result parts?
 * Used so we can surface a neutral "tool activity" placeholder instead of
 * rendering nothing when a message has ZERO text parts.
 */
export function messageHasNonTextParts(content: ContentValue): boolean {
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => part && part.type && part.type !== "text",
  );
}

/**
 * Normalize raw `content` (string | part[]) into a flat ContentBlock[] that
 * the UI can iterate and switch on. Preserves unknown block types so future
 * providers keep working even before we add UI for them.
 *
 * Rules:
 *  - Plain string → single TextBlock.
 *  - Part array   → each part preserved with its `type`. Missing `type` or
 *                   missing payload fields fall through to UnknownBlock.
 *  - Missing / invalid input → [].
 *
 * Field-name tolerance (matches openclaw's `src/chat/tool-content.ts` +
 * `ui-agentbuff/src/ui/chat/tool-cards.ts:148-153`):
 *  - tool call type   ∈ {tool_use, tool_call, tooluse, toolcall} (case-insensitive)
 *  - tool result type ∈ {tool_result, toolresult}
 *  - tool args key    ∈ {input, args, arguments}
 *  - tool id key      ∈ {id, toolCallId, tool_call_id, callId}
 *  - tool ref id key  ∈ {tool_use_id, toolUseId, tool_call_id, toolCallId}
 *  - error flag key   ∈ {is_error, isError}
 * We collapse all of these into the canonical ToolUseBlock / ToolResultBlock
 * shape so downstream renderers only ever switch on `"tool_use"` /
 * `"tool_result"` and consume `input` + `tool_use_id`.
 */
export function normalizeContentBlocks(content: ContentValue): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    const rawType = typeof part.type === "string" ? part.type : null;
    if (!rawType) continue;
    const typeKey = rawType.toLowerCase();

    if (typeKey === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      out.push({ type: "text", text });
      continue;
    }

    if (
      typeKey === "tool_use" ||
      typeKey === "tool_call" ||
      typeKey === "tooluse" ||
      typeKey === "toolcall"
    ) {
      const id =
        stringOrEmpty(part.id) ||
        stringOrEmpty(part.toolCallId) ||
        stringOrEmpty(part.tool_call_id) ||
        stringOrEmpty(part.callId) ||
        "";
      const rawInput = part.input ?? part.args ?? part.arguments;
      out.push({
        type: "tool_use",
        id,
        name: typeof part.name === "string" ? part.name : "unknown",
        input:
          rawInput && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : typeof rawInput === "string"
            ? tryParseJsonObject(rawInput)
            : undefined,
      });
      continue;
    }

    if (typeKey === "tool_result" || typeKey === "toolresult") {
      const content = part.content as
        | string
        | Array<{ type?: string; text?: string }>
        | undefined;
      const refId =
        stringOrEmpty(part.tool_use_id) ||
        stringOrEmpty(part.toolUseId) ||
        stringOrEmpty(part.tool_call_id) ||
        stringOrEmpty(part.toolCallId) ||
        "";
      const isError =
        typeof part.is_error === "boolean"
          ? part.is_error
          : typeof part.isError === "boolean"
          ? part.isError
          : false;
      out.push({
        type: "tool_result",
        tool_use_id: refId,
        content:
          typeof content === "string" || Array.isArray(content)
            ? content
            : undefined,
        is_error: isError,
      });
      continue;
    }

    if (typeKey === "thinking") {
      out.push({
        type: "thinking",
        thinking:
          typeof part.thinking === "string" ? part.thinking : "",
        thinkingSignature:
          typeof part.thinkingSignature === "string"
            ? part.thinkingSignature
            : undefined,
        redacted:
          typeof part.redacted === "boolean" ? part.redacted : undefined,
        index:
          typeof part.index === "number" && Number.isFinite(part.index)
            ? part.index
            : undefined,
      });
      continue;
    }
    // Unknown — keep verbatim so we don't lose data; renderer falls back to
    // a generic "unknown block" pill.
    out.push({ ...(part as UnknownBlockSeed), type: rawType } as ContentBlock);
  }
  return out;
}

function stringOrEmpty(v: unknown): string {
  if (typeof v !== "string") return "";
  const trimmed = v.trim();
  return trimmed;
}

/** Some transports serialize tool args as a JSON-encoded string instead of
 *  an object. Best-effort parse; falls back to `undefined` if it isn't valid
 *  JSON-object, which keeps the renderer from crashing on a raw string. */
function tryParseJsonObject(s: string): Record<string, unknown> | undefined {
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore — fall through */
  }
  return undefined;
}

// Escape hatch for the normalize fallback — keeps TS happy when spreading an
// unknown record into the ContentBlock union.
type UnknownBlockSeed = { type?: string } & Record<string, unknown>;

/**
 * Does this block array contain any user-visible content (text, tool, or
 * thinking)? Used to decide whether to show an empty-placeholder bubble.
 */
export function blocksAreRenderable(blocks: ContentBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.type === "text" && (b as TextLike).text) ||
      b.type === "tool_use" ||
      b.type === "tool_result" ||
      b.type === "thinking" ||
      (b.type && b.type !== "text"),
  );
}

type TextLike = { type: "text"; text?: string };

/**
 * Sum of all text blocks, merged in order. Keeps parity with the legacy
 * `extractMessageText` output — used for sidebar previews, search, etc.
 */
export function blocksToText(blocks: ContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") {
      const t = (b as TextLike).text;
      if (typeof t === "string") out += t;
    }
  }
  return out;
}

/**
 * Merge a CHAT-event's incoming blocks over the current streaming blocks
 * without clobbering tool / thinking blocks accumulated from the parallel
 * AGENT-event stream.
 *
 * Why this exists:
 *   Gateway emits TWO parallel streams per turn — `chat` (text-only deltas)
 *   and `agent` (tool / thinking / item). Each chat delta carries FULL merged
 *   text (G5) but NO tool blocks. If we let chat deltas overwrite the
 *   `blocks` array, the tool/thinking cards we stitched in from agent events
 *   disappear on the next text delta, causing them to "flicker" or simply
 *   vanish until a hard refresh replays history.
 *
 * Rules:
 *   - Empty incoming → keep current (common during aborted frames).
 *   - Empty current  → take incoming verbatim.
 *   - Otherwise     → use incoming as the new baseline, then APPEND any
 *                     tool_use / tool_result / thinking blocks from current
 *                     that aren't already present (by id / tool_use_id /
 *                     signature+text) so they survive across text deltas.
 *
 * This is used ONLY by the `chat` event delta/final path. The agent-event
 * path (`_applyAgentEvent`) mutates tool blocks directly.
 */
export function mergeStreamingBlocks(
  currentBlocks: ContentBlock[],
  incomingBlocks: ContentBlock[],
): ContentBlock[] {
  if (incomingBlocks.length === 0) return currentBlocks;
  if (currentBlocks.length === 0) return incomingBlocks;

  // Index which ids the incoming payload already covers — anything not in
  // this set from `current` gets appended.
  const incomingToolUseIds = new Set<string>();
  const incomingToolResultRefs = new Set<string>();
  const incomingThinkingSigs = new Set<string>();
  for (const b of incomingBlocks) {
    if (b.type === "tool_use") {
      const id = (b as { id?: string }).id;
      if (id) incomingToolUseIds.add(id);
    } else if (b.type === "tool_result") {
      const refId = (b as { tool_use_id?: string }).tool_use_id;
      if (refId) incomingToolResultRefs.add(refId);
    } else if (b.type === "thinking") {
      const sig = thinkingSignature(b as ThinkingLike);
      if (sig) incomingThinkingSigs.add(sig);
    }
  }

  const extras: ContentBlock[] = [];
  for (const b of currentBlocks) {
    if (b.type === "tool_use") {
      const id = (b as { id?: string }).id;
      // Keep the extra when we have an id AND incoming doesn't have it. If
      // the tool_use carries no id (shouldn't happen — normalize synthesizes
      // empty string — but defensive), we keep it once so the tool card
      // survives; dedupe by first-wins stance.
      if (!id || !incomingToolUseIds.has(id)) extras.push(b);
    } else if (b.type === "tool_result") {
      const refId = (b as { tool_use_id?: string }).tool_use_id;
      if (!refId || !incomingToolResultRefs.has(refId)) extras.push(b);
    } else if (b.type === "thinking") {
      const sig = thinkingSignature(b as ThinkingLike);
      if (!sig || !incomingThinkingSigs.has(sig)) extras.push(b);
    }
    // Text + unknown blocks from current are discarded — incoming is the
    // authoritative source for text (G5) and for any provider-specific
    // blocks we don't understand.
  }

  if (extras.length === 0) return incomingBlocks;
  // Append extras AFTER incoming so text stays at the top of the bubble and
  // tool/thinking cards render below (matching openclaw's render order where
  // pre-tool text flushes before tool cards via `flushBufferedChatDelta`).
  return [...incomingBlocks, ...extras];
}

type ThinkingLike = {
  type: "thinking";
  thinkingSignature?: string;
  thinking?: string;
  index?: number;
};

function thinkingSignature(b: ThinkingLike): string {
  if (b.thinkingSignature) return `sig:${b.thinkingSignature}`;
  if (typeof b.index === "number") return `idx:${b.index}`;
  // Last-resort: first 80 chars of text — same thinking block re-streamed
  // will collide, anything genuinely different will stay distinct enough.
  const t = typeof b.thinking === "string" ? b.thinking : "";
  return t ? `t:${t.slice(0, 80)}` : "";
}

/**
 * Detect whether a raw transcript message is a TOOL message — either because
 * it has top-level tool markers (Claude CLI import shape stamps `toolName` /
 * `toolCallId` on the message, not on a content block) or because any content
 * block is a tool_use / tool_result part.
 *
 * Mirrors openclaw's `ui-agentbuff/src/ui/chat/message-normalizer.ts:244-260`
 * exactly — same signals, same ordering. When `isTool` is true, the UI should
 * route via the tool-card surface regardless of the raw `role` (assistant CLI
 * imports carry role="assistant" but are semantically tool outputs).
 */
export function detectToolMarkers(
  raw: GatewayTranscriptMessage | null | undefined,
): { isTool: boolean; toolName?: string; toolCallId?: string } {
  if (!raw) return { isTool: false };
  const m = raw as Record<string, unknown>;
  const toolName =
    (typeof m.toolName === "string" && m.toolName.trim()) ||
    (typeof m.tool_name === "string" && m.tool_name.trim()) ||
    undefined;
  const toolCallId =
    (typeof m.toolCallId === "string" && m.toolCallId.trim()) ||
    (typeof m.tool_call_id === "string" && m.tool_call_id.trim()) ||
    undefined;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const roleIsTool =
    role === "tool" ||
    role === "toolresult" ||
    role === "tool_result" ||
    role === "function";

  let contentCarriesTool = false;
  if (Array.isArray(raw.content)) {
    for (const part of raw.content) {
      const t = typeof part?.type === "string" ? part.type.toLowerCase() : "";
      if (
        t === "tool_use" ||
        t === "tool_call" ||
        t === "tooluse" ||
        t === "toolcall" ||
        t === "tool_result" ||
        t === "toolresult"
      ) {
        contentCarriesTool = true;
        break;
      }
    }
  }

  const isTool = Boolean(
    toolName || toolCallId || roleIsTool || contentCarriesTool,
  );
  return { isTool, toolName, toolCallId };
}

/**
 * When a message carries top-level tool markers but its content is plain text
 * (Claude CLI import's standalone-tool-message shape — see
 * `ui-agentbuff/src/ui/chat/tool-cards.ts:183-203`), synthesize a
 * `tool_result` block from that text so `MessageBlocks` can render it as a
 * collapsible Tool output card instead of a chat bubble.
 *
 * Rules:
 *  - If `blocks` already has any tool_use / tool_result block → return as-is.
 *  - Else if markers + there's text-only content → wrap the text as a
 *    `tool_result` block referencing `toolCallId`.
 *  - Else → return `blocks` unchanged.
 */
export function reshapeToolMessageBlocks(
  blocks: ContentBlock[],
  markers: { toolName?: string; toolCallId?: string },
): ContentBlock[] {
  const hasToolBlock = blocks.some(
    (b) => b.type === "tool_use" || b.type === "tool_result",
  );
  if (hasToolBlock) return blocks;
  const text = blocksToText(blocks).trim();
  if (!text) return blocks;
  const synthesized: ContentBlock = {
    type: "tool_result",
    tool_use_id: markers.toolCallId || "",
    content: text,
    is_error: false,
  };
  return [synthesized];
}

/**
 * Pull renderable image attachments out of a raw transcript message. Used on
 * history rehydrate so the user sees thumbnails for files they previously
 * sent. Supports two shapes:
 *
 *   1. Claude-native blocks:
 *        { type: "image", source: { type: "base64", media_type, data } }
 *   2. `[media attached: media://inbound/<id>]` markers — the gateway's
 *      offload path (>2 MB) rewrites large images into these markers plus
 *      sidecar metadata. We don't have a media:// resolver in the browser,
 *      so those show up only via shape (1) when the gateway also keeps an
 *      inline copy. Offloaded-only images render as a "[gambar]" placeholder
 *      via the text path; no thumbnail. A future MVP can add a fetch route
 *      for `/api/users/me/media/<id>` to hydrate these.
 */
export function extractMessageAttachments(
  content: ContentValue,
): AttachmentPart[] {
  if (typeof content === "string") return [];
  if (!Array.isArray(content)) return [];
  const out: AttachmentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = attachmentPartFromImageBlock(
      raw as Record<string, unknown>,
    );
    if (part) out.push(part);
  }
  return out;
}

/**
 * Per-message usage metadata surfaced under the assistant bubble — mirrors
 * openclaw's `GroupMeta` (ui-agentbuff/src/ui/chat/grouped-render.ts:338–347)
 * but scoped to a single message so the footer sits under its own bubble
 * instead of a grouped wrapper.
 *
 * Field-name unions come from different providers — Anthropic uses
 * `inputTokens`, OpenAI uses `input`, Anthropic cache uses
 * `cache_read_input_tokens`, etc. We accept either per wire shape and
 * normalize to a single canonical shape for the renderer.
 */
export type MessageMeta = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
};

/**
 * Pull per-message usage + model + cost out of a raw transcript message.
 * Returns `null` when neither `usage` nor `model` is set — callers render
 * nothing when meta is null so user bubbles and system markers stay clean.
 *
 * We do NOT look at `role` here — the caller already filters by role, and
 * some providers still include usage on tool_result user-role messages
 * (prompt caching touches them).
 */
export function extractMessageMeta(
  raw: GatewayTranscriptMessage | null | undefined,
): MessageMeta | null {
  if (!raw) return null;
  const usage = raw.usage ?? null;
  const input = Math.max(
    0,
    Math.floor(usage?.input ?? usage?.inputTokens ?? 0),
  );
  const output = Math.max(
    0,
    Math.floor(usage?.output ?? usage?.outputTokens ?? 0),
  );
  const cacheRead = Math.max(
    0,
    Math.floor(usage?.cacheRead ?? usage?.cache_read_input_tokens ?? 0),
  );
  const cacheWrite = Math.max(
    0,
    Math.floor(usage?.cacheWrite ?? usage?.cache_creation_input_tokens ?? 0),
  );
  const cost =
    typeof raw.cost?.total === "number" && Number.isFinite(raw.cost.total)
      ? raw.cost.total
      : 0;
  // "gateway-injected" is openclaw's sentinel for model-less internal
  // system messages — skip so we don't render a bogus model pill.
  const model =
    typeof raw.model === "string" && raw.model && raw.model !== "gateway-injected"
      ? raw.model
      : null;
  const hasUsage = input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
  if (!hasUsage && !model) return null;
  return { input, output, cacheRead, cacheWrite, cost, model };
}

/** Compact token count formatter: 128000 → "128k", 1234 → "1.2k". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.floor(n));
}

/** Strip provider prefix from a model id: "google/gemini-2.5-flash" → "gemini-2.5-flash". */
export function shortenModel(model: string): string {
  const idx = model.indexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/** I1 — current locale used by date/time formatting in this module. Set
 *  by the I18nProvider whenever the user toggles locale; falls back to
 *  Indonesian. Module-level rather than hook-driven because these helpers
 *  are pure functions called from non-React contexts (rawToMessage,
 *  session sort) where threading a hook isn't possible. */
let currentLocale: string = "id-ID";

const RELATIVE_PHRASES: Record<string, {
  justNow: string;
  minutes: (n: number) => string;
  hours: (n: number) => string;
  days: (n: number) => string;
}> = {
  "id-ID": {
    justNow: "baru saja",
    minutes: (n) => `${n} mnt lalu`,
    hours: (n) => `${n} jam lalu`,
    days: (n) => `${n} hari lalu`,
  },
  "en-US": {
    justNow: "just now",
    minutes: (n) => `${n} min ago`,
    hours: (n) => `${n} hr ago`,
    days: (n) => `${n} d ago`,
  },
};

/** Called by the I18nProvider on mount + locale change so the date/time
 *  helpers below render in the active language. Defensive: rejects
 *  unrecognised codes and falls back to id-ID. */
export function setSessionUtilsLocale(locale: string): void {
  const normalized = locale === "en" ? "en-US" : locale === "id" ? "id-ID" : locale;
  currentLocale = normalized in RELATIVE_PHRASES ? normalized : "id-ID";
}

/** Format a message timestamp as a short HH:MM (user's locale). */
export function formatClockTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleTimeString(currentLocale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * ISO-like day key in the user's LOCAL timezone: "2026-04-24". Serves as a
 * stable identifier for a calendar day — React `key` for divider rows, and
 * `data-day-key` attribute for the sticky pill's scroll observer. We build it
 * from `getFullYear / getMonth / getDate` rather than `toISOString` because
 * the latter is UTC and would bucket late-night messages into the wrong day
 * for anyone east or west of GMT.
 */
export function localDayKey(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** True when two timestamps fall on the same calendar day in local TZ. */
export function sameLocalDay(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ka = localDayKey(a);
  const kb = localDayKey(b);
  return ka !== "" && ka === kb;
}

/**
 * Format a message timestamp as a WhatsApp-style day divider label in Bahasa
 * Indonesia.
 *   - Today            → "Hari ini"
 *   - Yesterday        → "Kemarin"
 *   - 2–6 days ago     → localized weekday ("Senin", "Selasa", …)
 *   - Same calendar yr → "12 Oktober"
 *   - Prior year+      → "12 Oktober 2025"
 *
 * DST-safe: day diff is computed from midnight-aligned timestamps, not raw
 * `(now - ms)` which breaks on spring-forward nights. Future timestamps fall
 * through to the absolute-date format so clock-skew never yields "Kemarin"
 * about tomorrow.
 */
export function formatDayDivider(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const target = new Date(ms);
  if (Number.isNaN(target.getTime())) return "";
  const now = new Date();
  const todayMid = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const targetMid = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  ).getTime();
  const dayDiff = Math.round((todayMid - targetMid) / 86_400_000);
  if (dayDiff === 0) return "Hari ini";
  if (dayDiff === 1) return "Kemarin";
  if (dayDiff >= 2 && dayDiff <= 6) {
    try {
      return new Intl.DateTimeFormat("id-ID", { weekday: "long" }).format(
        target,
      );
    } catch {
      /* fall through */
    }
  }
  try {
    if (target.getFullYear() === now.getFullYear()) {
      return new Intl.DateTimeFormat("id-ID", {
        day: "numeric",
        month: "long",
      }).format(target);
    }
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(target);
  } catch {
    return "";
  }
}

/**
 * Structural subset of `ChatMessage` (in store.ts) used by
 * `computeSessionPreview`. We keep this loose + readonly so the helper stays
 * usable with any message-like shape without importing the full ChatMessage
 * type — a direct import would create a circular dep (store.ts already imports
 * from this file).
 */
export type SessionPreviewMessage = {
  role: "user" | "assistant" | "system";
  kind?: "chat" | "tool";
  state?: "pending" | "delta" | "final" | "error" | "aborted";
  content: string;
  blocks?: ContentBlock[];
  hasToolActivity?: boolean;
};

const PREVIEW_BUDGET = 70;

/**
 * One-line WhatsApp-style preview shown under the session title in the sidebar.
 * Walks messages from the tail picking the most recent "renderable" bubble,
 * prefixes "Kamu: " when the last speaker was the user, flattens whitespace,
 * and truncates with an ellipsis at `PREVIEW_BUDGET` chars.
 *
 * Skipped: system messages (noisy for the reader), tool turns (carries trace
 * not prose), pending/aborted/errored states (no useful content yet), and
 * empty bubbles.
 *
 * Also accepts a single in-flight streaming message: pass `[streaming]` to
 * preview live-updating assistant deltas — gateway throttles at ~150ms so the
 * sidebar won't thrash.
 */
export function computeSessionPreview(
  messages: readonly SessionPreviewMessage[] | null | undefined,
): string {
  if (!messages || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "system") continue;
    if (m.kind === "tool") continue;
    if (
      m.state === "pending" ||
      m.state === "error" ||
      m.state === "aborted"
    ) {
      continue;
    }
    const raw = previewTextFromMessage(m);
    if (!raw) continue;
    const flat = raw.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const prefix = m.role === "user" ? "Kamu: " : "";
    const budget = Math.max(12, PREVIEW_BUDGET - prefix.length);
    const cut =
      flat.length > budget
        ? `${flat.slice(0, budget - 1).trimEnd()}…`
        : flat;
    return `${prefix}${cut}`;
  }
  return "";
}

function previewTextFromMessage(m: SessionPreviewMessage): string {
  if (m.blocks && m.blocks.length > 0) {
    const t = blocksToText(m.blocks);
    if (t) return t;
  }
  return typeof m.content === "string" ? m.content : "";
}

/**
 * Format a session's `updatedAt` (ms) as a short humanised relative string in
 * Bahasa Indonesia. Falls back to the full date when older than a week.
 */
export function formatRelativeTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "baru saja";
  const sec = Math.floor(diff / 1000);
  const phrases = RELATIVE_PHRASES[currentLocale] ?? RELATIVE_PHRASES["id-ID"];
  if (sec < 45) return phrases.justNow;
  const min = Math.floor(sec / 60);
  if (min < 60) return phrases.minutes(min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return phrases.hours(hr);
  const day = Math.floor(hr / 24);
  if (day < 7) return phrases.days(day);
  try {
    return new Date(ms).toLocaleDateString(currentLocale, {
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "";
  }
}

// ── Heartbeat filter ────────────────────────────────────────────────────
//
// Widened port of `Reff/openclaw/src/auto-reply/heartbeat-filter.ts`. The
// upstream heartbeat runner periodically injects a synthetic user-role
// prompt (default: "Read HEARTBEAT.md if it exists ... reply HEARTBEAT_OK.";
// legacy: "Run the following periodic tasks..."; or a custom per-agent
// variant ending with "reply HEARTBEAT_OK") and expects the agent to reply
// with just `HEARTBEAT_OK` when nothing needs attention.
//
// Those pairs are dev/ops telemetry, not chat. Mass-market UI (§2.5) drops
// them so the transcript only shows real back-and-forth.
//
// IMPORTANT — this is a CYCLE collapse, not an adjacent-pair match. When the
// agent literally follows the heartbeat prompt and does tool work (e.g.
// actually reads HEARTBEAT.md before answering), the transcript reads:
//
//   [user   : "Read HEARTBEAT.md ... reply HEARTBEAT_OK"]
//   [assist : thinking + tool_use(read)]
//   [user   : tool_result only]               ← role=user by Claude convention
//   [assist : "HEARTBEAT_OK"]
//
// A plain adjacent-pair filter drops NOTHING because msg[1] isn't an ACK.
// We instead walk from the heartbeat prompt to the next HEARTBEAT_OK ack
// and drop every message in between — including interleaved tool_result
// bearing messages with role="user".
//
// We CAN'T see the per-agent custom `heartbeatPrompt` client-side, so we
// widen detection: any user text mentioning "Read HEARTBEAT.md" OR
// instructing "reply/respond/balas HEARTBEAT_OK" counts as a prompt.
// False-positive risk is low — no human types that sentinel by hand.

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const HEARTBEAT_DEFAULT_PREFIX_LEGACY =
  "Run the following periodic tasks (only those due based on their intervals):";
// Current OpenClaw default prompt body — see
// `Reff/openclaw/src/auto-reply/heartbeat.ts:15`. May appear anywhere in the
// message text because the wire concatenates `System:` preamble lines before
// the prompt body.
const HEARTBEAT_READ_MD_MARKER = "Read HEARTBEAT.md";

type FilterableMessage = {
  role: string;
  content?: string | null;
  blocks?: ReadonlyArray<{ type: string }> | null;
};

/** True if this is a user-role synthetic prompt injected by the heartbeat
 *  runner. Matches three shapes:
 *
 *   1. Default prompt body contains "Read HEARTBEAT.md" (current).
 *   2. Legacy prefix "Run the following periodic tasks...".
 *   3. Any text that tells the agent to reply/respond/balas `HEARTBEAT_OK`
 *      (covers custom `heartbeatPrompt` config values). */
export function isHeartbeatPrompt(message: FilterableMessage): boolean {
  if (message.role !== "user") return false;
  const text = (message.content ?? "").trim();
  if (!text) return false;
  if (text.includes(HEARTBEAT_READ_MD_MARKER)) return true;
  if (text.includes(HEARTBEAT_DEFAULT_PREFIX_LEGACY)) return true;
  const idx = text.indexOf(HEARTBEAT_TOKEN);
  if (idx < 0) return false;
  const window = text.slice(Math.max(0, idx - 40), idx).toLowerCase();
  return (
    window.includes("reply") ||
    window.includes("respond") ||
    window.includes("balas")
  );
}

/** True if this is an agent's heartbeat ACK — text boils down to just the
 *  sentinel token after stripping whitespace/punctuation. Tolerates
 *  leading/trailing markdown and code fences the agent sometimes wraps
 *  the token in. */
export function isHeartbeatAck(message: FilterableMessage): boolean {
  if (message.role !== "assistant") return false;
  const raw = (message.content ?? "").trim();
  if (!raw) return false;
  const cleaned = raw
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^[`*_]+/g, "")
    .replace(/[`*_.!?\s]+$/g, "")
    .trim();
  return cleaned === HEARTBEAT_TOKEN;
}

/** Tool-result-only user-role messages carry no text and only tool_result
 *  blocks. In Claude-shape wire, `tool_result` rides on role=user — but
 *  those aren't "real" user turns; they're the downstream of a preceding
 *  assistant tool_use. Used to recognize "still inside a heartbeat cycle"
 *  when the agent uses tools before answering. */
function isToolResultUserPayload(message: FilterableMessage): boolean {
  if (message.role !== "user") return false;
  const hasText = !!(message.content && message.content.trim());
  if (hasText) return false;
  const blocks = message.blocks;
  if (!blocks || blocks.length === 0) return false;
  return blocks.every((b) => b.type === "tool_result");
}

/**
 * Collapse heartbeat cycles from a transcript. A cycle starts at a user-role
 * heartbeat prompt and ends at the next `HEARTBEAT_OK` assistant ack (or at
 * the next real user message, whichever comes first). Everything inside —
 * including interleaved thinking / tool_use / tool_result payloads — is
 * dropped. O(n), one forward pass.
 *
 * If the agent produced a meaningful reply instead of the ack sentinel, we
 * still drop the heartbeat prompt but STOP at the next real user message, so
 * any useful agent content from the cycle stays visible (edge case: user
 * types while heartbeat fires — usually impossible since heartbeat skips
 * busy sessions, but we don't want to lose real replies).
 */
export function filterHeartbeatPairs<T extends FilterableMessage>(
  messages: readonly T[],
): T[] {
  if (messages.length === 0) return messages.slice();
  const out: T[] = [];
  let i = 0;
  while (i < messages.length) {
    const cur = messages[i];
    if (!isHeartbeatPrompt(cur)) {
      out.push(cur);
      i += 1;
      continue;
    }
    // Drop the heartbeat prompt itself, then walk forward consuming every
    // agent-side / tool-result message until we hit either:
    //   (a) an assistant HEARTBEAT_OK ack → drop and stop
    //   (b) a real user message → stop BEFORE it (don't consume)
    let j = i + 1;
    while (j < messages.length) {
      const m = messages[j];
      if (m.role === "user" && !isToolResultUserPayload(m)) {
        // Real user turn — cycle interrupted, hand off without consuming.
        break;
      }
      if (m.role === "assistant" && isHeartbeatAck(m)) {
        j += 1;
        break;
      }
      j += 1;
    }
    i = j;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
//  Date grouping (Sessions tab)
// ────────────────────────────────────────────────────────────────────────
//
// Hermes Desktop UX pattern from Sessions.tsx:47-85. Group sessions by
// calendar-relative buckets so the list reads chronologically without a
// flat infinite scroll.

export type SessionDateGroup =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "earlier";

/** Resolve a session's `updatedAt` timestamp into a calendar-relative
 *  bucket. Uses CALENDAR DAYS (not 24-hour windows) — a session updated
 *  at 23:59 yesterday and one at 00:01 today fall in different buckets
 *  even though they're 2 minutes apart, which matches Chief's intuitive
 *  "kemarin" / "hari ini" mental model.
 *
 *  Cutoffs:
 *    - today      → same calendar day as now
 *    - yesterday  → exactly 1 calendar day prior
 *    - thisWeek   → 2-7 calendar days prior
 *    - earlier    → >7 calendar days
 *
 *  Returns `"earlier"` for null/0/invalid timestamps so they never
 *  pollute recent groups. */
export function sessionDateGroup(
  updatedAt: number | null | undefined,
  now: number = Date.now(),
): SessionDateGroup {
  if (!updatedAt || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "earlier";
  }
  const d = new Date(updatedAt);
  const n = new Date(now);
  // Same calendar day
  if (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  ) {
    return "today";
  }
  // Calendar day prior — compute via daysBetween
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const diffDays = Math.round((nDay - dDay) / (24 * 60 * 60 * 1000));
  if (diffDays === 1) return "yesterday";
  if (diffDays >= 2 && diffDays <= 7) return "thisWeek";
  return "earlier";
}

export interface SessionDateGroups<T> {
  today: T[];
  yesterday: T[];
  thisWeek: T[];
  earlier: T[];
}

/** Partition an array of session-like rows into 4 date buckets. Preserves
 *  the input order WITHIN each bucket — caller is responsible for sorting
 *  (typically newest-first by `updatedAt`). */
export function groupSessionsByDate<
  T extends { updatedAt?: number | null },
>(rows: T[], now: number = Date.now()): SessionDateGroups<T> {
  const out: SessionDateGroups<T> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const row of rows) {
    out[sessionDateGroup(row.updatedAt, now)].push(row);
  }
  return out;
}

/** Ordered list of groups for rendering — skip empties so the UI doesn't
 *  show "Yesterday (0)" headers. */
export const SESSION_DATE_GROUP_ORDER: SessionDateGroup[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

