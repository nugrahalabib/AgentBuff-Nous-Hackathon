/**
 * Central Zustand store for the /app surface. Per ADR §D2, components are
 * read-only subscribers — ALL mutation goes through actions defined here.
 *
 * M3: multi-session state. History, streaming, sending, errors, and loading
 * flags are all keyed by canonical session key so that switching sessions
 * leaves the other sessions' in-flight work intact. The active session is
 * persisted to localStorage so refresh / reconnect lands on the same thread.
 *
 * Wire gotcha G5: streaming deltas carry the FULL merged assistant text,
 * never a chunk — renderers must REPLACE. This store follows that contract.
 */
import { create } from "zustand";
import {
  GatewayClient,
  GatewayError,
} from "@/lib/hermes/browser-gateway";
import type {
  AgentEventPayload,
  ApprovalRequestBlock,
  ApprovalResolved,
  ChatEventPayload,
  ClarifyRequestBlock,
  ClarifyResolved,
  ContentBlock,
  GatewaySessionRow,
  GatewayTranscriptMessage,
  SessionsGetResult,
  SessionsListParams,
  SessionsListResult,
  SessionsPatchParams,
  SessionsPatchResult,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/lib/hermes/rpc-types";
import {
  agentIdFromSessionKey,
  blocksToText,
  canonicalizeSessionKey,
  detectToolMarkers,
  extractMessageAttachments,
  extractMessageMeta,
  extractMessageText,
  isDashboardSessionKey,
  mergeStreamingBlocks,
  messageHasNonTextParts,
  normalizeContentBlocks,
  reshapeToolMessageBlocks,
  sessionRowTitle,
  type MessageMeta,
} from "./session-utils";
import {
  type AttachmentDraft,
  type AttachmentPart,
  draftToPart,
  draftsToWireAttachments,
} from "./attachments";
import {
  parseUserPayload,
  type UserContextMeta,
} from "./strip-inbound-meta";
import { extractAssistantBotMedia } from "./extract-bot-media";
import { classifyErrorMessage } from "./errors";

export type ConnStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  /** Semantic channel for the renderer. `"tool"` means the underlying
   *  message is a tool invocation / output (either by top-level toolName
   *  marker or by tool_use / tool_result content blocks) — the UI MUST
   *  render it as a tool card, not as a chat bubble, regardless of the raw
   *  `role`. Mirrors openclaw's `isToolMessage` branch in
   *  `ui-agentbuff/src/ui/chat/grouped-render.ts:1231`. */
  kind?: "chat" | "tool";
  /** Full merged text (G5). Derived from `blocks` — kept for quick display
   *  in bubbles that don't need per-block rendering (user bubbles, sidebar
   *  previews, search). For assistant messages this is the TEXT-ONLY merge;
   *  tool / thinking content lives ONLY in `blocks`. */
  content: string;
  /** True when the underlying message has tool_use / tool_result parts. */
  hasToolActivity?: boolean;
  /** Preserved verbatim from the wire (normalized to a typed union).
   *  Renderer iterates these in order — text, tool calls, tool results, and
   *  thinking blocks all appear in one flat sequence per Claude-shape wire. */
  blocks: ContentBlock[];
  /** User-attached images. Populated:
   *   - Optimistically from `AttachmentDraft` on send (blob URL preview).
   *   - From history rehydrate by parsing `image` blocks on the transcript. */
  attachments?: AttachmentPart[];
  /** Gateway-injected preamble layers (bootstrap, channel envelope,
   *  timestamp, sender/conversation/replied/forwarded/history JSON) captured
   *  from user-role messages by `parseUserPayload`. The renderer surfaces
   *  this as a collapsible "Konteks yang AI terima" card below the user
   *  bubble so the stripped bubble stays clean while the raw context the
   *  LLM received remains auditable. `undefined` when nothing was captured
   *  (assistant messages, plain user messages without gateway envelope). */
  userContext?: UserContextMeta;
  /** Per-turn usage + model metadata. Populated for assistant messages at
   *  end-of-turn (final/aborted/error), and on history rehydrate. Renderer
   *  uses this to show the ↑in ↓out · ctx% · model footer under the bubble. */
  meta?: MessageMeta | null;
  state: "pending" | "delta" | "final" | "error" | "aborted";
  errorMessage?: string;
  createdAt: number;
  /** Timestamp (ms) when the message was edited in-place via
   *  `editMessageInPlace` action. UI shows "diedit" label. */
  editedAt?: number;
  /** Soft-deleted via `deleteMessageInPlace`. UI renders strikethrough
   *  placeholder instead of original content. */
  deleted?: boolean;
  deletedAt?: number;
  /** Discord-parity ephemeral message — visible to invoker only, never
   *  persisted by Hermes. /app renders with dotted border + "Cuma
   *  keliatan sama kamu" footer note. */
  ephemeral?: boolean;
};

export type SessionSummary = {
  key: string;
  title: string;
  updatedAt: number | null;
  kind: GatewaySessionRow["kind"];
  totalTokens?: number;
  /** Session-level context window (tokens). Used alongside `message.meta.input`
   *  to compute contextPercent in the assistant-bubble footer. */
  contextTokens?: number;
  /** Short preview of the last message as supplied by the gateway via
   *  `sessions.list { includeLastMessage: true }`. Used as fallback in the
   *  sidebar for sessions whose full transcript hasn't been loaded into the
   *  store yet (the store only populates `messages[key]` for sessions the
   *  user has actively opened). */
  lastMessagePreview?: string;
  /** EXTENDED FIELDS (Sessions tab v2):
   *  Token usage breakdown — kumulasi input/output. */
  inputTokens?: number;
  outputTokens?: number;
  /** Model info terakhir dipakai. */
  model?: string;
  modelProvider?: string;
  /** Runtime status terakhir run. */
  status?: GatewaySessionRow["status"];
  /** True kalau run terakhir di-abort user. */
  abortedLastRun?: boolean;
  /** Runtime stats. */
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  /** AI behavior settings — global agent config (persisted di
   *  ~/.hermes/config.yaml). Sama value untuk semua session si agent
   *  yang sama. Bridge surface ke setiap row biar dropdown drawer
   *  show current state. */
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  /** Child sessions yang di-spawn dari sesi ini (parent_session_id lineage). */
  childSessions?: string[];
  /** Engine UUID — distinct from the user-facing `key` (sid alias). */
  sessionId?: string;
  /** Channel surface raw (e.g. "telegram:bot:123"). Only set if source
   *  has channel format. */
  surface?: string;
  /** Raw `source` string dari Hermes (tui/cli/api_server/telegram/whatsapp/...).
   *  UI uses this for the channel filter — separate dari `kind` axis. */
  source?: string;
  /** Channel-side peer identity (siapa yang ngobrol dari channel). Web sessions
   *  punya none. WhatsApp LID auto-resolve ke nomor telepon di bridge. */
  peer?: string;
  /** Display-friendly peer label (e.g. "+6287877974096" atau Telegram user id). */
  peerLabel?: string;
  /** Owning agent id (bridge-resolved from source via the platforms map;
   *  "default" for web/app/cli). Drives the per-agent badge + filter. */
  agentId?: string;
};

/** Cross-session content search result — returned by bridge
 *  `sessions.search` RPC. Hermes Desktop parity (Sessions.tsx search
 *  result row shape).
 *
 *  Display priority: `snippetHtml` (with `<mark>` around match) for the
 *  search-results list, `snippet` (plain) as accessibility fallback +
 *  for serialization (export / copy).
 */
export type SessionSearchResult = {
  sessionKey: string;
  title: string;
  snippet: string;
  snippetHtml: string;
  matchCount: number;
  updatedAt: number;
  source: string | null;
  messageCount: number;
};

/** User-defined folder for grouping sessions (AgentBuff feature, persisted
 *  via bridge `folders.*` RPCs in `~/.hermes/agentbuff_folders.json`). */
export type SessionFolder = {
  id: string;
  name: string;
  emoji?: string | null;
  color?: string | null;
  description?: string | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_SESSION_KEY = canonicalizeSessionKey("main");
const ACTIVE_SESSION_STORAGE_KEY = "agentbuff:app:activeSessionKey";
const DRAFTS_STORAGE_KEY = "agentbuff:app:drafts";

// Mirrors `Reff/openclaw/src/sessions/session-label.ts:1`. Server will reject
// labels beyond this length — we clip client-side to give immediate feedback.
export const SESSION_LABEL_MAX_LENGTH = 512;
// Soft cap for the inline rename input to keep the sidebar tidy. Users who
// paste anything longer still get clipped to SESSION_LABEL_MAX_LENGTH before
// the RPC call.
export const SESSION_LABEL_SOFT_MAX = 80;
/** Per-draft character ceiling — guards against a rogue paste blowing up
 *  localStorage. 20k chars fits ~5 book pages, well beyond any realistic
 *  chat prompt. Texts longer than this get truncated on persist. */
const DRAFT_MAX_LENGTH = 20_000;
/** Total serialized-JSON byte ceiling. localStorage quota is typically
 *  5–10 MB per origin; drafts are ephemeral so we cap at a conservative
 *  256 KB — if we exceed, we drop the persistence attempt silently and
 *  the in-memory store keeps working. */
const DRAFT_MAX_TOTAL_BYTES = 256 * 1024;
/** Debounce window for localStorage flushes. Every keystroke mutates the
 *  store; without debounce we'd write to localStorage on every character
 *  which is wasteful and can stall on Safari private mode. 200 ms matches
 *  the typical human typing cadence so a pause → flush. */
const DRAFT_FLUSH_DEBOUNCE_MS = 200;

let clientInstance: GatewayClient | null = null;

// Sessions we've already told the gateway to pin at verbose=full + reasoning=
// stream. Scoped to module lifetime (== GatewayClient lifetime, since the
// provider re-mounts the store on reconnect via attachClient) so a reconnect
// re-patches once; repeated calls within the same connect are no-ops. Source
// of truth for whether the gateway has the per-session entry is still the
// gateway's own session metadata file — this Set just trims chatter.
const patchedSessionDefaults = new Set<string>();

// In-flight `sessions.patch` promises, keyed by canonical session key. A
// second caller arriving while the first call is still mid-RPC JOINS the
// existing promise instead of short-circuiting on the `patchedSessionDefaults`
// Set. Without this, the common race is:
//   · bootstrap fires patch fire-and-forget  → set.add() → RPC in flight
//   · user hits Send ~50 ms later            → set.has → `await` returns
//                                                immediately, chat.send races
//                                                ahead of the patch landing.
// Consequence: the gateway streams with the PREVIOUS (stripped) verbose/
// reasoning settings on the very first message — which is exactly Bug B
// (thinking never renders realtime) and contributes to Bug A's tool card
// content being empty on first turn. Awaiting the shared promise fixes both.
const inFlightPatchPromises = new Map<string, Promise<void>>();

function newMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Remove a single key from a Record<string, T> without mutating the input.
 *  No-op when the key is absent (returns the same reference) so Zustand's
 *  shallow equality check doesn't trigger a re-render for a noop set. */
function dropKey<T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function loadPersistedActiveKey(): string {
  if (typeof window === "undefined") return DEFAULT_SESSION_KEY;
  try {
    const stored = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    return stored && stored.trim() ? stored : DEFAULT_SESSION_KEY;
  } catch {
    return DEFAULT_SESSION_KEY;
  }
}

function persistActiveKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, key);
  } catch {
    /* quota / safari private — non-fatal */
  }
}

// ────────── draft persistence ──────────
// Debounced flush: accumulates the latest drafts snapshot and writes it
// to localStorage 200 ms after the last mutation. If multiple edits land
// inside the window the last one wins — safe because `drafts` is already
// a plain object keyed by session, not a diff-stream.
let draftFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDraftSnapshot: Record<string, string> | null = null;

// Bug-B (2026-06-09): session titles are generated asynchronously a few seconds
// AFTER the first exchange (engine for the default agent; the bridge's
// profile_title hook for per-agent sessions). Nothing re-pulled sessions.list
// after that window, so the sidebar kept showing "Sesi utama"/"Thread baru"
// until a manual refresh. A single COALESCED refresh ~4s after each terminal
// turn re-reads the list once the title has landed. Coalesced so a multi-turn
// burst fires only one trailing refresh. 4s is < the bridge's 12s deleted-sid
// tombstone, so a session deleted during the wait stays suppressed.
let titleRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Surface a draft-persistence failure to the store so the composer can
 *  show a one-shot toast. Tolerant of being called before the store has
 *  finished initializing (early-mount edge case) — we late-bind via a
 *  lazy lookup and silently no-op if the action isn't registered yet. */
function flagDraftPersistenceFailure(
  reason: "quota" | "oversize" | "unavailable",
): void {
  try {
    // useAppStore is defined below this helper at module scope.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (globalThis as any).__agentbuff_store__ as
      | { setState: (patch: { draftPersistenceWarning: typeof reason }) => void }
      | undefined;
    if (store) {
      store.setState({ draftPersistenceWarning: reason });
    }
  } catch {
    /* worst-case the warning just doesn't show — drafts still live in memory */
  }
}

/** Clear the warning after a successful flush so retries (user closes tab,
 *  re-opens, types something short) don't carry stale alerts. */
function clearDraftPersistenceFlag(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (globalThis as any).__agentbuff_store__ as
      | { setState: (patch: { draftPersistenceWarning: null }) => void; getState: () => { draftPersistenceWarning: unknown } }
      | undefined;
    if (store && store.getState().draftPersistenceWarning != null) {
      store.setState({ draftPersistenceWarning: null });
    }
  } catch {
    /* non-fatal */
  }
}

function scheduleDraftFlush(drafts: Record<string, string>): void {
  if (typeof window === "undefined") return;
  pendingDraftSnapshot = drafts;
  if (draftFlushTimer != null) return;
  draftFlushTimer = setTimeout(() => {
    draftFlushTimer = null;
    const toFlush = pendingDraftSnapshot;
    pendingDraftSnapshot = null;
    if (!toFlush) return;
    try {
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(toFlush)) {
        if (typeof v !== "string" || v.length === 0) continue;
        trimmed[k] = v;
      }
      if (Object.keys(trimmed).length === 0) {
        window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
        clearDraftPersistenceFlag();
        return;
      }
      const serialized = JSON.stringify(trimmed);
      if (serialized.length > DRAFT_MAX_TOTAL_BYTES) {
        // Oversized blob — refuse to persist. In-memory drafts still work
        // for the tab lifetime; surface a warning so the user knows their
        // accumulated drafts won't survive a reload.
        flagDraftPersistenceFailure("oversize");
        return;
      }
      window.localStorage.setItem(DRAFTS_STORAGE_KEY, serialized);
      clearDraftPersistenceFlag();
    } catch (err) {
      // Detect quota vs other failures so the toast copy is accurate.
      const name =
        err instanceof Error ? err.name : err && typeof err === "object" ? (err as { name?: string }).name : undefined;
      // QuotaExceededError (Chromium/WebKit) + NS_ERROR_DOM_QUOTA_REACHED (FF).
      // Code 22 + 1014 also signal quota; we map both names + the generic 22 code.
      const isQuota =
        name === "QuotaExceededError" ||
        name === "NS_ERROR_DOM_QUOTA_REACHED" ||
        (err instanceof DOMException && (err.code === 22 || err.code === 1014));
      flagDraftPersistenceFailure(isQuota ? "quota" : "unavailable");
    }
  }, DRAFT_FLUSH_DEBOUNCE_MS);
}

function loadPersistedDrafts(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== "string" || !k) continue;
      if (typeof v !== "string" || v.length === 0) continue;
      // Cap per-draft length in case the stored blob was tampered with —
      // shouldn't happen normally because we cap on write, but defense in
      // depth costs nothing.
      out[k] =
        v.length > DRAFT_MAX_LENGTH ? v.slice(0, DRAFT_MAX_LENGTH) : v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Convert a raw transcript message into a renderable ChatMessage.
 *
 * Role handling — we preserve `role` verbatim from the wire for semantics,
 * but set `kind: "tool"` whenever the message carries tool markers (either
 * top-level `toolName`/`toolCallId` fields or any tool_use/tool_result
 * content block). The UI routes `kind === "tool"` to a tool-card surface
 * regardless of role, which matches openclaw's own routing at
 * `ui-agentbuff/src/ui/chat/grouped-render.ts:1231`.
 *
 * Standalone-tool-message reshape: when markers say "this is a tool" but
 * the blocks are text-only (Claude CLI import shape), we synthesize a
 * `tool_result` block from the text so the renderer shows a collapsible
 * Tool output card — mirrors `ui-agentbuff/src/ui/chat/tool-cards.ts:183-203`.
 */

/**
 * Optimistic block mutation helper for interactive resolution flows
 * (approval, clarify). Walks `messages[sessionKey]`, finds blocks
 * matching `predicate`, shallow-merges `patch` into them, returns the
 * next state object. Returns the SAME state when no block matches
 * (preserves referential stability for the React render path).
 *
 * Used by `resolveApproval` / `resolveClarify` to stamp `.resolved`
 * on the request block in-place — bubble swaps from button grid to
 * `✅ Disetujui ... oleh Chief` narrative line without waiting for a
 * server event (Hermes' resolution is synchronous via the RPC).
 */
function mutateBlockField<P extends Record<string, unknown>>(
  state: AppState,
  sessionKey: string,
  predicate: (block: ContentBlock) => boolean,
  patch: P,
): Partial<AppState> {
  const list = state.messages[sessionKey];
  if (!list || list.length === 0) return state;
  let mutated = false;
  const nextList = list.map((msg) => {
    if (!msg.blocks || msg.blocks.length === 0) return msg;
    let blockMutated = false;
    const nextBlocks = msg.blocks.map((b) => {
      if (predicate(b)) {
        blockMutated = true;
        return { ...b, ...patch };
      }
      return b;
    });
    if (!blockMutated) return msg;
    mutated = true;
    return { ...msg, blocks: nextBlocks };
  });
  if (!mutated) return state;
  return { messages: { ...state.messages, [sessionKey]: nextList } };
}

