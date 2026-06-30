/**
 * Browser-side type declarations for the subset of OpenClaw gateway RPC the
 * /app surface consumes. Mirrors `Docs/rpc-subset-contract.md` and the shapes
 * declared in `Reff/openclaw/ui-agentbuff/src/ui/types.ts` (upstream).
 *
 * DO NOT extend this file with types we don't actually call. The contract is
 * a FROZEN regression surface — before bumping the pinned OpenClaw version in
 * the Dockerfile, diff `server-methods/` + update this file + re-run POC.
 */

// ── Content blocks (Claude-shaped, normalized across providers) ──────────
// Reference: `Reff/openclaw/src/agents/anthropic-transport-stream.ts:240-342`.
// Every provider's output is normalized into this shape by the time it hits
// the gateway transcript. Gateway -> UI passes the blocks verbatim.
//
// IMPORTANT wire model (CORRECTED 2026-04-24, replaces earlier gotcha):
// The gateway emits TWO parallel event streams for a single assistant turn:
//
//   1. `event: "chat"` — carries TEXT-ONLY blocks. Deltas accumulate; final
//      finalizes text. Tool / thinking blocks are NOT in this stream.
//   2. `event: "agent"` — carries tool / thinking / lifecycle activity as a
//      sequence of `AgentEventPayload` frames. `stream === "tool"` arrives
//      with phases start → update* → result, each atomic. `stream === "item"`
//      carries other items (thinking, etc.). Source:
//      `Reff/openclaw/src/gateway/server-chat.ts:880-989`.
//
// The /app client MUST subscribe to BOTH streams. A client that only listens
// to `chat` will never render tool activity / thinking until the transcript
// is re-read via `sessions.get` on hard refresh (the exact bug we hit in
// Phase 4 M7 pre-patch — see CLAUDE.md §3.7.1 G4 update).

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  /** Model-provided tool call input — shape is tool-defined. May be `{}`. */
  input?: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  /** Either raw string or an array of nested content parts (usually text). */
  content?:
    | string
    | Array<{ type?: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** When true, the model refused to surface its reasoning. */
  redacted?: boolean;
  /** Ordering hint when multiple thinking blocks arrive in one turn. */
  index?: number;
};

/** Subagent execution lifecycle — one card per subagent run, phase
 *  discriminates between spawn (start), nested tool invocation, and
 *  completion with token/cost rollup. */
export type SubagentBlock = {
  type: "subagent";
  subagentId: string;
  phase: "start" | "tool" | "complete";
  parentId?: string;
  depth?: number;
  goal?: string;
  taskIndex?: number;
  taskCount?: number;
  model?: string;
  toolName?: string;
  toolPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  summary?: string;
  durationSeconds?: number;
};

/** Background process / cron / bg-task status one-shot pill. */
export type StatusUpdateBlock = {
  type: "status_update";
  statusKind: string;
  text: string;
};

/** Choice returned by the approval respond RPC. Matches Hermes'
 *  `resolve_gateway_approval(session_key, choice)` enum. */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

/** Per-block resolution feedback after the user clicks an approval
 *  button. Set client-side optimistically by `resolveApproval` store
 *  action so the bubble renders `✅ Disetujui permanen oleh Chief` in
 *  place of the original button grid. */
export type ApprovalResolved = {
  choice: ApprovalChoice;
  by: string;
  at: number; // epoch ms
};

/** Engine paused waiting for user approval. Interactive block — UI
 *  shows 4-button grid (Setuju sekali / Sesi ini / Selalu setuju /
 *  Tolak) that calls `approval.respond` RPC on click. */
export type ApprovalRequestBlock = {
  type: "approval_request";
  requestId: string;
  title: string;
  summary?: string;
  /** Dangerous command preview text. Optional; some approvals are
   *  generic (e.g. config change) without a command body. */
  command?: string;
  /** Reason / context — Hermes' `description` field. */
  description?: string;
  /** Matched guard pattern names (rm-recursive, fork-bomb, etc) for
   *  power-user debug — non-essential. */
  patternKeys?: string[];
  kind?: string;
  details?: unknown;
  /** Session key the approval belongs to — needed to route `approval.respond`
   *  to the OWNING session (not whatever is active), so a multi-agent / non-
   *  active-session approval still resolves correctly. */
  sessionKey?: string;
  /** Client-side optimistic resolution state. When set, UI swaps the
   *  button grid for a `✅ Disetujui ...` inline narrative line. */
  resolved?: ApprovalResolved;
};

/** Resolution payload for clarify. `response` is the chosen choice
 *  text OR the user-typed `Other` answer. */
export type ClarifyResolved = {
  response: string;
  by: string;
  at: number;
};

/** Engine asks for disambiguation. UI renders numbered choice buttons
 *  + a `✏️ Lainnya (ketik jawaban)` textarea for free-form responses
 *  (matches Telegram's `Other (type answer)` pattern). On click,
 *  calls `clarify.respond` RPC. */
export type ClarifyRequestBlock = {
  type: "clarify_request";
  requestId: string;
  question: string;
  /** Pre-defined answer choices (max 4 from Hermes' clarify_tool).
   *  When empty, the prompt is open-ended — user MUST type a response. */
  choices: string[];
  /** Session key — needed by /app store to route the respond RPC. */
  sessionKey?: string;
  resolved?: ClarifyResolved;
};

/** Choice returned by sudo respond. Single boolean — agent gets
 *  password prompt resolution. */
export type SudoResolved = {
  granted: boolean;
  by: string;
  at: number;
};

/** Sudo password prompt. Rare for /app users but shows up when agent
 *  uses terminal-with-sudo. Renders as approval-style 2-button row
 *  (Izinkan sekali / Tolak). Password itself NEVER transmitted — Hermes
 *  reads from local config. */
export type SudoRequestBlock = {
  type: "sudo_request";
  requestId: string;
  command: string;
  reason?: string;
  resolved?: SudoResolved;
};

/** Auto-browser tool live progress feed entry. */
export type BrowserProgressBlock = {
  type: "browser_progress";
  message: string;
  level: string;
  url?: string;
};

/** Telegram-parity Poll block. Renders question + vote buttons.
 *  Multi-answer + quiz variants supported per Telegram's poll API. */
export type PollBlock = {
  type: "poll";
  id: string;
  question: string;
  options: Array<{ text: string; voteCount?: number }>;
  /** "regular" = standard poll, "quiz" = single correct answer */
  pollType?: "regular" | "quiz";
  multipleAnswers?: boolean;
  anonymous?: boolean;
  correctOption?: number; // only for quiz
  totalVoters?: number;
  /** Set client-side after user voted; renders "Kamu pilih: <option>". */
  myVote?: number | number[];
};

/** Telegram-parity Dice/animated emoji block. */
export type DiceBlock = {
  type: "dice";
  /** Emoji from Telegram's supported dice set. */
  emoji: "🎲" | "🎯" | "🏀" | "⚽" | "🎳" | "🎰";
  value: number;
};

/** Telegram-parity Location block — rendered as embedded map preview
 *  + address + Open-in-Maps button. */
export type LocationBlock = {
  type: "location";
  latitude: number;
  longitude: number;
  /** Optional venue title (Telegram venue messages). */
  title?: string;
  /** Optional street address. */
  address?: string;
  /** When set, location updates over time (Telegram live location). */
  livePeriod?: number;
  livePeriodEndsAt?: number;
};

/** Telegram-parity Contact card block — renders avatar + name + phone
 *  + "Add to contacts" download as .vcf. */
export type ContactBlock = {
  type: "contact";
  phoneNumber: string;
  firstName: string;
  lastName?: string;
  vcard?: string;
  userId?: string;
  avatarUrl?: string;
};