function rawToMessage(
  raw: GatewayTranscriptMessage,
  fallbackRole: ChatMessage["role"] = "assistant",
): ChatMessage {
  const rawBlocks = normalizeContentBlocks(raw.content);
  const markers = detectToolMarkers(raw);
  let blocks = markers.isTool
    ? reshapeToolMessageBlocks(rawBlocks, markers)
    : rawBlocks;
  const rawText = blocksToText(blocks) || extractMessageText(raw.content);
  const role: ChatMessage["role"] =
    raw.role === "user" || raw.role === "assistant" || raw.role === "system"
      ? raw.role
      : fallbackRole;
  // User-role messages carry gateway-injected preambles (bootstrap prelude,
  // channel envelope, inbound-meta sentinel blocks + JSON fence, leading
  // timestamp). `parseUserPayload` splits them into `cleanText` (what the
  // user actually typed, used in the bubble) and `context` (the preamble
  // layers, surfaced as a collapsible audit card below the bubble) — same
  // contract openclaw's own ui-agentbuff applies via `extractText`, plus
  // structured capture for the /app audit UI.
  let text = rawText;
  let userContext: UserContextMeta | undefined;
  let botMediaAttachments: AttachmentPart[] = [];
  if (role === "user") {
    const parsed = parseUserPayload(rawText);
    text = parsed.cleanText;
    if (parsed.context.hasAny) userContext = parsed.context;
    // Sync blocks with cleanText so any consumer reading `blocks` (copy-to-
    // clipboard, search, future renderers) sees the stripped prose too —
    // `content` and `blocks` must agree or we leak raw preamble through the
    // other surface. Preserve non-text blocks (images attached to the user
    // turn) at their original positions AFTER the collapsed text block.
    const nonTextBlocks = blocks.filter((b) => b.type !== "text");
    blocks = text
      ? [{ type: "text", text } as ContentBlock, ...nonTextBlocks]
      : nonTextBlocks;
  } else if (role === "assistant" && !markers.isTool) {
    // Hermes session storage persists the agent's RAW reply verbatim
    // (including `MEDIA:/abs/path` + `[[audio_as_voice]]` directives).
    // When /app rehydrates history via sessions.get, rawToMessage sees
    // that raw text — so without this strip pass, the bubble shows MEDIA:
    // tag as plaintext + no AudioCard.
    //
    // Bridge's event_translator runs `extract_bot_media` on the LIVE
    // `message.complete` event and emits cleaned text + AttachmentPart[]
    // in the chat event. This block is the symmetric history-rehydrate
    // path — same cleaned text + AttachmentPart[] for refreshed bubbles.
    const { cleanedText, attachments: extracted } =
      extractAssistantBotMedia(rawText);
    if (cleanedText !== rawText || extracted.length > 0) {
      text = cleanedText;
      botMediaAttachments = extracted;
      // Sync blocks too, mirroring user-role's clean-prose sync above.
      const nonTextBlocks = blocks.filter((b) => b.type !== "text");
      blocks = cleanedText
        ? [{ type: "text", text: cleanedText } as ContentBlock, ...nonTextBlocks]
        : nonTextBlocks;
    }
  }
  let attachments = extractMessageAttachments(raw.content);
  // Merge bot-side extracted attachments (assistant role only) — these are
  // the AudioCard / ImageCard / VideoCard / DocumentCard entries the
  // bridge would have emitted live. On history reload they re-materialize
  // from the persisted MEDIA: tag in the assistant text.
  if (botMediaAttachments.length > 0) {
    attachments = [...attachments, ...botMediaAttachments];
  }
  // Restore persistent HTTP URLs from the PORTAL_ATTACHMENT_URLS sentinel
  // on history rehydrate. Hermes only persists message text — the original
  // file handle + blob URL are gone after refresh, but the bridge embeds a
  // sentinel pointing at `/media/<token>/<filename>` (registered via
  // `media_serve.register_media`) so we can rebuild the attachment row
  // here and the per-kind card (Audio/Image/Video/Document) renders fully
  // playable + downloadable. Only kick in when there are no live attachments
  // (i.e. raw.content has no inline image blocks).
  if (
    attachments.length === 0 &&
    userContext?.portalAttachmentUrls &&
    userContext.portalAttachmentUrls.length > 0
  ) {
    attachments = userContext.portalAttachmentUrls.map((meta) => ({
      kind: meta.kind,
      name: meta.name,
      displayUrl: meta.displayUrl,
      sizeBytes: meta.sizeBytes,
      // mimeType is required on AttachmentPart for `<img src>`+download
      // negotiation. Sentinel may omit it for ancient rows — fall back to
      // the conventional kind-default so consumers don't crash.
      mimeType:
        meta.mimeType ||
        (meta.kind === "image"
          ? "image/*"
          : meta.kind === "audio"
            ? "audio/*"
            : meta.kind === "video"
              ? "video/*"
              : "application/octet-stream"),
    }));
  }
  return {
    // ID precedence:
    //  1. `__agentbuff.id` — stable bridge-synthesized id (`agb_<dbkey>_<idx>`)
    //     from rpc_router._claude_blocks_from_raw_messages. Survives refresh,
    //     anchors pin/delete/edit/react RPCs back to a deterministic slot
    //     in session_<dbkey>.json. ← The fix for chief's "pin/catatan/delete
    //     hilang setelah refresh" report.
    //  2. `__openclaw.id` — legacy from the OpenClaw era; kept for any
    //     custom skill/adapter that still emits it.
    //  3. `newMessageId()` — client-side UUID. Only used during the live
    //     streaming window before the message hits session JSON. The first
    //     subsequent sessions.get refresh replaces it with a stable id.
    id:
      (raw as { __agentbuff?: { id?: string } }).__agentbuff?.id ||
      raw.__openclaw?.id ||
      newMessageId(),
    role,
    kind: markers.isTool ? "tool" : "chat",
    content: text,
    hasToolActivity: !text && messageHasNonTextParts(raw.content),
    blocks,
    attachments: attachments.length > 0 ? attachments : undefined,
    userContext,
    meta:
      role === "assistant" && !markers.isTool ? extractMessageMeta(raw) : null,
    state: "final",
    createdAt:
      typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : Date.now(),
    // Propagate bridge-side mutations from session JSON on rehydrate.
    // editedAt + deleted flags are written by handle_messages_edit /
    // handle_messages_delete (rpc_router.py) into the session file.
    editedAt:
      typeof (raw as { editedAt?: unknown }).editedAt === "number"
        ? ((raw as { editedAt: number }).editedAt as number)
        : undefined,
    deleted: (raw as { deleted?: boolean }).deleted === true,
    deletedAt:
      typeof (raw as { deletedAt?: unknown }).deletedAt === "number"
        ? ((raw as { deletedAt: number }).deletedAt as number)
        : undefined,
  };
}

/** Hermes 0.14 returns Unix timestamps in SECONDS (float). The portal
 *  treats `updatedAt` as JS milliseconds everywhere (Date constructor,
 *  formatRelativeTime, sort comparisons). Detect the seconds-shape by
 *  the magnitude — anything < year 2050 expressed as ms would still be
 *  > 2.5e12, so any value below 1e12 must be in seconds. Multiply ×1000.
 *  Returning null for absent values lets sort + format fall through.
 */
function normalizeEpoch(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  // < 1e12 ≈ ms < year 2001-09-09 → must be seconds
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

function rowToSummary(
  row: GatewaySessionRow,
  defaultContextTokens: number | null,
): SessionSummary {
  return {
    key: row.key,
    title: sessionRowTitle(row),
    updatedAt: normalizeEpoch(row.updatedAt),
    kind: row.kind,
    totalTokens: row.totalTokens,
    contextTokens: row.contextTokens ?? defaultContextTokens ?? undefined,
    lastMessagePreview: row.lastMessagePreview,
    // Extended fields untuk Sessions tab v2 — kategori 1 fields yang truly
    // missing di Hermes engine udah dihapus (subject/room/space/elevatedLevel/
    // compactionCheckpointCount). Behavior settings (thinkingLevel etc) come
    // from config.yaml via bridge sessions.list enrichment.
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    model: row.model,
    modelProvider: row.modelProvider,
    status: row.status,
    abortedLastRun: row.abortedLastRun,
    startedAt: normalizeEpoch(row.startedAt) ?? undefined,
    endedAt: normalizeEpoch(row.endedAt) ?? undefined,
    runtimeMs: row.runtimeMs,
    thinkingLevel: row.thinkingLevel,
    fastMode: row.fastMode,
    verboseLevel: row.verboseLevel,
    reasoningLevel: row.reasoningLevel,
    childSessions: row.childSessions,
    sessionId: row.sessionId,
    surface: row.surface,
    source: row.source,
    peer: row.peer,
    peerLabel: row.peerLabel,
    // 2026-06-09: derive the owning agent from the session KEY namespace
    // (agent:<id>:<rest>), which is the truthful source — the engine's
    // `row.agentId` is unreliable (it reports "default" for many non-default
    // agent sessions, e.g. a key "agent:manager-pribadi:..." came back with
    // agentId="default"). That mismatch made the chat header/avatar/responder
    // bubble + sidebar face render the DEFAULT agent (Buff) instead of the
    // session's real agent. The key is always correct, so prefer it.
    agentId: agentIdFromSessionKey(row.key) ?? row.agentId,
  };
}

// ────────── agent-event helpers ──────────
// Tool + thinking streams mutate the currently-streaming assistant message's
// `blocks` array directly. These helpers are factored out of `_applyAgentEvent`
// so the router stays a one-screen dispatcher and each stream's shape-specific
// logic sits in its own function.
//
// Wire contract references:
//   - tool stream phase machine: `Reff/openclaw/ui-agentbuff/src/ui/app-tool-stream.ts:450-536`
//   - thinking stream shape:     `Reff/openclaw/src/agents/pi-embedded-subscribe.ts:672-682`
//
// Block-identity rules (mirrored in `mergeStreamingBlocks`):
//   - tool_use block identity   = `id` (== `toolCallId` from the wire)
//   - tool_result block identity = `tool_use_id` (back-reference to tool_use.id)
//   - thinking block identity   = `thinkingSignature` > `index` > first 80 chars
//
// A tool event may arrive BEFORE the first `chat` delta (some providers emit
// tool_use pre-text). In that case we synthesize a fresh streaming entry so
// the renderer has something to bind to — `chat` delta will merge its text
// into it later via `mergeStreamingBlocks`.

type StoreSet = (
  partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState>),
) => void;

function ensureStreamingEntry(
  current: ChatMessage | null,
  blocks: ContentBlock[],
  options: { hasTool?: boolean } = {},
): ChatMessage {
  if (current) {
    return {
      ...current,
      blocks,
      hasToolActivity: options.hasTool || current.hasToolActivity,
      // Sticky kind — don't downgrade an existing chat message to tool just
      // because a tool event landed mid-stream. The kind flag gates whether
      // the WHOLE bubble renders as a tool card vs. an assistant bubble with
      // inline tool activity — for /app we always want the latter, so we
      // preserve whatever kind was already set (defaults to "chat" on fresh
      // entries below).
      kind: current.kind ?? "chat",
    };
  }
  return {
    id: newMessageId(),
    role: "assistant",
    kind: "chat",
    content: "",
    hasToolActivity: options.hasTool || false,
    blocks,
    state: "delta",
    createdAt: Date.now(),
  };
}

/** Coerce a raw tool-result payload (arbitrary shape from the tool's return
 *  value) into the `ToolResultBlock["content"]` union. Strings pass through,
 *  arrays are treated as already-shaped content parts, objects get
 *  JSON.stringify'd into a single text part. */
function toToolResultContent(
  raw: unknown,
): ToolResultBlock["content"] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (item && typeof item === "object") {
        return item as { type?: string; text?: string; [k: string]: unknown };
      }
      return { type: "text", text: String(item) };
    });
  }
  if (typeof raw === "object") {
    try {
      return [{ type: "text", text: JSON.stringify(raw, null, 2) }];
    } catch {
      return [{ type: "text", text: String(raw) }];
    }
  }
  return [{ type: "text", text: String(raw) }];
}

/**
 * Tool event → split into its own ChatMessage in `messages[key]` (NOT merged
 * into the streaming bubble). This mirrors openclaw's own ui-agentbuff render
 * pipeline, where tool cards sit between text bubbles as peer items rather
 * than inline inside the assistant bubble.
 *
 * Architectural contract:
 *   - Tool blocks (tool_use + tool_result) live ONLY on kind:"tool" ChatMessages
 *     committed into `messages[key]`. They NEVER live on `streaming[key]`.
 *   - The ChatMessage `id` is the gateway `toolCallId`, so start/update/result
 *     phases for the same tool call mutate a single committed row in-place.
 *   - When a tool_use arrives mid-turn AFTER some assistant text was streamed,
 *     we flush the streaming text as a kind:"chat" state:"final" ChatMessage
 *     and bump `turnTextOffset[key]` by the length of the committed text. The
 *     gateway's internal buffer keeps accumulating across tool boundaries (see
 *     server-chat.ts:822 — `buffers.delete` only fires at `emitChatFinal`), so
 *     subsequent chat deltas carry `pre-tool-text + post-tool-text` concatenated.
 *     Slicing incoming `payload.text` at the offset yields the genuinely-new
 *     post-tool segment for the next streaming bubble.
 *   - Offset resets to 0 on any terminal state (final / aborted / error) in
 *     `_applyChatEvent`, which is where the turn's last chat segment commits.
 *
 * Render contract (chat-thread.tsx `buildAgentItems` + `groupTurns`):
 *   Consecutive assistant-side messages (role=assistant OR kind=tool) collapse
 *   into one agent turn with a shared avatar + left rail, but each chat bubble
 *   and each tool card renders as its own row within that turn. That's what
 *   makes pre-tool → tool → post-tool read as `bubble · card · bubble` with
 *   continuous rail glue.
 */
function applyToolAgentEvent(
  set: StoreSet,
  key: string,
  data: Record<string, unknown>,
): void {
  const toolCallId =
    typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) return;
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";
  const isPendingSynth = Boolean(data.pendingSynth);
  const rawArgs = phase === "start" ? data.args : undefined;
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : undefined;
  const isDone = phase === "result";
  const hasOutput =
    isDone || phase === "update" || data.result !== undefined;
  const resultPayload = isDone
    ? data.result
    : phase === "update"
      ? data.partialResult
      : undefined;
  const isError = Boolean(
    (data as { isError?: unknown }).isError ||
      (data as { is_error?: unknown }).is_error,
  );

  set((s) => {
    const list = s.messages[key] ?? [];
    // Look for an exact tool_id match first.
    let toolIdx = list.findIndex(
      (m) => m.kind === "tool" && m.id === toolCallId,
    );
    // Synth → real id migration: when tool.start arrives with a REAL
    // call_xxx id, see if there's a pending card with synth id
    // `pending-<session>-<name>` for the same tool name. If yes, adopt
    // it in place and rewrite its id to the real one. This is what
    // bridges the tool.generating/progress → tool.start gap so the
    // UI doesn't render two cards for the same execution.
    if (
      toolIdx < 0 &&
      phase === "start" &&
      !toolCallId.startsWith("pending-") &&
      !isPendingSynth
    ) {
      const synthIdx = list.findIndex(
        (m) =>
          m.kind === "tool" &&
          typeof m.id === "string" &&
          m.id.startsWith("pending-") &&
          m.id.endsWith(`-${name}`),
      );
      if (synthIdx >= 0) {
        toolIdx = synthIdx;
      }
    }
    const existingTool = toolIdx >= 0 ? list[toolIdx] : null;
    const isMigration =
      existingTool !== null &&
      typeof existingTool.id === "string" &&
      existingTool.id !== toolCallId &&
      existingTool.id.startsWith("pending-");

    // ── Compute merged blocks for THIS tool ChatMessage ──────────────────
    // On synth→real migration, rewrite any block-level synth ids to the
    // real toolCallId so the tool_use/tool_result findIndex below can
    // match correctly. Without this rewrite, we'd append a NEW tool_use
    // block instead of updating the existing pending one, leaving two
    // tool_use entries in the card.
    const existingBlocks = isMigration
      ? (existingTool!.blocks ?? []).map((b) => {
          if (b.type === "tool_use" && (b as ToolUseBlock).id === existingTool!.id) {
            return { ...(b as ToolUseBlock), id: toolCallId };
          }
          if (
            b.type === "tool_result" &&
            (b as ToolResultBlock).tool_use_id === existingTool!.id
          ) {
            return { ...(b as ToolResultBlock), tool_use_id: toolCallId };
          }
          return b;
        })
      : (existingTool?.blocks ?? []);
    const nextBlocks: ContentBlock[] = [...existingBlocks];

    // tool_use (append-or-update). Sticky fields: once `name` / `input` are
    // known, a later `update`/`result` without them shouldn't blank the card.
    const toolUseIdx = nextBlocks.findIndex(
      (b) =>
        b.type === "tool_use" && (b as ToolUseBlock).id === toolCallId,
    );
    if (toolUseIdx < 0) {
      const toolUse: ToolUseBlock = {
        type: "tool_use",
        id: toolCallId,
        name,
        ...(args ? { input: args } : {}),
      };
      nextBlocks.push(toolUse);
    } else if (phase === "start" || args !== undefined) {
      const prev = nextBlocks[toolUseIdx] as ToolUseBlock;
      nextBlocks[toolUseIdx] = {
        ...prev,
        name: name || prev.name,
        input: args ?? prev.input,
      };
    }

    // tool_result (append-or-update). `is_error` is a latch — once flipped,
    // stays flipped across subsequent update/result frames.
    if (hasOutput) {
      const content = toToolResultContent(resultPayload);
      const resultIdx = nextBlocks.findIndex(
        (b) =>
          b.type === "tool_result" &&
          (b as ToolResultBlock).tool_use_id === toolCallId,
      );
      const resultBlock: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: toolCallId,
        ...(content !== undefined ? { content } : {}),
        ...(isError ? { is_error: true } : {}),
      };
      if (resultIdx < 0) {
        nextBlocks.push(resultBlock);
      } else {
        const prev = nextBlocks[resultIdx] as ToolResultBlock;
        nextBlocks[resultIdx] = {
          ...resultBlock,
          ...(prev.is_error || isError ? { is_error: true } : {}),
        };
      }
    }

    // ── Flush streaming text BEFORE appending the new tool message ───────
    // Only fires when:
    //   · The tool is brand-new (first time we see this toolCallId), AND
    //   · There's streaming text to commit (non-empty content), AND
    //   · Phase is "start" (subsequent update/result frames never flush).
    // Missing any condition → no flush, offset unchanged.
    const current = s.streaming[key] ?? null;
    const shouldFlush =
      existingTool === null &&
      phase === "start" &&
      !!current &&
      typeof current.content === "string" &&
      current.content.length > 0;

    const nextList = [...list];
    let nextStreaming = s.streaming;
    let nextOffset = s.turnTextOffset;

    if (shouldFlush && current) {
      // Commit the streaming text as a final chat message. Thinking blocks
      // attached to `current.blocks` stay attached so `buildAgentItems` can
      // still hoist them into their own render item above this bubble.
      const textOnlyBlocks: ContentBlock[] = current.blocks.length > 0
        ? current.blocks.filter((b) => b.type !== "tool_use" && b.type !== "tool_result")
        : current.content
          ? [{ type: "text", text: current.content }]
          : [];
      const flushed: ChatMessage = {
        ...current,
        blocks: textOnlyBlocks,
        hasToolActivity: false,
        kind: "chat",
        state: "final",
      };
      nextList.push(flushed);
      nextStreaming = { ...s.streaming, [key]: null };
      nextOffset = {
        ...s.turnTextOffset,
        [key]: (s.turnTextOffset[key] ?? 0) + current.content.length,
      };
    }

    // ── Append or update the tool ChatMessage ────────────────────────────
    if (toolIdx >= 0) {
      // Update in-place so the existing MessageBlocks card swaps content
      // without re-keying (keeps scroll position + any open-collapsed state).
      // Migration: when adopting a pending-* card under a real call_xxx id,
      // also rewrite the ChatMessage.id so subsequent tool.complete frames
      // (which look up by id) hit the same row.
      nextList[toolIdx] = {
        ...nextList[toolIdx],
        id: isMigration ? toolCallId : nextList[toolIdx].id,
        blocks: nextBlocks,
        hasToolActivity: true,
      };
    } else {
      const toolMsg: ChatMessage = {
        id: toolCallId,
        role: "assistant",
        kind: "tool",
        content: "",
        hasToolActivity: true,
        blocks: nextBlocks,
        state: "final",
        createdAt: Date.now(),
      };
      nextList.push(toolMsg);
    }

    return {
      messages: { ...s.messages, [key]: nextList },
      streaming: nextStreaming,
      turnTextOffset: nextOffset,
    };
  });
}