/** Telegram + Discord sticker block. Renders WebP/TGS animation or
 *  Discord's PNG sticker with native autoplay loop. */
export type StickerBlock = {
  type: "sticker";
  /** "static" (WebP/PNG), "animated" (Telegram TGS), or "video" (WebM). */
  kind: "static" | "animated" | "video";
  displayUrl: string;
  filename?: string;
  emoji?: string;
  /** Sticker set name (Telegram) or guild emoji ID (Discord). */
  setName?: string;
  width?: number;
  height?: number;
};

/** Discord-parity rich Embed block. Multi-field structured content. */
export type EmbedBlock = {
  type: "embed";
  title?: string;
  description?: string;
  /** Hex color string (`#1abc9c`) or null. */
  color?: string;
  url?: string;
  authorName?: string;
  authorIconUrl?: string;
  authorUrl?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
  footerIconUrl?: string;
  timestamp?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

/** Discord-parity Select dropdown block — single or multi-choice. */
export type SelectBlock = {
  type: "select";
  requestId: string;
  question: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multi?: boolean;
  minValues?: number;
  maxValues?: number;
  placeholder?: string;
  resolved?: { selected: string[]; by: string; at: number };
};

/** Discord-parity Modal dialog block — multi-field text inputs in a
 *  popup. */
export type ModalBlock = {
  type: "modal";
  requestId: string;
  title: string;
  inputs: Array<{
    customId: string;
    label: string;
    style?: "short" | "paragraph";
    placeholder?: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    value?: string;
  }>;
  resolved?: { values: Record<string, string>; by: string; at: number };
};

/** Fallback for block `type`s we don't recognise (image, doc, etc.). */
export type UnknownBlock = {
  type: string;
  [k: string]: unknown;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | SubagentBlock
  | StatusUpdateBlock
  | ApprovalRequestBlock
  | ClarifyRequestBlock
  | SudoRequestBlock
  | BrowserProgressBlock
  | PollBlock
  | DiceBlock
  | LocationBlock
  | ContactBlock
  | StickerBlock
  | EmbedBlock
  | SelectBlock
  | ModalBlock
  | UnknownBlock;

// ── sessions.list ─────────────────────────────────────────────────────────
export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  /** Server-side derived title from first user message in transcript.
   *  Populated when sessions.list is called with `includeDerivedTitles: true`.
   *  Source: `Reff/openclaw/src/gateway/session-utils.ts:1248` (deriveSessionTitle).
   *  UI preference order: label (manual rename) > derivedTitle > displayName > ... */
  derivedTitle?: string;
  /** Short preview of the most recent message in the transcript. Populated
   *  when sessions.list is called with `includeLastMessage: true`. */
  lastMessagePreview?: string;
  /** Channel surface raw (e.g. "telegram:bot:123"). Set when source has
   *  channel scope format. */
  surface?: string;
  /** Raw `source` field from Hermes session row (tui/cli/api_server/
   *  telegram/whatsapp/...). Used by UI for channel filter. */
  source?: string;
  /** Channel-side peer identity (stored in sessions.user_id by Hermes).
   *  WhatsApp LID is auto-resolved to a phone number by the bridge. Null for
   *  web sessions. */
  peer?: string;
  /** Display-friendly peer label (e.g. "+6287877974096" or Telegram user id). */
  peerLabel?: string;
  /** Owning agent id resolved by the bridge (channel accounts carry an
   *  agent_id in config; web/app/cli fall back to "default"). Lets the
   *  Sessions tab filter by agent INDEPENDENT of channel. */
  agentId?: string;
  updatedAt: number | null;
  sessionId?: string;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  // ── V2 extended fields ──
  /** True kalau run terakhir di-abort manual oleh user. */
  abortedLastRun?: boolean;
  /** Run timing. */
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  /** AI behavior settings — global agent config (persisted di
   *  ~/.hermes/config.yaml). Sama untuk semua session si agent. */
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  /** Child sub-agent sessions yang di-spawn dari sesi ini. */
  childSessions?: string[];
};

// ── sessions.list params (options we actually pass) ───────────────────────
export type SessionsListParams = {
  /** Server reads first 8KB of each transcript to derive title from first
   *  user message. Cost: one extra file read per session on the gateway. */
  includeDerivedTitles?: boolean;
  /** Server reads last 16KB of each transcript to surface a recent preview. */
  includeLastMessage?: boolean;
  limit?: number;
  activeMinutes?: number;
  search?: string;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: {
    modelProvider: string | null;
    model: string | null;
    contextTokens: number | null;
  };
  sessions: GatewaySessionRow[];
};

// ── sessions.patch — used for rename (label) + other per-session settings ──
// Upstream handler: `Reff/openclaw/src/gateway/server-methods/sessions.ts:1267`.
// `label` is unique-enforced across the store; pass `null` to clear.
// SESSION_LABEL_MAX_LENGTH is 512 (primitives.ts).
//
// `verboseLevel` + `reasoningLevel` + `thinkingLevel` form a triad that is
// REQUIRED for realtime rendering parity with hard-refresh in /app:
//   - tool event `data.result` / `data.partialResult` are STRIPPED before
//     broadcast unless verboseLevel === "full" (server-chat.ts:904-915).
//     Default is "off" → tool output cards render empty realtime, only
//     populated after `sessions.get` rehydrate.
//   - thinking EVENTS (`stream: "thinking"`) are only forwarded when the
//     runner sees `reasoningLevel === "stream"` (pi-embedded-subscribe.ts:87,
//     pi-embedded-runner/attempt.ts:1642). Default "off" → gateway swallows
//     thinking deltas even if the model emitted them.
//   - the model must ACTUALLY THINK in the first place. For Gemini 2.5 Flash
//     the default thinkingBudget is 0 (see `google-stream-wrappers.test.ts`
//     "keeps thinkingBudget=0 for gemini-2.5-flash (not thinking-required)"),
//     so without `thinkingLevel` being set, `resolveGoogleThinkingConfig`
//     returns the disabled config and zero thinking parts are produced. The
//     server will also fall back to `resolveThinkingDefaultForModel` which
//     returns `"low"` only if the model catalog advertises reasoning — for
//     safety we pin it explicitly instead of relying on catalog discovery.
//     `thinkingLevel` values: "off" | "minimal" | "low" | "medium" | "high"
//     | "xhigh" | "adaptive" (validated server-side in
//     sessions-patch.ts:240–255; provider-specific filter applies).
// We set all three to the most-verbose/most-thinking value per-session (see
// `_patchSessionDefaults` in store.ts). Pass `null` to clear if a user ever
// wants to opt back out via a future /verbose off equivalent.
export type SessionsPatchParams = {
  key: string;
  label?: string | null;
  verboseLevel?: "off" | "on" | "full" | null;
  reasoningLevel?: "off" | "on" | "stream" | null;
  thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "adaptive"
    | null;
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key?: string;
  entry: {
    sessionId?: string;
    label?: string;
    model?: string;
    modelProvider?: string;
    updatedAt?: number;
  };
  resolved: {
    modelProvider: string | null;
    model: string | null;
  };
};

// ── sessions.delete response ──────────────────────────────────────────────
export type SessionsDeleteResult = {
  ok: true;
  key: string;
  deleted: boolean;
  archived: boolean;
};

// ── sessions.get response ─────────────────────────────────────────────────
// Messages are raw transcript entries — free-form `content` per
// `Reff/openclaw/src/gateway/session-utils.fs.ts:93`. Known shapes:
//  - { role, content: string, timestamp, __openclaw: {id, seq} }
//  - { role, content: [{type:"text", text}, {type:"tool_use", ...}], ... }
//  - { role: "system", content: [{type:"text", text:"Compaction"}], __openclaw:{kind:"compaction"} }
//
// Assistant messages ALSO carry optional `usage` / `model` / `cost` fields
// finalized at end-of-turn by the gateway. See openclaw
// `ui-agentbuff/src/ui/chat/grouped-render.ts:349` (extractGroupMeta) for
// the field-name unions — providers vary (Anthropic `inputTokens`, OpenAI
// `input`, Claude Cache `cache_read_input_tokens`, etc). We accept either.
export type TranscriptUsage = {
  input?: number;
  inputTokens?: number;
  output?: number;
  outputTokens?: number;
  cacheRead?: number;
  cache_read_input_tokens?: number;
  cacheWrite?: number;
  cache_creation_input_tokens?: number;
};
export type TranscriptCost = {
  total?: number;
};
export type GatewayTranscriptMessage = {
  role?: "user" | "assistant" | "system" | string;
  content?:
    | string
    | Array<{ type?: string; text?: string; [k: string]: unknown }>;
  timestamp?: number;
  usage?: TranscriptUsage;
  model?: string;
  cost?: TranscriptCost;
  /** Top-level tool markers — some transports (notably the Claude CLI import
   *  path at `Reff/openclaw/src/gateway/cli-session-history.ts`) stamp the
   *  tool identity on the MESSAGE instead of on a content block. Openclaw's
   *  own `message-normalizer.ts:244-260` uses these to override the role to
   *  `toolResult` and route to tool-card rendering. We mirror that signal
   *  here so `detectToolMarkers()` can flag the message without losing the
   *  original role. */
  toolName?: string;
  tool_name?: string;
  toolCallId?: string;
  tool_call_id?: string;
  __openclaw?: {
    id?: string;
    seq?: number;
    kind?: string;
  };
};

export type SessionsGetResult = {
  messages: GatewayTranscriptMessage[];
};

// ── chat.send events ──────────────────────────────────────────────────────
// Wire gotcha G4: one `event: "chat"` covers all streaming states via
// payload.state. Wire gotcha G5: content[].text is FULL merged text, not a
// delta chunk — the renderer MUST replace rather than accumulate.

/** A media attachment the BOT produced (image_generate / text_to_speech /
 *  video_generate tool output OR a file the agent wrote via write_file).
 *  Shape mirrors `AttachmentPart` in `@/lib/app/attachments` so the same
 *  per-kind cards + lightbox render bot attachments without divergence.
 *
 *  Emitted on `chat` event with `state="final"` — bridge extracts MEDIA:
 *  paths from the agent's final response via Hermes'
 *  `BasePlatformAdapter.extract_media` (the same routine Telegram/WA/
 *  Discord/Slack adapters use) and registers each path with the bridge's
 *  HTTP media server. `displayUrl` points at `http://<bridge>:<port>/
 *  media/<token>/<filename>` and is valid for 24 hours.
 */
export type BotAttachment = {
  kind: "image" | "audio" | "video" | "document";
  name: string;
  displayUrl: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
};

export type ChatEventPayload = {
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error";
  errorMessage?: string;
  message?: GatewayTranscriptMessage;
  /** Bot-produced media attachments, set on `state="final"` only. */
  attachments?: BotAttachment[];
};

// ── agent event payload (tool / thinking / lifecycle mid-run) ───────────
// Reference: `Reff/openclaw/src/gateway/server-chat.ts:880` — broadcast
// handler. Each frame carries `{ runId, seq, stream, ts, sessionKey?, data }`.
// We only consume `stream === "tool"` at MVP (tool start/update/result) plus
// pass-through of `stream === "item"` for future thinking/item rendering.
//
// Registration: the upstream gateway routes tool events only to connections
// that advertised `caps: ["tool-events"]` at `connect` time AND were the
// caller of the in-flight `chat.send`. Our `ws-proxy.ts:251` already does
// both, so tool events flow to the browser without any client-side
// subscription call. Non-tool `agent` streams (assistant/lifecycle/
// compaction/fallback) broadcast to all authenticated connections.
export type AgentEventPayload = {
  runId: string;
  seq?: number;
  stream:
    | "tool"
    | "item"
    | "thinking"
    | "assistant"
    | "lifecycle"
    | "compaction"
    | "fallback"
    | "plan"
    | "approval"
    | "command_output"
    | "patch"
    | "error"
    // Hermes 0.14 additions — see docker/hermes-bridge/event_translator.py
    | "subagent"
    | "status"
    | "clarify"
    | "browser"
    // Wave 6 additions — rich block emission (poll/dice/location/contact/
    // sticker/embed/select/modal) via _translate_rich_block bridge path.
    | "rich_block";
  ts?: number;
  /** Gateway stamps this for per-session filtering. Same canonicalization as
   *  the `chat` event (G3 — "agent:<agentId>:<key>" form). */
  sessionKey?: string;
  /** Shape is stream-specific:
   *   - `stream === "tool"`  → { toolCallId, name, phase: "start"|"update"|"result",
   *                              args?, partialResult?, result?, isError? }
   *   - `stream === "thinking"` → { text, delta }  (reasoning text streamed
   *                                incrementally from the engine — delta is the
   *                                new suffix since last event, text is the
   *                                full-merged reasoning so-far)
   *   - `stream === "item"`  → { itemId, phase, kind, title, status, ... }
   *                            (duplicate of tool-stream data for tool items —
   *                            /app ignores, tool stream is authoritative)
   *  Reference: `Reff/openclaw/ui-agentbuff/src/ui/app-tool-stream.ts:450` and
   *  `Reff/openclaw/src/agents/pi-embedded-subscribe.ts:672-682` (thinking). */
  data?: Record<string, unknown>;
};

// ── Sessions extended fields (Sessions tab v2) ─────────────────────────────
//
// SessionCompactionCheckpoint + SessionsCompactionListResult removed 2026-05-24
// because Hermes engine doesn't track session-level compaction lineage.
// The UI Snapshots tab is hidden + bridge stubs the RPCs as NOT_IMPLEMENTED.

/** Patch payload untuk `sessions.patch` — edit metadata + behavior. */
export type SessionsPatchPayload = {
  label?: string | null;
  thinkingLevel?: string | null;
  fastMode?: boolean | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
};

// ── chat.send attachment input shape ──────────────────────────────────────
// Mirrors `RpcAttachmentInput` + `ChatAttachment` in
// `Reff/openclaw/src/gateway/server-methods/attachment-normalize.ts`. The
// gateway also accepts a Claude-native `source: { type: "base64", ... }` shape
// but we always send the flat form — easier to validate and matches the
// type-first field the gateway prefers.
/**
 * Multimodal attachment wire shape.
 *
 * Sent by /app's chat.send → portal bridge processes per-type:
 *   - "image"    → bridge caches to Hermes image dir + calls `image.attach`
 *                  RPC; Hermes runs vision_analyze on next prompt.submit.
 *   - "audio"    → bridge caches; if STT skill installed it transcribes,
 *                  else prepends "[user sent audio at PATH]" context note.
 *   - "video"    → bridge caches; prepends "[user sent video at PATH]".
 *   - "document" → bridge caches; for text MIMEs (txt/md/csv/json/etc)
 *                  inlines content into message; for binary docs (PDF /
 *                  DOCX / XLSX / PPTX) prepends a path-pointer note so
 *                  the agent can read it with its file tools.
 *
 * Source: `docker/hermes-bridge/attachment_preprocessor.py`.
 */
export type ChatAttachmentInput = {
  type: "image" | "audio" | "video" | "document";
  /** Fully qualified MIME — bridge sniffs the base64 anyway but we set it so
   *  small payloads that bypass sniffing still classify correctly. */
  mimeType: string;
  fileName: string;
  /** Base64 (NO data-URL prefix). Bridge re-validates size against per-kind
   *  caps (5 MB image / 10 MB audio / 25 MB video / 10 MB document). */
  content: string;
};