function applyThinkingAgentEvent(
  set: StoreSet,
  key: string,
  data: Record<string, unknown>,
): void {
  // Gateway emits `{ text, delta }` where `text` is the full merged reasoning
  // and `delta` is the suffix since last event. We store `text` (full) so the
  // renderer REPLACES on every update — same contract as chat G5.
  const text = typeof data.text === "string" ? data.text : "";
  const deltaText = typeof data.delta === "string" ? data.delta : "";
  const merged = text || deltaText;
  if (!merged) return;
  const signature =
    typeof (data as { thinkingSignature?: unknown }).thinkingSignature ===
    "string"
      ? ((data as { thinkingSignature?: string }).thinkingSignature as string)
      : undefined;
  const redacted = Boolean(
    (data as { redacted?: unknown }).redacted,
  );

  set((s) => {
    const current = s.streaming[key] ?? null;
    // Defensive dedupe: if Hermes ever emits a thinking event whose text
    // exactly matches the in-flight assistant chat text, that's an echo
    // (commonly seen on models without native thinking — Hermes' fallback
    // sends `reasoning.available` with assistant text; bridge drops those
    // but this guard catches any straggler that slips via thinking.delta).
    // Without this dedupe a "Pemikiran agen" card would render the SAME
    // text as the chat bubble below it.
    const streamingChatText = (
      (current && typeof current.content === "string" && current.content) ||
      ""
    ).trim();
    if (
      streamingChatText &&
      streamingChatText === merged.trim()
    ) {
      return s;
    }
    const baseBlocks = current?.blocks ?? [];
    const nextBlocks = [...baseBlocks];

    // Reasoning streams back as a rolling full-text buffer. We update the LAST
    // thinking block (tail position) so multi-step reasoning (rare in Claude
    // but possible with interleaved thinking) still accrues — a signature
    // change forces a new block, matching the identity rule in
    // `mergeStreamingBlocks`.
    let thinkingIdx = -1;
    for (let i = nextBlocks.length - 1; i >= 0; i -= 1) {
      if (nextBlocks[i].type === "thinking") {
        thinkingIdx = i;
        break;
      }
    }
    const prevThinking =
      thinkingIdx >= 0 ? (nextBlocks[thinkingIdx] as ThinkingBlock) : null;
    const sameSignature =
      signature !== undefined &&
      prevThinking?.thinkingSignature !== undefined &&
      prevThinking.thinkingSignature === signature;
    const appendNew =
      thinkingIdx < 0 ||
      (signature !== undefined && !sameSignature);

    const block: ThinkingBlock = {
      type: "thinking",
      thinking: merged,
      ...(signature ? { thinkingSignature: signature } : {}),
      ...(redacted ? { redacted: true } : {}),
    };
    if (appendNew) {
      nextBlocks.push(block);
    } else {
      nextBlocks[thinkingIdx] = block;
    }

    const nextStreaming = ensureStreamingEntry(current, nextBlocks);
    return {
      streaming: { ...s.streaming, [key]: nextStreaming },
    };
  });
}

// ── subagent / status / approval / clarify / browser stream handlers ──
// Each fans-out an `agent.stream=<kind>` event into a discrete ChatMessage
// of `kind: "tool"` so chat-thread renders it inline like any other tool
// card. New ContentBlock subtypes carry the specific payload — UI side
// of message-blocks.tsx maps each type to a styled card.

function appendOrUpdateBlockMessage(
  set: StoreSet,
  key: string,
  messageId: string,
  block: ContentBlock,
  options?: { hint?: string },
): void {
  set((s) => {
    const list = s.messages[key] ?? [];
    const idx = list.findIndex((m) => m.id === messageId);
    const nextList = [...list];
    if (idx >= 0) {
      const existing = nextList[idx];
      const existingBlocks = existing.blocks ?? [];
      // Replace block of same type targeting same id (if any), otherwise append.
      const sameIdx = existingBlocks.findIndex((b) => b.type === block.type);
      const nextBlocks = [...existingBlocks];
      if (sameIdx >= 0) nextBlocks[sameIdx] = block;
      else nextBlocks.push(block);
      nextList[idx] = {
        ...existing,
        blocks: nextBlocks,
        hasToolActivity: true,
      };
    } else {
      nextList.push({
        id: messageId,
        role: "assistant",
        kind: "tool",
        content: options?.hint ?? "",
        hasToolActivity: true,
        blocks: [block],
        state: "final",
        createdAt: Date.now(),
      });
    }
    return { messages: { ...s.messages, [key]: nextList } };
  });
}

function applySubagentAgentEvent(
  set: StoreSet,
  key: string,
  data: Record<string, unknown>,
): void {
  const subId =
    typeof data.subagentId === "string" && data.subagentId
      ? data.subagentId
      : `sub-${Date.now()}`;
  const messageId = `sub-${subId}`;
  const block: ContentBlock = {
    type: "subagent",
    subagentId: subId,
    phase:
      typeof data.phase === "string"
        ? (data.phase as "start" | "tool" | "complete")
        : "start",
    parentId: typeof data.parentId === "string" ? data.parentId : undefined,
    depth: typeof data.depth === "number" ? data.depth : undefined,
    goal: typeof data.goal === "string" ? data.goal : undefined,
    taskIndex: typeof data.taskIndex === "number" ? data.taskIndex : undefined,
    taskCount: typeof data.taskCount === "number" ? data.taskCount : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    toolName: typeof data.toolName === "string" ? data.toolName : undefined,
    toolPreview:
      typeof data.toolPreview === "string" ? data.toolPreview : undefined,
    inputTokens:
      typeof data.inputTokens === "number" ? data.inputTokens : undefined,
    outputTokens:
      typeof data.outputTokens === "number" ? data.outputTokens : undefined,
    costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined,
    summary: typeof data.summary === "string" ? data.summary : undefined,
    durationSeconds:
      typeof data.durationSeconds === "number"
        ? data.durationSeconds
        : undefined,
  };
  appendOrUpdateBlockMessage(set, key, messageId, block);
}

function applyStatusAgentEvent(
  set: StoreSet,
  key: string,
  data: Record<string, unknown>,
): void {
  const text = typeof data.text === "string" ? data.text : "";
  if (!text) return;
  const kind = typeof data.kind === "string" ? data.kind : "info";
  // Each status update is a discrete one-shot row, not an update of an
  // existing card. Use timestamp-derived id so each emits its own row.
  const messageId = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const block: ContentBlock = {
    type: "status_update",
    statusKind: kind,
    text,
  };
  appendOrUpdateBlockMessage(set, key, messageId, block);
}

function applyInteractiveAgentEvent(
  set: StoreSet,
  key: string,
  stream: "approval" | "clarify",
  data: Record<string, unknown>,
): void {
  const requestId =
    typeof data.requestId === "string" && data.requestId
      ? data.requestId
      : `${stream}-${Date.now()}`;
  const messageId = `${stream}-${requestId}`;
  let block: ContentBlock;
  if (stream === "approval") {
    block = {
      type: "approval_request",
      requestId,
      title: typeof data.title === "string" ? data.title : "Persetujuan diperlukan",
      summary: typeof data.summary === "string" ? data.summary : undefined,
      // Danger context the bridge emits — surfaced so the UI can warn the
      // user what's actually being approved (command preview, reason, and
      // the matched guard patterns that drive the severity + suggestion).
      command: typeof data.command === "string" ? data.command : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      patternKeys: Array.isArray(data.patternKeys)
        ? (data.patternKeys.filter((p) => typeof p === "string") as string[])
        : undefined,
      kind: typeof data.kind === "string" ? data.kind : "generic",
      details: data.details,
      // Owning session — so `approval.respond` routes to the right session
      // even when it isn't the active one (multi-agent / session switch).
      sessionKey: key,
    };
  } else {
    block = {
      type: "clarify_request",
      requestId,
      question: typeof data.question === "string" ? data.question : "",
      choices: Array.isArray(data.choices)
        ? (data.choices.filter((c) => typeof c === "string") as string[])
        : [],
      sessionKey: key,
    };
  }
  appendOrUpdateBlockMessage(set, key, messageId, block);
}

function applyBrowserAgentEvent(
  set: StoreSet,
  key: string,
  data: Record<string, unknown>,
): void {
  const message = typeof data.message === "string" ? data.message : "";
  if (!message) return;
  const level = typeof data.level === "string" ? data.level : "info";
  // Append-only history of browser steps, one row per emit.
  const messageId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const block: ContentBlock = {
    type: "browser_progress",
    message,
    level,
    url: typeof data.url === "string" ? data.url : undefined,
  };
  appendOrUpdateBlockMessage(set, key, messageId, block);
}

/**
 * Engine snapshot — info dari `proxy.ready` event saat WS connect ready.
 * Forwarded oleh `ws-proxy.ts` dari upstream gateway connect response.
 * Berisi raw runtime info (uptime, version, auth mode, tick interval) yang
 * dipakai Detail Engine zone tanpa butuh extra RPC call.
 *
 * null saat belum connect, atau tidak null setelah pertama kali ready.
 * Tidak di-clear saat reconnect — tetap show last known value sampai
 * proxy.ready berikutnya update.
 */
export type EngineSnapshot = {
  uptimeMs: number | null;
  authMode: string | null;
  runtimeVersion: string | null;
  tickIntervalMs: number | null;
  /** ISO string saat snapshot terakhir di-receive. */
  receivedAt: string;
};

export type AppState = {
  status: ConnStatus;
  /** True when the container has NO LLM provider key/OAuth configured — the
   *  agent can't chat until the user adds a brain in the Providers tab. */
  needsBrain: boolean;
  engineSnapshot: EngineSnapshot | null;

  activeSessionKey: string;
  sessions: SessionSummary[];
  /** Feature B — view-only filter: when set, the sidebar shows ONLY this
   *  agent's sessions (toggled by clicking an agent card in the right rail).
   *  Non-persisted on purpose: a deleted/renamed agent must not leave a stale
   *  filter that blanks the sidebar forever (the sidebar self-heals to null
   *  when the id leaves the roster). null = no filter (show every session). */
  activeAgentFilter: string | null;
  sessionsLoaded: boolean;
  sessionsError: string | null;

  /** User-defined session folders (AgentBuff foldering feature). Loaded
   *  on connect-ready via bridge `folders.list`. Edited via CRUD actions.
   *  Persisted in `~/.hermes/agentbuff_folders.json` on the bridge side. */
  folders: SessionFolder[];
  /** Map of canonical sessionKey → folderId. A session NOT in this map
   *  is unassigned (shows in "Tanpa folder" group). */
  sessionFolders: Record<string, string>;
  foldersLoaded: boolean;

  messages: Record<string, ChatMessage[]>;
  streaming: Record<string, ChatMessage | null>;
  sending: Record<string, boolean>;
  loadingHistory: Record<string, boolean>;
  errors: Record<string, string | null>;
  /** Raw db session ids (matches SessionSummary.sessionId) that are currently
   *  mid-reply — sourced from the bridge `sessions.activity` watcher so the web
   *  shows a live "working" indicator for CHANNEL sessions (WhatsApp/Telegram)
   *  whose agent runs in a separate process and never streams to /app. */
  liveSessionIds: string[];

  /** Canonical agent ids reported working by the bridge `sessions.activity`
   *  watcher's active-turn marker — the in-flight signal for CHANNEL turns. The
   *  engine persists a turn's user+assistant messages atomically at turn END,
   *  so a channel session never appears mid-reply in the DB; this is the only
   *  way /app can animate an agent's card while it works off-web. */
  liveAgentIds: string[];

  /** Per-session cumulative length of text already committed to prior chat
   *  segments IN THE CURRENT TURN. Used by `_applyChatEvent` to slice the
   *  incoming `payload.text` (which is full merged text from turn start, G5)
   *  down to just the post-offset portion for the CURRENT streaming segment.
   *
   *  Why: gateway's text buffer accumulates across the entire turn — it is
   *  only deleted at `emitChatFinal` (Reff/openclaw/src/gateway/server-chat.ts
   *  :822). So any chat delta arriving AFTER a tool event still carries the
   *  pre-tool text prepended to the post-tool text. Without this offset we'd
   *  re-render the already-committed pre-tool prose on every post-tool delta,
   *  producing duplicated text in the active bubble.
   *
   *  Lifecycle:
   *   · Starts at 0 (or missing → treated as 0) for a fresh turn.
   *   · `applyToolAgentEvent` bumps it when it flushes the streaming bubble
   *     on a brand-new tool_use.
   *   · `_applyChatEvent` resets it to 0 on terminal states (final / aborted /
   *     error), which is where the turn itself ends.
   *   · `_handleConnectionDrop` clears it wholesale because any in-flight
   *     turns abort.
   *   · `deleteSession` drops the entry alongside the session's other state. */
  turnTextOffset: Record<string, number>;

  /** Per-session composer drafts (what the user has typed but not sent yet).
   *  Keyed by canonical session key. Persisted to localStorage (debounced
   *  200 ms) so refresh / accidental tab close restores pending prose.
   *  Attachments are NOT persisted — File handles aren't serializable. */
  drafts: Record<string, string>;

  /** Non-null when the most recent draft-flush attempt failed (localStorage
   *  quota exceeded, Safari private mode, oversized snapshot). The composer
   *  surfaces this as a one-time toast so the user knows their pending text
   *  won't survive a reload. Cleared via `clearDraftPersistenceWarning()`
   *  after the toast is dismissed; auto-cleared on the next successful flush. */
  draftPersistenceWarning: "quota" | "oversize" | "unavailable" | null;

  /** H3 — Search within thread. When non-empty, ChatThread highlights
   *  matches and dims non-matches. The match count is derived in the
   *  component since it depends on the rendered list. */
  chatSearchQuery: string;
  /** Index into the in-transcript-order list of messages whose content
   *  contains `chatSearchQuery`. ↑/↓ arrows in `ChatSearchControl`
   *  bump this; an effect there observes the bump and scrolls the
   *  corresponding `[data-message-id]` element into view + flashes a
   *  brief ring (WhatsApp/Telegram-style navigation). Resets to 0 on
   *  query change so the first arrow press lands on the FIRST match.
   *  -1 = no active match (empty query or no matches). */
  chatSearchActiveIndex: number;
  setChatSearchActiveIndex: (index: number) => void;

  /** H4 — Default agent for newly-created chat sessions. Picked via the
   *  agent dropdown in the workspace header; persists across reloads.
   *  Used by `createSession` to prefix new session keys with the chosen
   *  agent. Existing sessions keep whichever agent prefix they were
   *  created with (Hermes resolves the agent from the session key). */
  defaultAgentId: string;

  sidebarOpen: boolean;

  _setStatus: (s: ConnStatus) => void;
  setNeedsBrain: (v: boolean) => void;
  _setEngineSnapshot: (snap: EngineSnapshot | null) => void;
  _applyChatEvent: (payload: ChatEventPayload) => void;
  /** Merge a single AGENT-event frame into the active streaming message for
   *  its session. Handles `stream === "tool"` (tool_use + tool_result) and
   *  `stream === "item"` (thinking blocks mid-run). Other streams are
   *  accepted but produce no UI state change — we still pay attention to
   *  lifecycle/compaction/fallback in the future, but for MVP we only
   *  surface tool + thinking activity. */
  _applyAgentEvent: (payload: AgentEventPayload) => void;
  _applySessionsList: (result: SessionsListResult) => void;
  /** Apply the bridge `sessions.activity` watcher payload — the set of db
   *  session ids whose agent is mid-reply (channel realtime monitoring). */
  _applySessionsActivity: (
    workingSids: string[],
    workingAgentIds?: string[],
  ) => void;
  _setSessionsError: (msg: string | null) => void;
  _setHistoryLoading: (key: string, loading: boolean) => void;
  _replaceHistory: (key: string, messages: ChatMessage[]) => void;
  _handleConnectionDrop: () => void;

  setActiveSession: (key: string) => Promise<void>;
  /** Feature B — set/clear the agent session-filter. null clears it. Toggle
   *  logic (click same agent → clear) lives in the card click handler. */
  setAgentFilter: (agentId: string | null) => void;
  createSession: (label?: string, agentId?: string) => Promise<string | null>;
  deleteSession: (key: string) => Promise<void>;
  /** Generic patch — write per-agent / per-session config knobs via the
   *  bridge. Currently handles `serviceTier` (fast mode) by routing to
   *  `config.patch` (Hermes reads agent.service_tier at run time, no
   *  session-level granularity). Returns true on success. */
  patchSession: (
    key: string,
    params: { serviceTier?: string | null },
  ) => Promise<boolean>;
  /** Inject a synthetic system bubble into the active session's transcript.
   *  Used by local-execute slash commands (`/help`, `/version`, etc.) to
   *  show their result without round-tripping the agent. NOT persisted to
   *  Hermes session JSON — disappears on refresh. That's intentional; these
   *  are ephemeral "lookup" responses, not part of the conversation
   *  history. */
  appendSystemMessage: (sessionKey: string, markdown: string) => void;
  /** Run a local-execute slash command if `rawText` matches one of the
   *  registered handlers (`/help`, `/version`, `/model`, `/memory`,
   *  `/tools`, `/skills`, `/persona`, `/usage`). Returns `true` if the
   *  command was handled (composer should NOT proceed with normal send),
   *  `false` otherwise. */
  tryLocalCommand: (rawText: string) => Promise<boolean>;
  /** Rename a session (sets server-side `label` via sessions.patch). Passing
   *  `null` as the label clears the manual override so the server falls back
   *  to the derived title from first user message. Returns true on success,
   *  false if validation fails or RPC errors (original title restored). */
  renameSession: (
    key: string,
    label: string | null,
  ) => Promise<boolean>;
  /** Dispatch a user message on the active session. Returns true on successful
   *  RPC ACK (assistant stream still in flight), false on failure or no-op.
   *  Composer uses the return value to decide whether to keep its draft for
   *  retry vs. clear it. */
  sendMessage: (
    message: string,
    attachments?: AttachmentDraft[],
    /** Explicit target session key. When provided, the message is sent into
     *  THIS session regardless of `activeSessionKey` — used by the Command
     *  Center after binding a freshly-created agent session, so a re-render
     *  shifting `activeSessionKey` between create+send can't misroute the
     *  message to the previously-active (default) agent. */
    keyOverride?: string,
  ) => Promise<boolean>;
  /** Regenerate the last assistant turn — finds the most recent user text
   *  message in `messages[activeSession]`, strips the trailing assistant
   *  (and any tool-result/tool-use) entries after it, then re-invokes
   *  `sendMessage` with that text. Refuses if a stream is in flight or if
   *  the last user turn had attachments (File handles can't be reconstructed
   *  from the wire echo). Returns true on success.
   *  Used by the "Regenerate" chip on the last assistant bubble (audit H2). */
  retryLastUserMessage: (key?: string) => Promise<boolean>;
  /** Edit a user message in-place and re-submit. Only the most-recent user
   *  text message is editable (audit H1 — Hermes 0.14 has no message-level
   *  patch RPC, so we constrain to last-user to minimize the on-disk vs
   *  UI divergence on rehydration). Truncates the local transcript to
   *  before the message, then calls sendMessage with the new text. Returns
   *  true on success. */
  editAndResubmit: (
    messageId: string,
    newText: string,
    key?: string,
  ) => Promise<boolean>;
  /** Cancel any in-flight assistant stream on the given session (default:
   *  active). Best-effort — the gateway responds `{ aborted: boolean }` and
   *  also emits a trailing `chat` event with `state: "aborted"` which the
   *  event handler commits to the transcript. Safe to call when nothing is
   *  streaming; returns `false` from gateway without side effect. */
  abortActive: (key?: string) => Promise<void>;

  /** User clicked an approval button. Forwards via `approval.respond`
   *  RPC then optimistically mutates the matching ApprovalRequestBlock
   *  in-place so the bubble renders `✅ Disetujui {choice} oleh {user}`
   *  inline. Matches Telegram's button-press → message-edit pattern.
   *  Throws on RPC failure so callers can show a toast + retry. */
  resolveApproval: (
    requestId: string,
    choice: "once" | "session" | "always" | "deny",
    sessionKey?: string,
  ) => Promise<void>;

  /** User picked a clarify choice or typed an `Other` free-text answer.
   *  Forwards via `clarify.respond` RPC + optimistically mutates the
   *  block. Telegram parity: rendered as `❓ <question>\n\n[Chief]:
   *  <response>` after resolution. */
  resolveClarify: (
    requestId: string,
    response: string,
    sessionKey?: string,
  ) => Promise<void>;

  /** Slash command catalog from Hermes — `[name, description, category]`
   *  tuples. Loaded lazily on first slash detection in composer. Cached
   *  per session lifetime. Empty array initially. */
  commandsCatalog: Array<{ name: string; description: string; category?: string }>;
  commandsCatalogLoaded: boolean;
  /** Fire-and-forget catalog refresh. Idempotent — re-runs replace
   *  the cached list with the latest from Hermes. */
  loadCommandsCatalog: () => Promise<void>;

  /** Send a slash command (e.g. `/model gpt-4o-mini`, `/new`, `/reset`)
   *  to Hermes via `command.dispatch` RPC. Different from `sendMessage`:
   *  commands modify gateway/agent state (not generate a reply), so they
   *  don't appear in the transcript as a normal user bubble. Instead,
   *  the gateway's reply (if any) arrives as a status_update or a
   *  synthetic bot bubble.
   *  Returns true on success, false if the dispatch failed (caller
   *  shows error in composer). */
  dispatchCommand: (commandText: string, sessionKey?: string) => Promise<boolean>;

  /** Cached agents list (Hermes `agents.list` RPC) for @mention dropdown
   *  in composer + per-bubble persona display. Loaded lazily on first @
   *  detection. Empty array initially. Each entry carries identity
   *  (name, emoji, theme, avatar) for visual differentiation. */
  agentsCatalog: Array<{
    id: string;
    name: string;
    emoji?: string;
    theme?: string;
    avatar?: string;
    description?: string;
  }>;
  agentsCatalogLoaded: boolean;
  /** Refresh agents catalog. Fire-and-forget; idempotent. */
  loadAgentsCatalog: () => Promise<void>;

  /** Active reply-in-context target. Set when user clicks "Reply" on a
   *  bubble in the transcript. Composer renders a pinned quote chip
   *  above the textarea. On send, the message is prepended with a
   *  blockquote line so the agent sees the context. Cleared after
   *  send or via the chip's X button. Per-session. */
  replyTarget: Record<string, {
    messageId: string;
    role: "user" | "assistant" | "system";
    by: string;
    snippet: string;
  } | null>;
  setReplyTarget: (
    sessionKey: string,
    target: {
      messageId: string;
      role: "user" | "assistant" | "system";
      by: string;
      snippet: string;
    } | null,
  ) => void;

  /** Edit a persisted message's text content via bridge `messages.edit`
   *  RPC. Mutates session JSON on disk so the change survives refresh.
   *  Optimistic — local message swapped immediately. Returns false on
   *  failure (caller restores original text). */
  editMessageInPlace: (
    messageId: string,
    newText: string,
    sessionKey?: string,
  ) => Promise<boolean>;
  /** Soft-delete a message via bridge `messages.delete` RPC. Marks
   *  `deleted: true` in session JSON. UI renders strikethrough placeholder.
   *  Returns false on failure. */
  deleteMessageInPlace: (
    messageId: string,
    sessionKey?: string,
  ) => Promise<boolean>;

  /** Voice mode flag — when ON, /app auto-plays TTS for every bot
   *  reply. Toggle via /voice command or composer settings. */
  voiceMode: boolean;
  setVoiceMode: (on: boolean) => void;
  /** Global Cmd/Ctrl+K command palette open-state. Lifted here so both the
   *  keyboard shortcut AND the topbar trigger button can toggle it. */
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  /** Active /app/pengaturan category (tabbed Settings). The sub-sidebar rail
   *  sets it; PengaturanTab renders only the matching section. */
  settingsCategory: string;
  setSettingsCategory: (id: string) => void;
  /** Web chat verbosity: when false, MessageBlocks hides tool/thinking/status
   *  "work-in-progress" blocks (shows final answer + interactive blocks only).
   *  Client render pref persisted to localStorage. */
  showToolProgress: boolean;
  setShowToolProgress: (v: boolean) => void;
  /** Trigger TTS playback for a given text via bridge voice.tts.play
   *  RPC. Returns the displayUrl of the generated audio file, or null
   *  on failure. Caller plays the URL via <audio src> element. */
  playTTS: (text: string) => Promise<string | null>;

  /** Bot presence/mood — one of "online" | "thinking" | "typing" |
   *  "working" | "offline". Renders as colored pill in chat header.
   *  Auto-derived from session activity (streaming/sending/idle) +
   *  optional engine-side hints. */
  botPresence: "online" | "thinking" | "typing" | "working" | "offline";

  refreshSessions: () => Promise<void>;
  /** Folder CRUD + assignment actions (AgentBuff folders feature).
   *  All hit bridge `folders.*` RPCs and refresh local state on success. */
  refreshFolders: () => Promise<void>;
  createFolder: (input: {
    name: string;
    emoji?: string | null;
    color?: string | null;
    description?: string | null;
  }) => Promise<SessionFolder | null>;
  updateFolder: (
    id: string,
    patch: {
      name?: string;
      emoji?: string | null;
      color?: string | null;
      description?: string | null;
    },
  ) => Promise<SessionFolder | null>;
  deleteFolder: (id: string) => Promise<boolean>;
  assignSessionToFolder: (
    sessionKey: string,
    folderId: string | null,
  ) => Promise<boolean>;
  bulkAssignFolder: (
    sessionKeys: string[],
    folderId: string | null,
  ) => Promise<boolean>;
  /** Cross-session full-text search via bridge `sessions.search` RPC.
   *  Hermes Desktop parity (`searchSessions` in main/sessions.ts:224).
   *  Searches message BODY content across all session JSON files. Returns
   *  ranked results with snippet + HTML highlight ready for display.
   *
   *  Returns empty array on empty query, network failure, or no matches —
   *  caller treats empty list as "no results", not error. */
  searchSessionsContent: (query: string) => Promise<SessionSearchResult[]>;
  loadHistory: (key: string, opts?: { force?: boolean }) => Promise<void>;
  /** Pin `verboseLevel: "full"` + `reasoningLevel: "stream"` as per-session
   *  defaults via `sessions.patch`. Without these the gateway strips tool
   *  `data.result`/`data.partialResult` from live broadcasts (server-chat.ts
   *  :904–915) AND never emits `stream:"thinking"` events (pi-embedded-
   *  subscribe.ts:87), so tool-output cards render empty + pemikiran agen
   *  is missing realtime — full content only re-materializes on hard-refresh
   *  via `sessions.get` rehydration. Called fire-and-forget exactly once per
   *  canonical session key; repeats are cheap no-ops on the gateway side
   *  but tracked locally in `_patchedSessions` to keep the wire quiet. */
  _patchSessionDefaults: (key: string) => Promise<void>;
  /** Pull usage/model/cost from the persisted transcript into already-committed
   *  messages. Runs after `state="final"` because the live `chat` event only
   *  carries `{role, content, timestamp}` — usage fields only appear once the
   *  gateway persists the turn to its session SQLite and we re-read via
   *  `sessions.get`. Source: `Reff/openclaw/src/gateway/server-chat.ts:833–840`.
   *  Targeted merge (role-paired tail walk) — never replaces attachments,
   *  blocks, or scroll anchor. */
  backfillMeta: (key?: string) => Promise<void>;
  clearError: (key?: string) => void;
  setSidebarOpen: (open: boolean) => void;
  /** Write (or clear) a per-session draft. Empty string removes the entry
   *  entirely so localStorage stays tidy. Debounced flush to storage. */
  setDraft: (key: string, text: string) => void;
  /** Drop the draft for a given (default: active) session. Called on
   *  successful send so the composer doesn't re-populate on revisit. */
  clearDraft: (key?: string) => void;
  /** Dismiss the draft-persistence warning toast. */
  clearDraftPersistenceWarning: () => void;
  /** Set the in-thread search query (empty clears). */
  setChatSearchQuery: (query: string) => void;
  /** Pick which agent owns newly-created chat sessions (H4). */
  setDefaultAgentId: (agentId: string) => void;
};

function mapError(err: unknown): string {
  if (err instanceof GatewayError) {
    // R5 — Token refresh on auth expiry. When the gateway rejects with
    // UNAUTHORIZED, our NextAuth session has expired or the gateway token
    // rotated mid-flight. Schedule an auto-redirect to /login (preserving
    // the current path) so the user doesn't have to click through an error
    // banner. We still return the error string so the UI shows the message
    // briefly during the redirect window.
    if (err.code === "UNAUTHORIZED" && typeof window !== "undefined") {
      const next = encodeURIComponent(
        window.location.pathname + window.location.search,
      );
      // Use a small delay so React has a chance to flush the error banner
      // (gives the user visual context for why they're being redirected).
      window.setTimeout(() => {
        window.location.href = `/login?next=${next}`;
      }, 1500);
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useAppStore = create<AppState>((set, get) => ({
  status: "idle",
  needsBrain: false,
  engineSnapshot: null,

  activeSessionKey: DEFAULT_SESSION_KEY,
  sessions: [],
  activeAgentFilter: null,
  sessionsLoaded: false,
  sessionsError: null,

  folders: [],
  sessionFolders: {},
  foldersLoaded: false,

  liveSessionIds: [],
  liveAgentIds: [],

  messages: {},
  streaming: {},
  sending: {},
  loadingHistory: {},
  errors: {},
  drafts: {},
  draftPersistenceWarning: null,
  chatSearchQuery: "",
  chatSearchActiveIndex: -1,
  defaultAgentId: "main",
  turnTextOffset: {},
  commandsCatalog: [],
  commandsCatalogLoaded: false,
  agentsCatalog: [],
  agentsCatalogLoaded: false,
  replyTarget: {},
  voiceMode: false,
  commandPaletteOpen: false,
  settingsCategory: "ai",
  showToolProgress: true,
  botPresence: "online",

  sidebarOpen: false,

  _setStatus: (status) => set({ status }),
  setNeedsBrain: (needsBrain) => set({ needsBrain }),
  _setEngineSnapshot: (snap) => set({ engineSnapshot: snap }),

  _applyChatEvent: (payload) => {
    const rawKey = payload.sessionKey;
    if (!rawKey) return;
    const key = canonicalizeSessionKey(rawKey);
    const state = payload.state ?? "delta";
    // Normalize the wire content once — every branch below consumes both
    // `blocks` (for tool/thinking rendering) and `text` (for fast previews).
    const rawBlocks = normalizeContentBlocks(payload.message?.content);
    // Same tool-detection pipeline as rawToMessage (history path). In the
    // current store architecture tool events arrive on the parallel `agent`
    // stream and are committed as standalone kind:"tool" ChatMessages (see
    // applyToolAgentEvent above), so a `chat` event payload should almost
    // never carry tool blocks. The detection is kept as a safety net for
    // providers that echo tool activity into the chat stream — if it fires,
    // we treat the chat event like a tool event and skip streaming-bubble
    // mutation so the two channels can't double-render the same tool card.
    const markers = detectToolMarkers(payload.message);
    const nextBlocks = markers.isTool
      ? reshapeToolMessageBlocks(rawBlocks, markers)
      : rawBlocks;
    const rawText =
      blocksToText(nextBlocks) ||
      extractMessageText(payload.message?.content);
    // Usage + model surfaced on end-of-turn events. Delta frames may carry it
    // intermittently too (some providers flush usage mid-stream) — we keep
    // the most recent observation so the footer doesn't blank on final.
    // Suppress meta for tool-marked messages — meta belongs on true assistant
    // chat turns, a tool-only message should render just as a tool card.
    const wireMeta = markers.isTool ? null : extractMessageMeta(payload.message);

    // If the incoming frame is a mirrored tool event (rare — see note above),
    // route it through the tool pipeline and bail before we touch streaming.
    if (markers.isTool) {
      set((s) => {
        const list = s.messages[key] ?? [];
        // Prefer the gateway-supplied id for dedupe, else the marker's tool
        // call id, else a fresh id. Mirrored tool chat events don't carry a
        // stable toolCallId frame-by-frame, so we treat them as one-shot.
        // __agentbuff.id wins (bridge-stamped stable id), then legacy
        // __openclaw, then tool call id, then fresh UUID.
        const id =
          (payload.message as { __agentbuff?: { id?: string } } | undefined)
            ?.__agentbuff?.id ||
          payload.message?.__openclaw?.id ||
          markers.toolCallId ||
          newMessageId();
        const existingIdx = list.findIndex(
          (m) => m.kind === "tool" && m.id === id,
        );
        const toolMsg: ChatMessage = {
          id,
          role: "assistant",
          kind: "tool",
          content: "",
          hasToolActivity: true,
          blocks: nextBlocks,
          state: state === "delta" ? "delta" : "final",
          createdAt:
            existingIdx >= 0 ? list[existingIdx].createdAt : Date.now(),
        };
        const nextList = [...list];
        if (existingIdx >= 0) nextList[existingIdx] = toolMsg;
        else nextList.push(toolMsg);
        return {
          messages: { ...s.messages, [key]: nextList },
        };
      });
      return;
    }

    set((s) => {
      const current = s.streaming[key] ?? null;
      // Prefer the existing streaming msg id (for delta merging) → bridge
      // stable `__agentbuff.id` (on final, after rpc_router stamped it) →
      // legacy `__openclaw.id` → fresh UUID. The stable id takes over from
      // the temporary streaming UUID on the final frame, which means the
      // committed bubble in transcript carries the same id pin/delete/edit
      // RPCs will resolve to in session JSON.
      const wireMessage = payload.message as
        | { __agentbuff?: { id?: string }; __openclaw?: { id?: string } }
        | undefined;
      const stableId = wireMessage?.__agentbuff?.id;
      // On 'final', let stable id REPLACE the streaming UUID — that's what
      // gets persisted to disk so subsequent RPCs from /app reference the
      // anchor bridge can look up. On 'delta', keep streaming id stable.
      const msgId =
        (state === "final" && stableId)
          ? stableId
          : (current?.id ?? stableId ?? wireMessage?.__openclaw?.id ?? newMessageId());
      const offset = s.turnTextOffset[key] ?? 0;

      // Slice the cumulative wire text against `turnTextOffset[key]` so the
      // CURRENT streaming segment only shows text generated after the most
      // recent tool flush. On final/aborted/error this slice becomes the
      // authoritative commit payload for the trailing chat bubble of the
      // turn. See AppState.turnTextOffset comment for the full invariant.
      const slicedText =
        offset > 0 && rawText.length > offset
          ? rawText.slice(offset)
          : offset > 0 && rawText.length === offset
            ? ""
            : rawText;

      // Re-build the text blocks from the sliced view so the renderer never
      // sees pre-offset prose. Non-text blocks (thinking + future provider-
      // specific blocks) pass through unchanged — thinking is accrued on the
      // parallel agent stream and must survive the chat delta via
      // mergeStreamingBlocks.
      const slicedIncomingBlocks: ContentBlock[] = slicedText
        ? [{ type: "text", text: slicedText }]
        : [];
      const mergedBlocks =
        slicedIncomingBlocks.length > 0
          ? mergeStreamingBlocks(current?.blocks ?? [], slicedIncomingBlocks)
          : current?.blocks ?? [];
      const mergedText = slicedText || current?.content || "";
      const mergedMeta = wireMeta ?? current?.meta ?? null;

      const terminalReset =
        state === "final" || state === "aborted" || state === "error";
      const nextOffsetMap = terminalReset
        ? dropKey(s.turnTextOffset, key)
        : s.turnTextOffset;

      if (state === "error") {
        const committed: ChatMessage = {
          id: msgId,
          role: "assistant",
          kind: "chat",
          content: mergedText,
          hasToolActivity: false,
          blocks: mergedBlocks,
          meta: mergedMeta,
          state: "error",
          errorMessage: payload.errorMessage || "Permintaan gagal.",
          createdAt: current?.createdAt ?? Date.now(),
        };
        const list = s.messages[key] ?? [];
        // NOTE: intentionally do NOT populate errors[key] here — the committed
        // message carries the errorMessage already, so a second ErrorBubble
        // would double-render the same text. errors[key] is reserved for
        // send-side failures (chat.send rejected before streaming started,
        // e.g. ENERGY_EXHAUSTED).
        //
        // Schedule backfillMeta even on error: picks up the user-side
        // `userContext` (bootstrap / envelope / timestamp) that only lands on
        // the persisted transcript after the gateway finalizes the turn.
        setTimeout(() => {
          void get().backfillMeta(key);
        }, 150);
        return {
          messages: { ...s.messages, [key]: [...list, committed] },
          streaming: { ...s.streaming, [key]: null },
          sending: { ...s.sending, [key]: false },
          turnTextOffset: nextOffsetMap,
        };
      }

      if (state === "aborted") {
        const committed: ChatMessage = {
          id: msgId,
          role: "assistant",
          kind: "chat",
          content: mergedText,
          hasToolActivity: false,
          blocks: mergedBlocks,
          meta: mergedMeta,
          state: "aborted",
          createdAt: current?.createdAt ?? Date.now(),
        };
        const list = s.messages[key] ?? [];
        // Always schedule backfill so the preceding user bubble picks up its
        // `userContext` card even when the reply was aborted before completing.
        // No-op when the persisted transcript matches what we already have.
        setTimeout(() => {
          void get().backfillMeta(key);
        }, 150);
        // Only commit if we actually had something streaming OR new text
        // arrived on the aborted frame.
        if (!current && !slicedText) {
          return {
            streaming: { ...s.streaming, [key]: null },
            sending: { ...s.sending, [key]: false },
            turnTextOffset: nextOffsetMap,
          };
        }
        return {
          messages: { ...s.messages, [key]: [...list, committed] },
          streaming: { ...s.streaming, [key]: null },
          sending: { ...s.sending, [key]: false },
          turnTextOffset: nextOffsetMap,
        };
      }

      if (state === "final") {
        const hasRenderable =
          mergedText.length > 0 ||
          mergedBlocks.some((b) => b.type === "thinking") ||
          !!current;
        const list = s.messages[key] ?? [];
        if (!hasRenderable) {
          // Trailing final with literally nothing to commit (can happen when
          // the whole turn was tool activity + the post-tool slice is empty).
          // Don't push a ghost bubble; just clear streaming flags.
          return {
            streaming: { ...s.streaming, [key]: null },
            sending: { ...s.sending, [key]: false },
            errors: { ...s.errors, [key]: null },
            turnTextOffset: nextOffsetMap,
          };
        }
        // Bot-emitted media attachments (image_generate / text_to_speech /
        // video_generate / write_file output). Bridge extracts MEDIA:
        // tags from the agent's final text via Hermes'
        // `BasePlatformAdapter.extract_media`, registers each path with
        // its HTTP media server, and ships them in `payload.attachments`.
        // We map to AttachmentPart shape so the SAME MessageAttachments
        // renderer (and lightbox, AudioPlayer, DocumentCard) used for
        // user uploads renders bot output identically.
        const botAttachments = Array.isArray(payload.attachments)
          ? payload.attachments
              .filter(
                (a): a is NonNullable<typeof a> =>
                  !!a && typeof a === "object" && !!a.kind && !!a.displayUrl,
              )
              .map((a) => ({
                kind: a.kind,
                name: a.name || "attachment",
                displayUrl: a.displayUrl,
                sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : undefined,
                mimeType: a.mimeType || undefined,
              }))
          : undefined;
        const committed: ChatMessage = {
          id: msgId,
          role: "assistant",
          kind: "chat",
          content: mergedText,
          hasToolActivity: false,
          blocks: mergedBlocks,
          attachments: botAttachments && botAttachments.length > 0
            ? (botAttachments as ChatMessage["attachments"])
            : undefined,
          meta: mergedMeta,
          state: "final",
          createdAt: current?.createdAt ?? Date.now(),
        };
        // Schedule `backfillMeta` unconditionally — two channels need it:
        //   · assistant meta (tokens / model / cost) — the live `final` chat
        //     event only ships `{role, content, timestamp}`, so meta is
        //     ALWAYS missing unless a provider leaked it mid-stream (rare).
        //   · user `userContext` — the gateway wraps the user's typed text in
        //     bootstrap prelude + channel envelope + timestamp only on the
        //     PERSISTED side, so the optimistic local echo always starts
        //     without the context card on a bootstrap turn.
        // 150 ms delay lets the gateway persist the turn before we re-read
        // via `sessions.get`. Fire-and-forget; action is idempotent.
        setTimeout(() => {
          void get().backfillMeta(key);
        }, 150);
        // Bug-B (2026-06-09): re-pull sessions.list once the async title has
        // landed so the sidebar stops showing "Sesi utama" without a manual
        // refresh. Coalesced (one trailing refresh per burst). 4s < the bridge
        // 12s deleted-sid tombstone (delete-safe), and refreshSessions'
        // active-preserve guard can't bounce us off the now-populated active
        // session or a seeded draft — so no "sesi loncat ke command center".
        if (titleRefreshTimer) clearTimeout(titleRefreshTimer);
        titleRefreshTimer = setTimeout(() => {
          titleRefreshTimer = null;
          void get().refreshSessions();
        }, 4000);
        return {
          messages: { ...s.messages, [key]: [...list, committed] },
          streaming: { ...s.streaming, [key]: null },
          sending: { ...s.sending, [key]: false },
          errors: { ...s.errors, [key]: null },
          turnTextOffset: nextOffsetMap,
        };
      }

      // delta — assistant is streaming a partial text response. Wire gotcha
      // G5: payload carries FULL merged text-so-far, not a chunk. We slice
      // it against turnTextOffset so the bubble only shows post-last-tool
      // text. Thinking blocks accrued via the parallel `agent` stream live
      // in `current.blocks` and are preserved by `mergeStreamingBlocks`.
      const next: ChatMessage = {
        id: msgId,
        role: "assistant",
        kind: "chat",
        content: slicedText,
        hasToolActivity: false,
        blocks: mergedBlocks,
        meta: mergedMeta,
        state: "delta",
        createdAt: current?.createdAt ?? Date.now(),
      };
      return {
        streaming: { ...s.streaming, [key]: next },
        sending: { ...s.sending, [key]: false },
      };
    });
  },

  _applyAgentEvent: (payload) => {
    if (!payload) return;
    const rawKey = payload.sessionKey;
    if (!rawKey) return;
    const key = canonicalizeSessionKey(rawKey);
    const stream = payload.stream;
    const data = (payload.data ?? {}) as Record<string, unknown>;

    if (stream === "tool") {
      applyToolAgentEvent(set, key, data);
      return;
    }
    if (stream === "thinking") {
      applyThinkingAgentEvent(set, key, data);
      return;
    }
    if (stream === "subagent") {
      applySubagentAgentEvent(set, key, data);
      return;
    }
    if (stream === "status") {
      applyStatusAgentEvent(set, key, data);
      return;
    }
    if (stream === "approval" || stream === "clarify") {
      applyInteractiveAgentEvent(set, key, stream, data);
      return;
    }
    if (stream === "browser") {
      applyBrowserAgentEvent(set, key, data);
      return;
    }
    // Wave 6-3G/3H/3L: rich-block emission (poll/dice/location/contact/
    // sticker/embed/select/modal). Append the typed block to the active
    // assistant message's blocks array so MessageBlocks renders it via
    // the new rich-block card components.
    if (stream === "rich_block") {
      const kind = (data?.kind as string) || "";
      const block = (data?.block as Record<string, unknown>) ?? null;
      if (!kind || !block) return;
      // Ensure block has `type` matching `kind` for renderer dispatch.
      const typedBlock = {
        type: kind,
        ...block,
      } as unknown as ContentBlock;
      set((s) => {
        const list = s.messages[key] ?? [];
        // Attach to the LAST assistant message, or create a fresh one
        // if there isn't an active assistant turn (poll/dice can fire
        // outside a turn, e.g. agent-initiated broadcasts).
        const lastIdx = (() => {
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (m.role === "assistant" && m.kind !== "tool") return i;
          }
          return -1;
        })();
        if (lastIdx >= 0) {
          const target = list[lastIdx];
          const nextBlocks = [...(target.blocks ?? []), typedBlock];
          const nextList = [...list];
          nextList[lastIdx] = { ...target, blocks: nextBlocks };
          return { messages: { ...s.messages, [key]: nextList } };
        }
        // No assistant message yet — create a synthetic one so the
        // block has somewhere to live.
        const synth: ChatMessage = {
          id: newMessageId(),
          role: "assistant",
          kind: "chat",
          content: "",
          hasToolActivity: false,
          blocks: [typedBlock],
          state: "final",
          createdAt: Date.now(),
        };
        return { messages: { ...s.messages, [key]: [...list, synth] } };
      });
      return;
    }
    // Other streams currently no-op (assistant text arrives via `chat` event).
  },

  _applySessionsActivity: (workingSids, workingAgentIds) =>
    set((s) => {
      const nextSids = Array.isArray(workingSids) ? workingSids : [];
      const nextAgents = Array.isArray(workingAgentIds) ? workingAgentIds : [];
      // Reference-stable no-op when BOTH are unchanged (avoid re-renders).
      const sidsSame =
        nextSids.length === s.liveSessionIds.length &&
        nextSids.every((id, i) => id === s.liveSessionIds[i]);
      const agentsSame =
        nextAgents.length === s.liveAgentIds.length &&
        nextAgents.every((id, i) => id === s.liveAgentIds[i]);
      if (sidsSame && agentsSame) return s;
      const patch: { liveSessionIds?: string[]; liveAgentIds?: string[] } = {};
      if (!sidsSame) patch.liveSessionIds = nextSids;
      if (!agentsSame) patch.liveAgentIds = nextAgents;
      return patch;
    }),

  setAgentFilter: (agentId) =>
    set((s) =>
      s.activeAgentFilter === agentId ? s : { activeAgentFilter: agentId },
    ),

  _applySessionsList: (result) =>
    set((s) => {
      const filtered = result.sessions.filter((row) =>
        isDashboardSessionKey(row.key),
      );
      const defaultCtx = result.defaults?.contextTokens ?? null;
      // Dedupe by canonical key. The bridge can return >1 DB row that
      // canonicalizes to the same session key (session + its resume alias,
      // or repeated per-prompt rows under `agent:main:*`). Two summaries with
      // the same `key` crash React's list reconciler ("two children with the
      // same key"). Keep the freshest row per key.
      const byKey = new Map<string, SessionSummary>();
      for (const row of filtered) {
        const summary = rowToSummary(row, defaultCtx);
        const prev = byKey.get(summary.key);
        if (!prev || (summary.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
          byKey.set(summary.key, summary);
        }
      }
      const remote = [...byKey.values()];
      // Preserve OPTIMISTIC sessions (just-created via `Thread baru` that
      // haven't been flushed to the engine's DB yet — Hermes only writes a
      // session row after its first message). Without this, refreshSessions
      // fires right after `createSession` and the new entry vanishes from
      // the sidebar, with `activeSessionKey` getting silently rebound to
      // the freshest remote row (jarring UX — "I clicked Thread Baru but
      // the chat tab still shows the old session"). We keep optimistic
      // rows that have an `updatedAt` newer than every remote row, since
      // those represent client-side creations awaiting persistence.
      const newestRemoteAt = remote.reduce(
        (max, r) => Math.max(max, r.updatedAt ?? 0),
        0,
      );
      const remoteKeys = new Set(remote.map((r) => r.key));
      // 2026-06-09: ALSO preserve the ACTIVE session whenever it holds a live
      // conversation (messages in the store), even if it's older than the
      // newest remote row. A just-created agent thread ("agent:<id>:...") can
      // end up with a client-side optimistic key that the engine persists under
      // a different id; after the first reply, refreshSessions wouldn't find the
      // optimistic key in `remote`, so the thread got dropped from the sidebar
      // ("sesi tiba-tiba hilang") AND activeSessionKey got rebound to another
      // session whose messages aren't loaded -> the chat snapped back to the
      // empty Command Center. Keeping the active+populated thread fixes both.
      const activeKey = s.activeSessionKey;
      const activeHasMessages = (s.messages[activeKey]?.length ?? 0) > 0;
      const optimistic = s.sessions.filter(
        (row) =>
          !remoteKeys.has(row.key) &&
          ((row.updatedAt ?? 0) >= newestRemoteAt ||
            (row.key === activeKey && activeHasMessages)),
      );
      const summaries = [...optimistic, ...remote].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      );
      // If the current active key vanished (deleted elsewhere AND not in our
      // optimistic-preserved set), fall back to the freshest remaining
      // session — or DEFAULT if none. Never rebind away from an active thread
      // that still has a live conversation on screen.
      //
      // 2026-06-09 (lazy Thread baru): a fresh DRAFT placeholder (Command Center,
      // not yet sent) has a SEEDED-but-empty messages entry and isn't in
      // summaries — it would match the rebind condition below and a background
      // refreshSessions (reconnect / poll) would bounce the user off the
      // Command Center onto an existing session. Distinguish a draft (key
      // PRESENT in messages, even if empty) from a truly stale/vanished key (no
      // messages entry at all, e.g. a stale persisted key on bootstrap) and keep
      // the draft. Opening an existing session also seeds messages[key] then
      // loadHistory fills it, so this never wrongly pins a real session.
      const activeIsSeededDraft = s.activeSessionKey in s.messages;
      let activeSessionKey = s.activeSessionKey;
      if (
        summaries.length > 0 &&
        !activeHasMessages &&
        !activeIsSeededDraft &&
        !summaries.some((row) => row.key === activeSessionKey)
      ) {
        activeSessionKey = summaries[0].key;
        persistActiveKey(activeSessionKey);
      }
      return {
        sessions: summaries,
        sessionsLoaded: true,
        sessionsError: null,
        activeSessionKey,
      };
    }),

  _setSessionsError: (msg) => set({ sessionsError: msg }),

  _setHistoryLoading: (key, loading) =>
    set((s) => ({
      loadingHistory: { ...s.loadingHistory, [key]: loading },
    })),

  _replaceHistory: (key, messages) =>
    set((s) => ({
      messages: { ...s.messages, [key]: messages },
    })),

  _handleConnectionDrop: () =>
    // On WS close: commit any in-flight streaming assistant replies as
    // "aborted" (so the user sees partial content, not an invisible stuck
    // spinner) and clear ALL per-session sending flags. `turnTextOffset` is
    // wiped too — any reconnect starts fresh turns, and a stale offset would
    // wrongly slice the first delta of the next turn.
    set((s) => {
      const nextMessages = { ...s.messages };
      for (const [key, streaming] of Object.entries(s.streaming)) {
        if (!streaming) continue;
        const committed: ChatMessage = {
          ...streaming,
          state: "aborted",
        };
        nextMessages[key] = [...(nextMessages[key] ?? []), committed];
      }
      return {
        messages: nextMessages,
        streaming: {},
        sending: {},
        turnTextOffset: {},
      };
    }),

  setActiveSession: async (key) => {
    const canonical = canonicalizeSessionKey(key);
    if (get().activeSessionKey === canonical) return;
    set({ activeSessionKey: canonical, sidebarOpen: false });
    persistActiveKey(canonical);
    await get().loadHistory(canonical);
  },

  createSession: async (label, agentIdArg) => {
    // LAZY new thread (2026-06-09). Clicking "Thread baru" / picking an agent no
    // longer eagerly mints an engine session — that spawned a junk empty session
    // on every click (the user saw a pile of unused "Thread baru" rows that
    // wouldn't even delete). Instead we open a DRAFT placeholder key: pure local
    // state, NO RPC, NO sidebar row. chat-shell renders the Command Center
    // because the key has zero messages. The REAL session is created only on the
    // FIRST send, via chat.send's TIER-3 auto-create bound to this key's agent
    // prefix; sendMessage's echoed-key adoption then pivots onto the real
    // canonical key and pins verbose/reasoning defaults at that point. All
    // createSession callers (Thread baru, Ctrl+K, /new, agent picker, command
    // center, 3D office) inherit this lazy behavior unchanged (same signature,
    // same string-key return).
    //
    // agentId binds the draft to the chosen agent purely via the key prefix
    // (chat.send resolves the agent from decanonicalize_session_key). No-arg
    // callers get "main" (default); we never leak a persisted "last picked" id.
    const agentId = (agentIdArg && agentIdArg.trim()) || "main";
    const seed =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `draft-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    const placeholder = canonicalizeSessionKey(seed, agentId);
    set((s) => ({
      activeSessionKey: placeholder,
      // Seed an empty transcript so the Command Center (zero-message) view shows
      // and the first send has a target. Deliberately NO sessions[] row — the
      // real row lands in the sidebar after the first send + refreshSessions.
      messages: { ...s.messages, [placeholder]: [] },
      errors: { ...s.errors, [placeholder]: null },
      sidebarOpen: false,
    }));
    persistActiveKey(placeholder);
    return placeholder;
  },

  deleteSession: async (key) => {
    const client = clientInstance;
    if (!client) return;
    const canonical = canonicalizeSessionKey(key);
    // Optimistic remove — reconcile on refresh.
    const prev = get();
    // R4 — Blob URL cleanup. Revoke any blob: attachment URLs in the
    // session's transcript so they don't leak memory. Skip data: URLs
    // (rehydrated from base64; nothing to revoke). The attachment echoes
    // for ACTIVE in-flight composer drafts are revoked by the composer's
    // own unmount cleanup, not here.
    const droppedMessages = prev.messages[canonical] ?? [];
    for (const m of droppedMessages) {
      if (!m.attachments) continue;
      for (const att of m.attachments) {
        if (att.displayUrl && att.displayUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(att.displayUrl);
          } catch {
            /* idempotent revoke — already torn down */
          }
        }
      }
    }
    set((s) => {
      const { [canonical]: _dropMsgs, ...restMsgs } = s.messages;
      const { [canonical]: _dropStream, ...restStream } = s.streaming;
      const { [canonical]: _dropSend, ...restSend } = s.sending;
      const { [canonical]: _dropErr, ...restErr } = s.errors;
      const { [canonical]: _dropDraft, ...restDrafts } = s.drafts;
      const restOffset = dropKey(s.turnTextOffset, canonical);
      const nextSessions = s.sessions.filter((row) => row.key !== canonical);
      let activeSessionKey = s.activeSessionKey;
      if (activeSessionKey === canonical) {
        activeSessionKey = nextSessions[0]?.key ?? DEFAULT_SESSION_KEY;
        persistActiveKey(activeSessionKey);
      }
      void _dropMsgs;
      void _dropStream;
      void _dropSend;
      void _dropErr;
      void _dropDraft;
      // Persist trimmed drafts since we dropped one.
      scheduleDraftFlush(restDrafts);
      return {
        sessions: nextSessions,
        activeSessionKey,
        messages: restMsgs,
        streaming: restStream,
        sending: restSend,
        errors: restErr,
        drafts: restDrafts,
        turnTextOffset: restOffset,
      };
    });
    try {
      await client.request("sessions.delete", { key: canonical });
      void get().refreshSessions();
    } catch (err) {
      // Roll back optimistic removal on failure.
      set({
        sessions: prev.sessions,
        activeSessionKey: prev.activeSessionKey,
        messages: prev.messages,
        streaming: prev.streaming,
        sending: prev.sending,
        turnTextOffset: prev.turnTextOffset,
        errors: {
          ...prev.errors,
          [prev.activeSessionKey]: mapError(err),
        },
      });
    }
  },

  renameSession: async (key, label) => {
    const client = clientInstance;
    if (!client) return false;
    const canonical = canonicalizeSessionKey(key);

    // Normalize: trim, clip to server cap. Empty-after-trim = clear (send null).
    let nextLabel: string | null;
    if (label === null) {
      nextLabel = null;
    } else {
      const trimmed = label.trim();
      if (trimmed.length === 0) {
        nextLabel = null;
      } else {
        nextLabel = trimmed.slice(0, SESSION_LABEL_MAX_LENGTH);
      }
    }

    // Optimistic title update so the sidebar swaps instantly.
    const prevSessions = get().sessions;
    const prevRow = prevSessions.find((r) => r.key === canonical);
    if (prevRow) {
      const optimisticTitle = nextLabel ?? prevRow.title;
      set((s) => ({
        sessions: s.sessions.map((row) =>
          row.key === canonical
            ? { ...row, title: optimisticTitle }
            : row,
        ),
      }));
    }

    try {
      const params: SessionsPatchParams = { key: canonical, label: nextLabel };
      await client.request<SessionsPatchResult>("sessions.patch", params);
      // Re-pull so the row reflects server state (derivedTitle may re-surface
      // when label is cleared, etc).
      void get().refreshSessions();
      return true;
    } catch (err) {
      // Roll back optimistic rename.
      set((s) => ({
        sessions: prevRow
          ? s.sessions.map((row) =>
              row.key === canonical ? { ...row, title: prevRow.title } : row,
            )
          : s.sessions,
        errors: {
          ...s.errors,
          [canonical]: mapError(err),
        },
      }));
      return false;
    }
  },

  // Generic session-level patch — wraps the bridge's `sessions.patch` RPC
  // (and falls through to `config.patch` for agent-wide knobs like
  // `service_tier` that Hermes doesn't expose at session granularity).
  // Used by the Fast Mode toggle in the chat header.
  //
  // `params` shape:
  //   - `serviceTier: "fast" | "" | null` — write to `config.yaml::agent.service_tier`.
  //     Hermes picks this up on the NEXT chat.send (it's read at run time
  //     by `_resolve_runtime_agent_kwargs()` in the api_server). Pass ""
  //     to clear / fall back to standard tier.
  patchSession: async (_key: string, params: { serviceTier?: string | null }) => {
    const client = clientInstance;
    if (!client) return false;
    try {
      // service_tier lives on the agent config, not the session — patch
      // via config.patch (RFC 7396 merge-patch).
      if ("serviceTier" in params) {
        await client.request("config.patch", {
          agent: { service_tier: params.serviceTier ?? "" },
        });
      }
      return true;
    } catch {
      return false;
    }
  },

  appendSystemMessage: (sessionKey: string, markdown: string) => {
    // Rendered as an assistant bubble (system role is filtered out by
    // groupTurns to suppress gateway chatter). Visually identical to a
    // real agent reply; user knows it's local because they just typed
    // a `/command` and got an instant table back without streaming.
    const canonical = canonicalizeSessionKey(sessionKey);
    set((s) => {
      const list = s.messages[canonical] ?? [];
      const systemMsg: ChatMessage = {
        id: newMessageId(),
        role: "assistant",
        kind: "chat",
        content: markdown,
        blocks: [{ type: "text", text: markdown }],
        state: "final",
        createdAt: Date.now(),
      };
      return {
        messages: { ...s.messages, [canonical]: [...list, systemMsg] },
      };
    });
  },

  tryLocalCommand: async (rawText: string) => {
    const client = clientInstance;
    if (!client) return false;
    const { dispatchLocalCommand } = await import("./local-commands");
    const actions = get();
    const result = await dispatchLocalCommand(rawText, {
      client,
      sessionKey: actions.activeSessionKey,
      actions: {
        createSession: () => actions.createSession(),
        deleteSession: (k) => actions.deleteSession(k),
        setActiveSession: (k) => actions.setActiveSession(k),
        setFastMode: (on) =>
          actions.patchSession(actions.activeSessionKey, {
            serviceTier: on ? "fast" : "",
          }),
        getLastUsage: () => {
          const list = get().messages[get().activeSessionKey];
          if (!list) return null;
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (m.role === "assistant" && m.kind !== "tool" && m.meta) {
              return {
                input: m.meta.input ?? 0,
                output: m.meta.output ?? 0,
                cost: m.meta.cost ?? 0,
                model: m.meta.model ?? null,
              };
            }
          }
          return null;
        },
        getFastMode: () => {
          if (typeof window === "undefined") return false;
          try {
            return (
              window.localStorage.getItem("agentbuff:app:fast-mode") === "1"
            );
          } catch {
            return false;
          }
        },
      },
    });
    if (!result) return false;
    // Capture sessionKey BEFORE sideEffect runs — /new + /clear mutate
    // activeSessionKey, but we want the user echo to land in the
    // CURRENT (pre-sideEffect) session so chief sees "/new" in the
    // session they were in, not in the brand-new empty one.
    const echoSessionKey = get().activeSessionKey;

    // Run side effect (e.g. create new session, toggle fast mode)
    // BEFORE appending the response — that way state mutations land
    // before the response renders.
    if (result.sideEffect) {
      try {
        await Promise.resolve(result.sideEffect());
      } catch (err) {
        // Surface side-effect failure inline.
        const errMsg = err instanceof Error ? err.message : String(err);
        set((s) => {
          const list = s.messages[echoSessionKey] ?? [];
          return {
            messages: {
              ...s.messages,
              [echoSessionKey]: [
                ...list,
                {
                  id: newMessageId(),
                  role: "user",
                  kind: "chat",
                  content: rawText.trim(),
                  blocks: [{ type: "text", text: rawText.trim() }],
                  state: "final",
                  createdAt: Date.now(),
                },
                {
                  id: newMessageId(),
                  role: "assistant",
                  kind: "chat",
                  content: `**${rawText.trim()}** gagal: ${errMsg}`,
                  blocks: [
                    {
                      type: "text",
                      text: `**${rawText.trim()}** gagal: ${errMsg}`,
                    },
                  ],
                  state: "final",
                  createdAt: Date.now() + 1,
                },
              ],
            },
          };
        });
        return true;
      }
    }

    // For commands with empty content (e.g. /new, /clear that just want
    // to reset state silently), skip appending entirely.
    if (!result.content) return true;

    // Append user echo + response. Target session is whichever is active
    // AFTER the sideEffect (e.g. /new switches to the fresh session, and
    // the /new response shouldn't appear in the OLD session).
    const respSessionKey = get().activeSessionKey;
    set((s) => {
      const list = s.messages[respSessionKey] ?? [];
      const userEcho: ChatMessage = {
        id: newMessageId(),
        role: "user",
        kind: "chat",
        content: rawText.trim(),
        blocks: [{ type: "text", text: rawText.trim() }],
        state: "final",
        createdAt: Date.now(),
      };
      const sysMsg: ChatMessage = {
        id: newMessageId(),
        role: "assistant",
        kind: "chat",
        content: result.content,
        blocks: [{ type: "text", text: result.content }],
        state: "final",
        createdAt: Date.now() + 1,
      };
      return {
        messages: {
          ...s.messages,
          [respSessionKey]: [...list, userEcho, sysMsg],
        },
      };
    });
    return true;
  },

  _patchSessionDefaults: async (key) => {
    const client = clientInstance;
    if (!client) return;
    const canonical = canonicalizeSessionKey(key);
    // Already confirmed patched this connect — cheap no-op.
    if (patchedSessionDefaults.has(canonical)) return;
    // Another caller started the RPC — join their promise so we don't fire a
    // duplicate AND so our `await` genuinely blocks until the patch lands on
    // the gateway side. Critical for `sendMessage`: without this the second
    // caller would fall through to chat.send while the first caller's RPC
    // is still in flight, leaving the gateway in "stripped" mode for the
    // first assistant turn (no thinking, tool args redacted).
    const existing = inFlightPatchPromises.get(canonical);
    if (existing) return existing;
    const promise = (async () => {
      try {
        // Triad of session flags that must land BEFORE the first chat.send
        // or the first assistant turn streams in degraded mode:
        //   · verboseLevel:"full"    — unstrips tool result/partialResult
        //   · reasoningLevel:"stream" — routes thinking deltas to clients
        //   · thinkingLevel:"low"    — actually enables model thinking
        //     (Gemini 2.5 Flash defaults to thinkingBudget=0 = no thoughts
        //     emitted; see rpc-types.ts SessionsPatchParams comment). "low"
        //     is the lightest positive budget — matches OpenClaw's own
        //     `resolveThinkingDefaultForModel` fallback for reasoning-capable
        //     models (thinking.shared.ts:110-113).
        const params: SessionsPatchParams = {
          key: canonical,
          verboseLevel: "full",
          reasoningLevel: "stream",
          thinkingLevel: "low",
        };
        await client.request<SessionsPatchResult>("sessions.patch", params);
        // Only record success AFTER the gateway ACKed — so that a failure
        // (network blip, gateway restart mid-patch) leaves the next call free
        // to retry rather than silently skipping.
        patchedSessionDefaults.add(canonical);
      } catch {
        // Silent: realtime-render enhancement, not a correctness gate.
        // Hard-refresh transcript rehydration always shows full content
        // anyway, so a failed patch degrades to Phase 3 behavior, not a
        // broken chat. `patchedSessionDefaults` stays unpopulated so the
        // next trigger (next send / session switch) will retry.
      } finally {
        inFlightPatchPromises.delete(canonical);
      }
    })();
    inFlightPatchPromises.set(canonical, promise);
    return promise;
  },

  sendMessage: async (message, attachments, keyOverride) => {
    const client = clientInstance;
    if (!client) return false;
    const trimmed = message.trim();
    const hasAttachments = !!attachments && attachments.length > 0;
    // Gate: must have text OR attachments. Gateway accepts empty message when
    // attachments are present — it appends a "[media attached]" marker per
    // attachment to the empty message text.
    if (!trimmed && !hasAttachments) return false;
    if (get().status !== "ready") return false;
    // keyOverride pins the target session (Command Center agent-bound send).
    // Without it we'd read activeSessionKey, which a re-render could shift
    // between createSession and sendMessage → message routed to the wrong
    // agent (chief's "pilih kiwi, dijawab Buff" bug, 2026-05-30).
    const key = keyOverride
      ? canonicalizeSessionKey(keyOverride)
      : get().activeSessionKey;

    // C1 — Concurrent send race guard.
    // Claim the per-session sending slot BEFORE any await. The composer also
    // gates on `busy` (sending || streaming) but its derived state lags a
    // tick behind a synchronous double-fire — e.g. Send button + Enter
    // pressed in the same frame, or any programmatic caller (slash command,
    // retry helper) racing the UI. Without this guard the window between
    // entry and the optimistic-echo `set()` below (which spans `_patchSessionDefaults`
    // + `draftsToWireAttachments` awaits) lets a second `chat.send` slip
    // through, producing duplicate user bubbles + orphaned streaming state.
    if (get().sending[key]) return false;
    set((s) => ({ sending: { ...s.sending, [key]: true } }));

    // Belt-and-suspenders: guarantee the gateway has our per-session verbose/
    // reasoning overrides BEFORE chat.send fires. Without this the very first
    // message on a session whose create+load both somehow missed the patch
    // would stream stripped tool output (Phase 3 degradation). Idempotent —
    // `patchedSessionDefaults` Set makes the 2nd+ call a no-op, so this only
    // costs a round-trip on the first send of each session per connect.
    await get()._patchSessionDefaults(key);

    // Encode attachments to base64 BEFORE optimistic append — we want to fail
    // fast without a ghost user bubble if a file read blows up. This is a
    // cheap Promise.all on the main thread; for our 5×5MB cap the worst case
    // is a few hundred ms of JS work which is acceptable.
    let wireAttachments;
    try {
      wireAttachments = hasAttachments
        ? await draftsToWireAttachments(attachments!)
        : undefined;
    } catch (err) {
      set((s) => ({
        sending: { ...s.sending, [key]: false },
        errors: { ...s.errors, [key]: mapError(err) },
      }));
      return false;
    }

    // Optimistic echo of the user's attachment parts — we keep the blob URL
    // alive for the tab's lifetime so the thumbnail survives even after the
    // composer drops its draft reference.
    const echoedAttachments: AttachmentPart[] | undefined = hasAttachments
      ? attachments!.map(draftToPart)
      : undefined;

    const userMessage: ChatMessage = {
      id: newMessageId(),
      role: "user",
      content: trimmed,
      blocks: trimmed ? [{ type: "text", text: trimmed }] : [],
      attachments: echoedAttachments,
      state: "final",
      createdAt: Date.now(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [key]: [...(s.messages[key] ?? []), userMessage],
      },
      sending: { ...s.sending, [key]: true },
      errors: { ...s.errors, [key]: null },
    }));

    try {
      // Device timezone (IANA) so the agent gets the USER's local time, not the
      // container's. Web is special: the browser runs on the user's device and
      // knows its zone. The bridge formats the (accurate, NTP) server clock in
      // THIS zone → correct local time without trusting a possibly-wrong device
      // clock. Falls back to the container timezone if unavailable.
      let clientTz: string | undefined;
      try {
        clientTz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
      } catch {
        clientTz = undefined;
      }
      const ack = await client.request<{ sessionKey?: string }>("chat.send", {
        sessionKey: key,
        message: trimmed,
        idempotencyKey: crypto.randomUUID(),
        ...(clientTz ? { clientTz } : {}),
        ...(wireAttachments ? { attachments: wireAttachments } : {}),
      });
      // `res` is an ACK (wire gotcha G2). Deltas and the final message arrive
      // as `chat` events handled by _applyChatEvent.
      //
      // Hermes bridge upgrade: when the requested sessionKey didn't exist
      // (e.g. fresh container with no sessions yet), the bridge
      // auto-created a session and echoes the REAL canonical key here.
      // Pivot the in-memory + persisted activeSessionKey to it so the
      // next send reuses the same Hermes session instead of triggering
      // another auto-create (and the streaming events that route via
      // the new canonical key land in the right transcript).
      const echoedKey = ack?.sessionKey;
      if (
        typeof echoedKey === "string" &&
        echoedKey.length > 0 &&
        echoedKey !== key
      ) {
        const canonical = canonicalizeSessionKey(echoedKey);
        set((s) => {
          // Migrate per-session state from old key → new canonical key.
          // Race-aware: streaming events from Hermes arrive keyed by the
          // REAL session id, often BEFORE the chat.send ACK echoes that
          // id back to us. So both old (user bubble + sending flag) and
          // new (partial assistant bubble + streaming text) entries can
          // already exist — we must MERGE, not REPLACE, or we lose
          // either the user bubble (rare) or the streaming content
          // (common, with sub-100ms gateway latency).
          const mergeMessages = (
            m: Record<string, ChatMessage[]>,
          ): Record<string, ChatMessage[]> => {
            const oldList = m[key];
            const newList = m[canonical];
            if (!oldList && !newList) return m;
            const { [key]: _drop, ...rest } = m;
            // Preserve chronological order: user message landed first
            // (synchronous append before await), assistant streaming
            // events arrive after.
            const merged = [...(oldList ?? []), ...(newList ?? [])];
            return { ...rest, [canonical]: merged };
          };
          const pickNewOrOld = <T,>(
            m: Record<string, T>,
          ): Record<string, T> => {
            const hasOld = key in m;
            const hasNew = canonical in m;
            if (!hasOld && !hasNew) return m;
            const { [key]: oldVal, ...rest } = m;
            // If new already has a value (streaming text was committed
            // before ACK arrived) prefer that; else fall back to old
            // (sending flag, optimistic bubble's draft, ...).
            return {
              ...rest,
              [canonical]: hasNew ? m[canonical] : (oldVal as T),
            };
          };
          // BUG-A FIX 2026-05-23: also mirror the pivot into `s.sessions`
          // as an OPTIMISTIC row. Otherwise the fire-and-forget
          // `refreshSessions()` below races against Hermes' session
          // persistence: `sessions.list` returns BEFORE the new session
          // is on disk, `_applySessionsList` (line 1638-1643) doesn't
          // find `canonical` in either the optimistic OR remote list,
          // and "resets" activeSessionKey to summaries[0].key — sending
          // the UI back to a different session / the welcome screen.
          // Adding `canonical` to `s.sessions` here ensures the
          // optimistic-preservation logic in `_applySessionsList` keeps
          // our just-pivoted active row until Hermes persists it.
          const existingRow = s.sessions.find((row) => row.key === key);
          const pivotedRow: SessionSummary = existingRow
            ? { ...existingRow, key: canonical, updatedAt: Date.now() }
            : {
                key: canonical,
                title: "Thread baru",
                updatedAt: Date.now(),
                kind: "direct",
              };
          const otherSessions = s.sessions.filter(
            (row) => row.key !== key && row.key !== canonical,
          );
          const nextSessions = [pivotedRow, ...otherSessions].sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
          );
          return {
            messages: mergeMessages(s.messages),
            streaming: pickNewOrOld(s.streaming),
            sending: pickNewOrOld(s.sending),
            errors: pickNewOrOld(s.errors),
            loadingHistory: pickNewOrOld(s.loadingHistory),
            activeSessionKey:
              s.activeSessionKey === key ? canonical : s.activeSessionKey,
            sessions: nextSessions,
          };
        });
        if (get().activeSessionKey === canonical) {
          persistActiveKey(canonical);
        }
        // Refresh sidebar so the new Hermes session appears in the list.
        void get().refreshSessions();
        // Lazy-thread move (2026-06-09): createSession no longer pins
        // verbose/reasoning up-front (it has no engine session yet). This pivot
        // only fires on the FIRST send of a fresh draft (placeholder key !=
        // echoed real key), so pinning defaults HERE — once the real session
        // exists — keeps the prior "first run streams tool output + thinking
        // realtime" behavior. Subsequent sends reuse the real key (echoedKey ===
        // key) and skip this block, so it runs exactly once per new session.
        void get()._patchSessionDefaults(canonical);
      }
      return true;
    } catch (err) {
      const msg = mapError(err);
      set((s) => ({
        sending: { ...s.sending, [key]: false },
        errors: { ...s.errors, [key]: msg },
      }));
      return false;
    }
  },

  retryLastUserMessage: async (key) => {
    const s = get();
    const canonical = key
      ? canonicalizeSessionKey(key)
      : s.activeSessionKey;

    // Don't allow regenerate while a turn is still mid-flight; that would
    // create two parallel assistant streams on the same session.
    if (s.sending[canonical] || s.streaming[canonical]) return false;

    const list = s.messages[canonical] ?? [];
    if (list.length === 0) return false;

    // Walk backwards to find the most recent user-text message. Skip
    // tool-only messages (kind:"tool") and assistant entries.
    let userIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "user" && m.kind !== "tool" && m.content?.trim()) {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return false;

    const lastUser = list[userIdx];

    // We cannot reconstruct File handles from the echoed AttachmentPart, so
    // attachment retries are intentionally a no-op (audit roadmap H2 note).
    if (lastUser.attachments && lastUser.attachments.length > 0) {
      set((state) => ({
        errors: {
          ...state.errors,
          [canonical]:
            "Tidak bisa regenerate: pesan terakhir punya lampiran. Kirim ulang manual.",
        },
      }));
      return false;
    }

    // Drop everything AFTER the last user message — the failed/aborted
    // assistant turn plus any tool entries from that turn. The user's
    // own message stays so the regenerated reply pairs to the same prompt.
    const trimmed = list.slice(0, userIdx + 1);
    set((state) => ({
      messages: { ...state.messages, [canonical]: trimmed },
      streaming: { ...state.streaming, [canonical]: null },
      errors: { ...state.errors, [canonical]: null },
      turnTextOffset: { ...state.turnTextOffset, [canonical]: 0 },
    }));

    // sendMessage will re-append a user bubble — to avoid a dupe, pop the
    // existing one first AFTER the cleanup above. We do this in one set()
    // call (above) plus the slice; the bubble below will be re-inserted by
    // sendMessage's optimistic echo branch.
    // Remove the trailing user bubble we just kept, since sendMessage will
    // re-append it as part of its optimistic echo.
    set((state) => {
      const cur = state.messages[canonical] ?? [];
      if (cur.length === 0 || cur[cur.length - 1].id !== lastUser.id) {
        return state;
      }
      return {
        messages: {
          ...state.messages,
          [canonical]: cur.slice(0, -1),
        },
      };
    });

    // SM2: pin the re-send to the SAME key we truncated on. Without the
    // keyOverride, sendMessage falls back to activeSessionKey, so a regenerate
    // fired while the active session shifts would land the reply in the wrong
    // thread (the documented "pilih kiwi, dijawab Buff" misroute class).
    return await s.sendMessage(lastUser.content, undefined, canonical);
  },

  editAndResubmit: async (messageId, newText, key) => {
    const trimmed = (newText ?? "").trim();
    if (!trimmed) return false;

    const s = get();
    const canonical = key
      ? canonicalizeSessionKey(key)
      : s.activeSessionKey;

    if (s.sending[canonical] || s.streaming[canonical]) return false;

    const list = s.messages[canonical] ?? [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;

    const target = list[idx];
    if (target.role !== "user" || target.kind === "tool") return false;

    // Constrain to the LAST user-text message. Hermes 0.14 has no
    // session.message.delete RPC, so editing earlier messages would leave
    // the original turns persisted on disk and rehydrate above the
    // resubmitted turn on next loadHistory.
    let lastUserIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "user" && m.kind !== "tool" && m.content?.trim()) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx !== idx) return false;

    if (target.attachments && target.attachments.length > 0) {
      set((state) => ({
        errors: {
          ...state.errors,
          [canonical]:
            "Tidak bisa edit: pesan terakhir punya lampiran. Kirim ulang manual.",
        },
      }));
      return false;
    }

    // Truncate everything from the edited user message onward — sendMessage
    // will re-append a fresh user bubble with the new text.
    set((state) => ({
      messages: { ...state.messages, [canonical]: list.slice(0, idx) },
      streaming: { ...state.streaming, [canonical]: null },
      errors: { ...state.errors, [canonical]: null },
      turnTextOffset: { ...state.turnTextOffset, [canonical]: 0 },
    }));

    // SM2: pin to the truncated key (see retryLastUserMessage).
    return await s.sendMessage(trimmed, undefined, canonical);
  },

  abortActive: async (key) => {
    const client = clientInstance;
    if (!client) return;
    const canonical = key
      ? canonicalizeSessionKey(key)
      : get().activeSessionKey;
    // Nothing to abort if nothing streaming nor pending.
    const s = get();
    const hasStream = Boolean(s.streaming[canonical]);
    const isSending = Boolean(s.sending[canonical]);
    if (!hasStream && !isSending) return;
    try {
      // Gateway accepts `{ sessionKey, runId? }` — omitting runId aborts ALL
      // active runs on this session, which is what the UI Stop button wants.
      // Source: Reff/openclaw/src/gateway/server-methods/chat.ts:1680–1759.
      // The trailing `chat` event with state="aborted" arrives separately and
      // is applied by _applyChatEvent, which commits partial content and
      // clears streaming/sending flags. So we intentionally do NOT clear
      // flags here — let the event authoritatively finalize the turn.
      await client.request<{ aborted: boolean; runIds: string[] }>(
        "chat.abort",
        { sessionKey: canonical },
      );
    } catch (err) {
      // If the abort RPC itself failed (network drop mid-abort, gateway
      // crash), commit whatever we had as aborted locally so the UI isn't
      // stuck on a dead spinner. The next `final`/`error` would overwrite
      // this, which is fine.
      const msg = mapError(err);
      set((state) => {
        const current = state.streaming[canonical];
        const list = state.messages[canonical] ?? [];
        const nextMessages = { ...state.messages };
        if (current) {
          nextMessages[canonical] = [
            ...list,
            { ...current, state: "aborted" as const },
          ];
        }
        return {
          messages: nextMessages,
          streaming: { ...state.streaming, [canonical]: null },
          sending: { ...state.sending, [canonical]: false },
          errors: { ...state.errors, [canonical]: msg },
        };
      });
    }
  },

  resolveApproval: async (requestId, choice, sessionKey) => {
    const client = clientInstance;
    if (!client) throw new Error("Bridge belum terhubung");
    const canonical = sessionKey
      ? canonicalizeSessionKey(sessionKey)
      : get().activeSessionKey;
    // Fire-and-forget the RPC; if it fails, throw so caller shows toast.
    // Bridge forwards to tui_gateway.approval.respond which calls
    // tools.approval.resolve_gateway_approval(session_id, choice).
    await client.request("approval.respond", {
      sessionKey: canonical,
      requestId,
      choice,
    });
    // Optimistic mutation: walk all messages, find the matching block,
    // stamp `.resolved`. The agent's next turn will replace/append the
    // assistant message but the persisted history already shows the
    // resolved bubble — survives refresh.
    const userName = "Chief";
    set((s) => mutateBlockField<{ resolved: ApprovalResolved }>(
      s,
      canonical,
      (block) =>
        block.type === "approval_request" &&
        (block as ApprovalRequestBlock).requestId === requestId,
      { resolved: { choice, by: userName, at: Date.now() } },
    ));
  },

  resolveClarify: async (requestId, response, sessionKey) => {
    const client = clientInstance;
    if (!client) throw new Error("Bridge belum terhubung");
    const canonical = sessionKey
      ? canonicalizeSessionKey(sessionKey)
      : get().activeSessionKey;
    await client.request("clarify.respond", {
      sessionKey: canonical,
      requestId,
      response,
    });
    const userName = "Chief";
    set((s) => mutateBlockField<{ resolved: ClarifyResolved }>(
      s,
      canonical,
      (block) =>
        block.type === "clarify_request" &&
        (block as ClarifyRequestBlock).requestId === requestId,
      { resolved: { response, by: userName, at: Date.now() } },
    ));
  },

  dispatchCommand: async (commandText, sessionKey) => {
    const client = clientInstance;
    if (!client) return false;
    const canonical = sessionKey
      ? canonicalizeSessionKey(sessionKey)
      : get().activeSessionKey;
    // Hermes' command.dispatch handler at tui_gateway/server.py:4580 takes
    // `{ session_id, text }` where text is the full slash invocation
    // (e.g. "/model gpt-4o-mini"). Bridge has no special handler; we
    // forward as a generic passthrough via the client.request channel.
    try {
      await client.request<{ ok?: boolean; output?: string }>(
        "command.dispatch",
        {
          session_id: canonical,
          sessionKey: canonical,
          text: commandText,
        },
      );
      // Hermes' command.dispatch may emit follow-up messages (e.g. "/model"
      // echoes new model info) — those arrive via the normal message
      // event stream which the chat handler processes. Optimistic: render
      // a small confirmation chip in the transcript so chief knows it
      // dispatched. Done via a synthetic status entry. Future iter: wire
      // dispatch result into a proper system bubble.
      return true;
    } catch (err) {
      // Failed dispatch — fall back to sendMessage so the slash text
      // at least lands in the transcript and agent can interpret it
      // contextually. This matches Telegram fallback behavior where
      // unrecognized slashes get treated as plain text.
      const errMsg = err instanceof Error ? err.message : String(err);
      const isUnknownMethod = /-32601|method not found/i.test(errMsg);
      if (isUnknownMethod) {
        // Hermes version doesn't have command.dispatch — graceful fallback
        // to sendMessage (agent's reasoning will handle the slash inline).
        return await get().sendMessage(commandText);
      }
      throw err;
    }
  },

  loadCommandsCatalog: async () => {
    const client = clientInstance;
    if (!client) return;
    try {
      // Hermes' actual `commands.catalog` return shape (verified via
      // live probe 2026-05-23):
      //   { pairs: [[name, desc], ...],                  // 67 entries flat
      //     sub: {...}, canon: {...},                    // subcmd + aliases
      //     categories: [{ name: "Session", pairs: [...] }, ...],
      //     skill_count: number, warning: string }
      // Bridge forwards verbatim. We read `pairs` (flat) for the actual
      // commands, then enrich with category labels from `categories`.
      const result = await client.request<{
        pairs?: unknown;
        categories?: Array<{ name?: string; pairs?: unknown }>;
      }>("commands.list", {});
      const out: Array<{ name: string; description: string; category?: string }> = [];
      const seen = new Set<string>();
      const categoryByName = new Map<string, string>();
      // First pass — index category labels via categories[].pairs
      const cats = result?.categories;
      if (Array.isArray(cats)) {
        for (const cat of cats) {
          const label = typeof cat?.name === "string" ? cat.name : undefined;
          if (!label) continue;
          const list = Array.isArray(cat?.pairs) ? cat.pairs : [];
          for (const pair of list) {
            if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
            categoryByName.set(pair[0], label);
          }
        }
      }
      // Second pass — walk flat pairs as source of truth (covers EVERY
      // command including the ones not in any category bucket).
      const pairs = Array.isArray(result?.pairs) ? result.pairs : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length < 1) continue;
        const name = typeof pair[0] === "string" ? pair[0] : "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const description = typeof pair[1] === "string" ? pair[1] : "";
        out.push({
          name,
          description,
          category: categoryByName.get(name),
        });
      }
      // Sort by name within categories. Same-letter clusters render
      // alphabetically, which matches Telegram's command-menu UX.
      out.sort((a, b) => a.name.localeCompare(b.name));
      set({ commandsCatalog: out, commandsCatalogLoaded: true });
    } catch {
      // Silent — empty catalog falls through to "no commands match"
      // dropdown state. Hermes may not have commands.catalog (older
      // versions); falling back to empty is the right UX.
      set({ commandsCatalogLoaded: true });
    }
  },

  setReplyTarget: (sessionKey, target) => {
    const canonical = canonicalizeSessionKey(sessionKey);
    set((s) => ({
      replyTarget: { ...s.replyTarget, [canonical]: target },
    }));
  },

  editMessageInPlace: async (messageId, newText, sessionKey) => {
    const client = clientInstance;
    if (!client) return false;
    const canonical = sessionKey
      ? canonicalizeSessionKey(sessionKey)
      : get().activeSessionKey;
    try {
      await client.request("messages.edit", {
        sessionKey: canonical,
        messageId,
        newText,
      });
      // Optimistic local mutation: rewrite the message's content + blocks.
      set((s) => {
        const list = s.messages[canonical];
        if (!list) return s;
        let mutated = false;
        const next = list.map((msg) => {
          if (msg.id !== messageId) return msg;
          mutated = true;
          const nonTextBlocks = (msg.blocks ?? []).filter(
            (b) => b.type !== "text",
          );
          return {
            ...msg,
            content: newText,
            blocks: newText
              ? ([
                  { type: "text", text: newText } as ContentBlock,
                  ...nonTextBlocks,
                ] as ContentBlock[])
              : nonTextBlocks,
            editedAt: Date.now(),
          };
        });
        if (!mutated) return s;
        return { messages: { ...s.messages, [canonical]: next } };
      });
      return true;
    } catch (err) {
      // CONN-3: never swallow — surface so the caller/UI doesn't pretend it
      // worked (a silent edit/delete failure is the lie we are fixing).
      set((s) => ({ errors: { ...s.errors, [canonical]: mapError(err) } }));
      return false;
    }
  },

  deleteMessageInPlace: async (messageId, sessionKey) => {
    const client = clientInstance;
    if (!client) return false;
    const canonical = sessionKey
      ? canonicalizeSessionKey(sessionKey)
      : get().activeSessionKey;
    try {
      await client.request("messages.delete", {
        sessionKey: canonical,
        messageId,
      });
      // Optimistic local mutation: mark deleted = true.
      set((s) => {
        const list = s.messages[canonical];
        if (!list) return s;
        let mutated = false;
        const next = list.map((msg) => {
          if (msg.id !== messageId) return msg;
          mutated = true;
          return { ...msg, deleted: true, deletedAt: Date.now() };
        });
        if (!mutated) return s;
        return { messages: { ...s.messages, [canonical]: next } };
      });
      return true;
    } catch (err) {
      // CONN-3: surface the failure instead of swallowing it.
      set((s) => ({ errors: { ...s.errors, [canonical]: mapError(err) } }));
      return false;
    }
  },

  setVoiceMode: (on) => set({ voiceMode: on }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSettingsCategory: (id) => set({ settingsCategory: id }),
  setShowToolProgress: (v) => {
    set({ showToolProgress: v });
    try {
      localStorage.setItem("agentbuff:app:tool-progress", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  },

  playTTS: async (text) => {
    const client = clientInstance;
    if (!client) return null;
    try {
      const result = await client.request<{ displayUrl?: string }>(
        "voice.tts.play",
        { text },
      );
      return result?.displayUrl ?? null;
    } catch {
      return null;
    }
  },

  loadAgentsCatalog: async () => {
    const client = clientInstance;
    if (!client) return;
    try {
      const result = await client.request<{ agents?: unknown }>(
        "agents.list",
        {},
      );
      const raw = Array.isArray(result?.agents) ? result.agents : [];
      const out: Array<{
        id: string;
        name: string;
        emoji?: string;
        theme?: string;
        avatar?: string;
        description?: string;
      }> = [];
      for (const a of raw) {
        if (!a || typeof a !== "object") continue;
        const obj = a as Record<string, unknown>;
        const id = typeof obj.id === "string" ? obj.id : null;
        if (!id) continue;
        const identity =
          (obj.identity && typeof obj.identity === "object"
            ? (obj.identity as Record<string, unknown>)
            : {}) ?? {};
        const name =
          (typeof identity.name === "string" && identity.name) ||
          (typeof obj.name === "string" && obj.name) ||
          id;
        out.push({
          id,
          name: name as string,
          emoji:
            typeof identity.emoji === "string" ? identity.emoji : undefined,
          theme:
            typeof identity.theme === "string" ? identity.theme : undefined,
          avatar:
            typeof identity.avatar === "string"
              ? identity.avatar
              : undefined,
          description:
            typeof obj.description === "string"
              ? obj.description
              : typeof obj.systemPromptOverride === "string"
                ? obj.systemPromptOverride.slice(0, 80)
                : undefined,
        });
      }
      set({ agentsCatalog: out, agentsCatalogLoaded: true });
    } catch {
      set({ agentsCatalogLoaded: true });
    }
  },

  searchSessionsContent: async (query: string) => {
    const client = clientInstance;
    if (!client) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const res = await client.request<{
        results?: SessionSearchResult[];
        total?: number;
        query?: string;
      }>("sessions.search", { query: trimmed, limit: 50 });
      const list = Array.isArray(res?.results) ? res.results : [];
      return list;
    } catch (err) {
      // Surface the failure so the UI can distinguish a broken search from a
      // genuine zero-result (was silently returning [] → looked like "no hits").
      throw new Error(mapError(err));
    }
  },

  // ──────── Folder actions ────────
  refreshFolders: async () => {
    const client = clientInstance;
    if (!client) return;
    try {
      const res = await client.request<{
        folders?: SessionFolder[];
        assignments?: Record<string, string>;
      }>("folders.list", {});
      const folders = Array.isArray(res?.folders) ? res.folders : [];
      const assignments =
        res?.assignments && typeof res.assignments === "object"
          ? res.assignments
          : {};
      set({
        folders,
        sessionFolders: assignments,
        foldersLoaded: true,
      });
    } catch (err) {
      // Folders are non-critical — log + continue. UI shows empty folder list.
      console.warn("[folders] refresh failed:", err);
      set({ foldersLoaded: true });
    }
  },

  createFolder: async (input) => {
    const client = clientInstance;
    if (!client) return null;
    try {
      const res = await client.request<{ folder: SessionFolder }>(
        "folders.create",
        {
          name: input.name,
          emoji: input.emoji ?? undefined,
          color: input.color ?? undefined,
          description: input.description ?? undefined,
        },
      );
      const folder = res?.folder;
      if (folder?.id) {
        set((s) => ({ folders: [...s.folders, folder] }));
        return folder;
      }
      return null;
    } catch (err) {
      console.warn("[folders] create failed:", err);
      return null;
    }
  },

  updateFolder: async (id, patch) => {
    const client = clientInstance;
    if (!client) return null;
    try {
      const res = await client.request<{ folder: SessionFolder }>(
        "folders.update",
        { id, ...patch },
      );
      const updated = res?.folder;
      if (updated?.id) {
        set((s) => ({
          folders: s.folders.map((f) => (f.id === updated.id ? updated : f)),
        }));
        return updated;
      }
      return null;
    } catch (err) {
      console.warn("[folders] update failed:", err);
      return null;
    }
  },

  deleteFolder: async (id) => {
    const client = clientInstance;
    if (!client) return false;
    try {
      await client.request<{
        ok: boolean;
        removed: boolean;
        unassigned: number;
      }>("folders.delete", { id });
      set((s) => {
        // Strip folder + unassign all sessions in it
        const nextAssignments: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.sessionFolders)) {
          if (v !== id) nextAssignments[k] = v;
        }
        return {
          folders: s.folders.filter((f) => f.id !== id),
          sessionFolders: nextAssignments,
        };
      });
      return true;
    } catch (err) {
      console.warn("[folders] delete failed:", err);
      return false;
    }
  },

  assignSessionToFolder: async (sessionKey, folderId) => {
    const client = clientInstance;
    if (!client) return false;
    const canonical = canonicalizeSessionKey(sessionKey);
    // Optimistic update — UI feels instant
    const prev = get().sessionFolders;
    set((s) => {
      const next = { ...s.sessionFolders };
      if (folderId) next[canonical] = folderId;
      else delete next[canonical];
      return { sessionFolders: next };
    });
    try {
      await client.request<{ ok: boolean }>("folders.assign", {
        sessionKey: canonical,
        folderId,
      });
      return true;
    } catch (err) {
      console.warn("[folders] assign failed:", err);
      set({ sessionFolders: prev });
      return false;
    }
  },

  bulkAssignFolder: async (sessionKeys, folderId) => {
    const client = clientInstance;
    if (!client || sessionKeys.length === 0) return false;
    const canonicalKeys = sessionKeys.map((k) => canonicalizeSessionKey(k));
    const prev = get().sessionFolders;
    set((s) => {
      const next = { ...s.sessionFolders };
      for (const k of canonicalKeys) {
        if (folderId) next[k] = folderId;
        else delete next[k];
      }
      return { sessionFolders: next };
    });
    try {
      await client.request<{ ok: boolean; count: number }>(
        "folders.assign.bulk",
        { sessionKeys: canonicalKeys, folderId },
      );
      return true;
    } catch (err) {
      console.warn("[folders] bulk assign failed:", err);
      set({ sessionFolders: prev });
      return false;
    }
  },

  refreshSessions: async () => {
    const client = clientInstance;
    if (!client) return;
    try {
      // The Hermes bridge's sessions.list ALWAYS derives titles + last-message
      // previews from the DB (it only reads `limit`). The old
      // includeDerivedTitles / includeLastMessage params were OpenClaw-era
      // no-ops on this bridge, so we send none.
      const res = await client.request<SessionsListResult>("sessions.list", {});
      get()._applySessionsList(res);
    } catch (err) {
      set({ sessionsError: mapError(err) });
    }
  },

  loadHistory: async (key, opts) => {
    const client = clientInstance;
    if (!client) return;
    const canonical = canonicalizeSessionKey(key);
    const existing = get().messages[canonical];
    if (!opts?.force && existing !== undefined) return; // cached
    get()._setHistoryLoading(canonical, true);
    try {
      const res = await client.request<SessionsGetResult>("sessions.get", {
        key: canonical,
      });
      const msgs = Array.isArray(res?.messages)
        ? res.messages.map((raw) =>
            rawToMessage(
              raw,
              raw.role === "user" ? "user" : "assistant",
            ),
          )
        : [];
      get()._replaceHistory(canonical, msgs);
      // Pre-existing sessions (from sessions.list carry-over) whose engine
      // config was written before our verboseDefault seed — pin the
      // per-session override now so their next send already streams full
      // tool output + thinking. Idempotent via `patchedSessionDefaults` Set.
      void get()._patchSessionDefaults(canonical);
    } catch (err) {
      const mapped = mapError(err);
      // NOT_FOUND on the active session = fresh container or stale
      // localStorage activeSessionKey. Treat as empty transcript and clear
      // the persisted key so the user's next sendMessage creates a new
      // session cleanly instead of surfacing a scary error bubble.
      if (classifyErrorMessage(mapped).kind === "not_found") {
        // 2026-06-09: do NOT yank the user back to the Command Center
        // (DEFAULT) when the active session holds a live conversation. A
        // just-created per-agent session can momentarily not resolve via
        // sessions.get (engine sid vs dbkey vs profile timing), and resetting
        // activeSessionKey to DEFAULT here was the "selesai jawab -> loncat ke
        // command center" bug. Only fall back to DEFAULT for a TRULY empty /
        // stale key (no messages on screen) — i.e. a fresh container or a stale
        // persisted key, which is what this branch was meant for.
        const hadMessages = (get().messages[canonical]?.length ?? 0) > 0;
        if (!hadMessages) {
          get()._replaceHistory(canonical, []);
          if (get().activeSessionKey === canonical) {
            persistActiveKey(DEFAULT_SESSION_KEY);
            set({ activeSessionKey: DEFAULT_SESSION_KEY });
          }
        }
      } else {
        set((s) => ({
          errors: { ...s.errors, [canonical]: mapped },
        }));
      }
    } finally {
      get()._setHistoryLoading(canonical, false);
    }
  },

  backfillMeta: async (key) => {
    const client = clientInstance;
    if (!client) return;
    const canonical = key
      ? canonicalizeSessionKey(key)
      : get().activeSessionKey;
    try {
      const res = await client.request<SessionsGetResult>("sessions.get", {
        key: canonical,
      });
      const rawMsgs = Array.isArray(res?.messages) ? res.messages : [];
      if (rawMsgs.length === 0) return;
      set((s) => {
        const list = s.messages[canonical];
        if (!list || list.length === 0) return s;
        // Pair-walk from the tail: the persisted transcript and our in-memory
        // list share the same turn order, so pairing by index-from-end lets us
        // backfill the assistant message we just committed (plus any earlier
        // ones that happen to be missing meta — cheap and idempotent). Break
        // out as soon as roles disagree so we never mis-attribute usage to the
        // wrong bubble.
        //
        // Two backfill channels:
        //   (1) Assistant `meta` (tokens / model / cost) — only the persisted
        //       transcript carries these; the live `final` chat event ships
        //       just `{role, content, timestamp}` per server-chat.ts:833–840.
        //   (2) User `userContext` (bootstrap prelude, channel envelope,
        //       timestamp, untrusted-context JSON fences) — injected by the
        //       gateway after our optimistic `sendMessage` echo, so the
        //       local bubble ALWAYS starts without the context card. We
        //       parse the persisted raw content and surface the split as
        //       `cleanText` in `content`/`blocks` + captured layers on
        //       `userContext`. Only writes when `context.hasAny` is true
        //       so plain user messages stay untouched.
        let li = list.length - 1;
        let ri = rawMsgs.length - 1;
        const metaUpdates = new Map<number, MessageMeta>();
        const userCtxUpdates = new Map<
          number,
          { context: UserContextMeta; cleanText: string }
        >();
        // Third backfill channel: persistent attachment URLs. Optimistic
        // user bubbles carry blob: URLs that die on tab refresh or session
        // switch. The bridge embeds `[[PORTAL_ATTACHMENT_URLS:...]]` in
        // the persisted prompt text pointing at `/media/<token>/<filename>`,
        // so backfilling here keeps Telegram-grade playback alive across
        // every UI state transition — even before the user clicks refresh.
        const userAttachmentUpdates = new Map<
          number,
          ChatMessage["attachments"]
        >();
        // 4th channel: stable-id migration. The bridge stamps every
        // history-loaded message with `raw.__agentbuff.id = agb_<dbkey>_<idx>`,
        // but live messages start with a client-side UUID
        // (`newMessageId()`) until they hit the JSON. Pair-walk also
        // captures any client UUID → stable agb_ id remap so pin/delete/
        // edit/react RPCs on those bubbles resolve to a real slot in
        // session JSON (not NOT_FOUND). Pin storage was removed wholesale
        // per chief's feedback; the remap still helps annotations +
        // edit/delete (localStorage + bridge soft-delete) survive refresh.
        const idMigrations = new Map<string, string>();
        while (li >= 0 && ri >= 0) {
          const local = list[li];
          const raw = rawMsgs[ri];
          const rawRole =
            raw.role === "user" || raw.role === "system" ? raw.role : "assistant";
          if (local.role !== rawRole) break;
          // ID migration: only when the raw side has a stable id AND it
          // differs from the local id. Skip if local id is already stable
          // (idempotent — protects against double-walks).
          const rawStable = (raw as { __agentbuff?: { id?: string } })
            .__agentbuff?.id;
          if (
            rawStable &&
            typeof rawStable === "string" &&
            rawStable !== local.id &&
            !local.id.startsWith("agb_")
          ) {
            idMigrations.set(local.id, rawStable);
          }
          if (
            local.role === "assistant" &&
            local.kind !== "tool" &&
            !local.meta
          ) {
            const markers = detectToolMarkers(raw);
            if (!markers.isTool) {
              const m = extractMessageMeta(raw);
              if (m) metaUpdates.set(li, m);
            }
          }
          if (local.role === "user") {
            const rawText = extractMessageText(raw.content);
            if (rawText) {
              const parsed = parseUserPayload(rawText);
              if (!local.userContext && parsed.context.hasAny) {
                userCtxUpdates.set(li, {
                  context: parsed.context,
                  cleanText: parsed.cleanText,
                });
              }
              // Promote blob URL → persistent HTTP URL whenever the sentinel
              // carries one. Conditions:
              //  · sentinel must have at least one URL entry
              //  · local must NOT already have a non-blob URL (idempotent —
              //    don't clobber a freshly-rehydrated history message)
              const urls = parsed.context.portalAttachmentUrls;
              if (urls && urls.length > 0) {
                const localHasPersistentUrl =
                  (local.attachments ?? []).some(
                    (a) => a.displayUrl && !a.displayUrl.startsWith("blob:"),
                  );
                if (!localHasPersistentUrl) {
                  userAttachmentUpdates.set(
                    li,
                    urls.map((meta) => ({
                      kind: meta.kind,
                      name: meta.name,
                      displayUrl: meta.displayUrl,
                      sizeBytes: meta.sizeBytes,
                      mimeType:
                        meta.mimeType ||
                        (meta.kind === "image"
                          ? "image/*"
                          : meta.kind === "audio"
                            ? "audio/*"
                            : meta.kind === "video"
                              ? "video/*"
                              : "application/octet-stream"),
                    })),
                  );
                }
              }
            }
          }
          li -= 1;
          ri -= 1;
        }
        if (
          metaUpdates.size === 0 &&
          userCtxUpdates.size === 0 &&
          userAttachmentUpdates.size === 0 &&
          idMigrations.size === 0
        )
          return s;
        const next = list.map((msg, idx) => {
          const m = metaUpdates.get(idx);
          const uc = userCtxUpdates.get(idx);
          const ua = userAttachmentUpdates.get(idx);
          const newId = idMigrations.get(msg.id);
          if (!m && !uc && !ua && !newId) return msg;
          let updated: ChatMessage = msg;
          if (newId) updated = { ...updated, id: newId };
          if (m) updated = { ...updated, meta: m };
          if (uc) {
            // Keep `content` and `blocks` in sync with the stripped prose so
            // the bubble, copy-to-clipboard, and any future search renderer
            // all agree on what the user actually typed. Preserve non-text
            // blocks (image attachments) at their original order AFTER the
            // text block — mirrors `rawToMessage`'s history-path reshape.
            const nonTextBlocks = (updated.blocks ?? []).filter(
              (b) => b.type !== "text",
            );
            const nextBlocks: ContentBlock[] = uc.cleanText
              ? [
                  { type: "text", text: uc.cleanText } as ContentBlock,
                  ...nonTextBlocks,
                ]
              : nonTextBlocks;
            updated = {
              ...updated,
              userContext: uc.context,
              content: uc.cleanText,
              blocks: nextBlocks,
            };
          }
          if (ua && ua.length > 0) {
            // Swap blob URLs → persistent HTTP URLs in-place. The previous
            // blob URL is held by the browser until tab unload anyway, and
            // browsers don't fault when an in-flight `<audio>` element's
            // src is replaced with a working URL; the new bubble simply
            // points at the persistent media server next render.
            updated = { ...updated, attachments: ua };
          }
          return updated;
        });
        return {
          messages: { ...s.messages, [canonical]: next },
        };
      });
    } catch {
      // Silent — meta footer + context card are visual enhancements, not
      // correctness gates. Next hard refresh re-reads via loadHistory anyway.
    }
  },

  clearError: (key) => {
    const canonical = key
      ? canonicalizeSessionKey(key)
      : get().activeSessionKey;
    set((s) => ({
      errors: { ...s.errors, [canonical]: null },
      sessionsError: key ? s.sessionsError : null,
    }));
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  setDraft: (key, text) =>
    set((s) => {
      const canonical = canonicalizeSessionKey(key);
      const capped =
        text.length > DRAFT_MAX_LENGTH ? text.slice(0, DRAFT_MAX_LENGTH) : text;
      const current = s.drafts[canonical] ?? "";
      // No-op fast path — avoids a render cascade while the user is typing
      // something that matches what's already stored (shouldn't happen in
      // practice but cheap to guard).
      if (capped === current) return s;
      const nextDrafts = { ...s.drafts };
      if (capped.length > 0) {
        nextDrafts[canonical] = capped;
      } else {
        delete nextDrafts[canonical];
      }
      scheduleDraftFlush(nextDrafts);
      return { drafts: nextDrafts };
    }),

  clearDraft: (key) =>
    set((s) => {
      const canonical = key
        ? canonicalizeSessionKey(key)
        : s.activeSessionKey;
      if (!(canonical in s.drafts)) return s;
      const nextDrafts = { ...s.drafts };
      delete nextDrafts[canonical];
      scheduleDraftFlush(nextDrafts);
      return { drafts: nextDrafts };
    }),
  clearDraftPersistenceWarning: () => set({ draftPersistenceWarning: null }),
  setChatSearchQuery: (query) =>
    set({
      chatSearchQuery: query,
      // Reset navigation to "before first match" whenever the query
      // text changes. The next ↓ press lands on match #1; clearing the
      // query restores -1 so no stale active marker survives.
      chatSearchActiveIndex: query.trim().length > 0 ? 0 : -1,
    }),
  setChatSearchActiveIndex: (index) => set({ chatSearchActiveIndex: index }),
  setDefaultAgentId: (agentId) => {
    const trimmed = (agentId || "").trim() || "main";
    set({ defaultAgentId: trimmed });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          "agentbuff:app:defaultAgentId",
          trimmed,
        );
      } catch {
        /* private mode etc — non-fatal */
      }
    }
  },
}));

// Bridge the store handle to module-scoped helpers (scheduleDraftFlush) so
// they can flag persistence failures without a circular import. Tagged with
// a non-collision symbol on globalThis to keep the surface invisible to
// other modules.
if (typeof globalThis !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__agentbuff_store__ = useAppStore;
}

// Hydrate activeSessionKey + drafts from localStorage on first client-side
// read. Safe to call multiple times — idempotent. No debounced flush here:
// we're SEEDING from disk, not mutating, so `scheduleDraftFlush` would be a
// redundant write-back.
if (typeof window !== "undefined") {
  const stored = loadPersistedActiveKey();
  if (stored !== useAppStore.getState().activeSessionKey) {
    useAppStore.setState({ activeSessionKey: stored });
  }
  const storedDrafts = loadPersistedDrafts();
  if (Object.keys(storedDrafts).length > 0) {
    useAppStore.setState({ drafts: storedDrafts });
  }
  // H4 — rehydrate the default agent picker selection.
  try {
    const storedAgent = window.localStorage.getItem(
      "agentbuff:app:defaultAgentId",
    );
    if (storedAgent && storedAgent.trim()) {
      useAppStore.setState({ defaultAgentId: storedAgent.trim() });
    }
  } catch {
    /* private mode — fall back to in-memory default */
  }
}

/**
 * Module-level client handle. GatewayProvider owns the lifecycle —
 * everything else reads via these helpers.
 */
export function attachClient(client: GatewayClient): void {
  clientInstance = client;
  // Fresh connect — gateway may have restarted or we may be reattaching to
  // a brand-new container. Clear the dedupe cache so every session gets
  // re-patched on first focus / send this lifecycle.
  patchedSessionDefaults.clear();
}

export function detachClient(): void {
  clientInstance = null;
}

export function getClient(): GatewayClient | null {
  return clientInstance;
}

// Dev-only window accessor for browser-side debugging via preview_eval.
// Lets us inspect store state without React DevTools. Stripped under
// `process.env.NODE_ENV === "production"` so prod bundle stays clean.
if (
  typeof window !== "undefined" &&
  process.env.NODE_ENV !== "production"
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as unknown as Record<string, unknown>).__appStore = useAppStore;
}
