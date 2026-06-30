"use client";

/**
 * Block-level renderer for assistant + tool messages.
 *
 * Wire contract (mirrors `Reff/openclaw/src/agents/anthropic-transport-stream.ts`):
 *  - text        → markdown via MessageMarkdown.
 *  - tool_use    → collapsible "Tool call" row (▸ + ⚡ + bold label + tool-name pill).
 *  - tool_result → collapsible "Tool output" row, is_error → red tint.
 *  - thinking    → collapsible "Pemikiran agen" row, redacted state disabled.
 *  - unknown     → tiny neutral pill so we don't silently drop data.
 *
 * Visual idiom ported from openclaw ui-agentbuff:
 *   `src/ui/chat/tool-cards.ts::renderCollapsedToolSummary`  (tool rows)
 *   `src/styles/chat/tool-cards.css` lines 528–622           (CSS shapes)
 * We swapped openclaw's `var(--accent)` (theme-driven) for literal
 * basecamp-aligned colors: cyan for tool_use, emerald for tool_result,
 * red for is_error, indigo for thinking. Same collapsible + chevron +
 * mono tool-name pill pattern.
 */

import {
  Component,
  memo,
  useCallback,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Brain,
  Globe,
  HelpCircle,
  Sparkles,
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import type {
  ApprovalChoice,
  ApprovalRequestBlock,
  BrowserProgressBlock,
  ClarifyRequestBlock,
  ContactBlock,
  ContentBlock,
  DiceBlock,
  EmbedBlock,
  LocationBlock,
  ModalBlock,
  PollBlock,
  SelectBlock,
  StatusUpdateBlock,
  StickerBlock,
  SubagentBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/lib/hermes/rpc-types";
import {
  ContactCard,
  DiceCard,
  EmbedCard,
  LocationCard,
  ModalCard,
  PollCard,
  SelectCard,
  StickerCard,
} from "./rich-blocks";
import { cn } from "@/lib/utils";
import { MessageMarkdown } from "./message-markdown";
import {
  buildToolPreview,
  getToolEmoji,
  getToolLabel,
} from "@/lib/app/tool-display";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n/types";

type Props = {
  blocks: ContentBlock[];
  /** When true, render is inside a still-streaming assistant bubble.
   *  Used to hint "menjalankan…" on in-flight tool rows. */
  streaming?: boolean;
  /** Active chat search query — when non-empty, each TextPart routes it
   *  through MessageMarkdown which wraps matched substrings in <mark>.
   *  Empty string = no highlighting (cheap fast-path). */
  searchQuery?: string;
};

function blockKey(block: ContentBlock, idx: number): string {
  if (block.type === "tool_use") {
    return `tu-${(block as ToolUseBlock).id || idx}`;
  }
  if (block.type === "tool_result") {
    return `tr-${(block as ToolResultBlock).tool_use_id || idx}`;
  }
  if (block.type === "thinking") {
    return `th-${(block as ThinkingBlock).index ?? idx}`;
  }
  if (block.type === "text") {
    return `tx-${idx}`;
  }
  if (block.type === "subagent") {
    return `sa-${(block as SubagentBlock).subagentId}-${(block as SubagentBlock).phase}-${idx}`;
  }
  if (block.type === "status_update") {
    return `st-${idx}`;
  }
  if (block.type === "approval_request") {
    return `ap-${(block as ApprovalRequestBlock).requestId}`;
  }
  if (block.type === "clarify_request") {
    return `cl-${(block as ClarifyRequestBlock).requestId}`;
  }
  if (block.type === "browser_progress") {
    return `bp-${idx}`;
  }
  return `u-${idx}`;
}

// "Work-in-progress" block types hidden when the chief turns OFF "Tampilkan
// proses kerja AI di chat" (store.showToolProgress = false). The final answer
// (text), interactive blocks (approval/clarify), and rich content always render
// — only the tool/thinking/status breadcrumbs are suppressed.
const TOOL_PROGRESS_TYPES = new Set<string>([
  "tool_use",
  "tool_result",
  "thinking",
  "status_update",
  "browser_progress",
  "subagent",
]);

function MessageBlocksImpl({ blocks: rawBlocks, streaming, searchQuery = "" }: Props) {
  const { t } = useI18n();
  const showToolProgress = useAppStore((s) => s.showToolProgress);
  const blocks = showToolProgress
    ? rawBlocks
    : (rawBlocks ?? []).filter((b) => !TOOL_PROGRESS_TYPES.has(b.type));
  if (!blocks || blocks.length === 0) return null;

  // Pair tool_use + matching tool_result blocks so each tool activity
  // renders as ONE compact row (Telegram/Discord parity). Adjacent
  // tool_result that matches an immediately-preceding tool_use's id
  // gets folded into the pair; orphan tool_result (no matching use)
  // renders as a standalone result row. Orphan tool_use (no result
  // yet — agent still running) renders with streaming=true.
  const items: Array<
    | { kind: "single"; block: ContentBlock; idx: number }
    | {
        kind: "pair";
        toolUse: ToolUseBlock;
        toolResult: ToolResultBlock | null;
        idx: number;
      }
  > = [];
  const consumedResultIds = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "tool_use") {
      const use = b as ToolUseBlock;
      // Find matching tool_result anywhere in the rest of the blocks
      // (Hermes sometimes interleaves a thinking block between use and
      // result; we still pair them so the row stays compact).
      let pairedResult: ToolResultBlock | null = null;
      for (let j = i + 1; j < blocks.length; j++) {
        const cand = blocks[j];
        if (cand.type !== "tool_result") continue;
        const tr = cand as ToolResultBlock;
        if (tr.tool_use_id && tr.tool_use_id === use.id) {
          pairedResult = tr;
          consumedResultIds.add(use.id);
          break;
        }
      }
      items.push({
        kind: "pair",
        toolUse: use,
        toolResult: pairedResult,
        idx: i,
      });
      continue;
    }
    if (b.type === "tool_result") {
      const tr = b as ToolResultBlock;
      if (tr.tool_use_id && consumedResultIds.has(tr.tool_use_id)) {
        // Already rendered in pair above — skip
        continue;
      }
    }
    items.push({ kind: "single", block: b, idx: i });
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        if (item.kind === "pair") {
          return (
            <CompactToolPairRow
              key={`pair-${item.toolUse.id || item.idx}`}
              toolUse={item.toolUse}
              toolResult={item.toolResult}
              streaming={Boolean(streaming) && !item.toolResult}
            />
          );
        }
        const { block, idx } = item;
        const key = blockKey(block, idx);
        if (block.type === "text") {
          return (
            <TextPart
              key={key}
              block={block as TextBlock}
              searchQuery={searchQuery}
              streaming={Boolean(streaming)}
            />
          );
        }
        if (block.type === "tool_result") {
          // Orphan tool_result (no matching tool_use in same message) —
          // render standalone with the compact row (uses tool_use_id as
          // the tool name proxy if no name is known).
          return (
            <CompactToolPairRow
              key={key}
              toolUse={null}
              toolResult={block as ToolResultBlock}
              streaming={false}
            />
          );
        }
        if (block.type === "thinking") {
          return <ThinkingRow key={key} block={block as ThinkingBlock} />;
        }
        if (block.type === "subagent") {
          return <SubagentRow key={key} block={block as SubagentBlock} />;
        }
        if (block.type === "status_update") {
          return (
            <StatusUpdateRow key={key} block={block as StatusUpdateBlock} />
          );
        }
        if (block.type === "approval_request") {
          return (
            <ApprovalRow key={key} block={block as ApprovalRequestBlock} />
          );
        }
        if (block.type === "clarify_request") {
          return (
            <ClarifyRow key={key} block={block as ClarifyRequestBlock} />
          );
        }
        if (block.type === "browser_progress") {
          return (
            <BrowserProgressRow
              key={key}
              block={block as BrowserProgressBlock}
            />
          );
        }
        if (block.type === "poll") {
          return <PollCard key={key} block={block as PollBlock} />;
        }
        if (block.type === "dice") {
          return <DiceCard key={key} block={block as DiceBlock} />;
        }
        if (block.type === "location") {
          return <LocationCard key={key} block={block as LocationBlock} />;
        }
        if (block.type === "contact") {
          return <ContactCard key={key} block={block as ContactBlock} />;
        }
        if (block.type === "sticker") {
          return <StickerCard key={key} block={block as StickerBlock} />;
        }
        if (block.type === "embed") {
          return <EmbedCard key={key} block={block as EmbedBlock} />;
        }
        if (block.type === "select") {
          return <SelectCard key={key} block={block as SelectBlock} />;
        }
        if (block.type === "modal") {
          return <ModalCard key={key} block={block as ModalBlock} />;
        }
        return <UnknownBlockPill key={key} type={block.type} />;
      }).map((node, i) => (
        // Wrap each block render in a boundary so a single malformed
        // block can't take down the entire bubble. Defense for skills
        // that emit rich blocks (poll/dice/embed/...) with missing or
        // wrong-typed fields. Fallback is a tiny mono pill — same shape
        // as UnknownBlockPill so the visual gap is small + consistent.
        <BlockBoundary key={`bnd-${i}`} index={i} fallbackLabel={t.app.chat.blocks.brokenBlock}>
          {node}
        </BlockBoundary>
      ))}
    </div>
  );
}

class BlockBoundary extends Component<
  { children: ReactNode; index: number; fallbackLabel: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (typeof console !== "undefined") {
      console.warn(
        "[message-blocks] block render failed; falling back to error pill",
        { index: this.props.index, error, info },
      );
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-red-500/25 bg-red-500/[0.06] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-red-200/80">
          <AlertTriangle className="size-3" />
          {this.props.fallbackLabel}
        </div>
      );
    }
    return this.props.children;
  }
}

export const MessageBlocks = memo(MessageBlocksImpl);

// ── text ────────────────────────────────────────────────────────────────
function TextPart({
  block,
  searchQuery = "",
  streaming = false,
}: {
  block: TextBlock;
  searchQuery?: string;
  streaming?: boolean;
}) {
  const text = block.text ?? "";
  if (!text) return null;
  return (
    <MessageMarkdown searchQuery={searchQuery} streaming={streaming}>
      {text}
    </MessageMarkdown>
  );
}

// ── Compact tool row (Telegram/Discord parity) ─────────────────────────
/**
 * Renders one tool activity as a Telegram-style single-line entry:
 *   ▸ 💻 Terminal: "hermes config show stt"        🟢
 * Click chevron expands inline to show Input + Output JSON for
 * power-user debug. Mirrors `agent/display.py::build_tool_preview`
 * + per-tool emoji lookup from `tools/*.py::registry.register()`.
 */
function CompactToolPairRow({
  toolUse,
  toolResult,
  streaming,
}: {
  toolUse: ToolUseBlock | null;
  toolResult: ToolResultBlock | null;
  streaming: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const toolName = toolUse?.name ?? "(unknown)";
  const emoji = useMemo(() => getToolEmoji(toolName), [toolName]);
  const label = useMemo(() => getToolLabel(toolName), [toolName]);
  const preview = useMemo(
    () =>
      toolUse
        ? buildToolPreview(
            toolName,
            toolUse.input as Record<string, unknown> | null | undefined,
          )
        : "",
    [toolName, toolUse],
  );

  const isError = Boolean(toolResult?.is_error);
  const status: "running" | "ok" | "error" = streaming
    ? "running"
    : isError
      ? "error"
      : toolResult
        ? "ok"
        : "running";

  const inputJson = useMemo(
    () => (toolUse ? safeStringify(toolUse.input) : ""),
    [toolUse],
  );
  const hasInput = inputJson && inputJson !== "{}";
  const resultBody = useMemo(
    () =>
      toolResult ? toolResultToString(toolResult.content) : "",
    [toolResult],
  );
  const hasResultBody = resultBody.length > 0;
  const canExpand = hasInput || hasResultBody;

  // Visual accent per status — subtle border-left bar so rows are visible
  // at a glance (chief earlier reported they "menghilang" because the
  // previous design had no border + tiny text → invisible against dark bg).
  const accentBar =
    status === "error"
      ? "border-l-red-400/60"
      : status === "running"
        ? "border-l-amber-400/60"
        : "border-l-cyan-400/50";
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={canExpand ? toggle : undefined}
        aria-expanded={open}
        disabled={!canExpand}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg border border-l-2 border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
          accentBar,
          canExpand
            ? "cursor-pointer hover:border-white/15 hover:bg-white/[0.05]"
            : "cursor-default",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "shrink-0 font-mono text-[10px] text-white/45 transition-transform",
            canExpand && "group-hover:text-white/70",
            open && "rotate-90",
          )}
        >
          ▸
        </span>
        <span aria-hidden className="shrink-0 text-[15px] leading-none">
          {emoji}
        </span>
        <span className="shrink-0 font-medium text-white/90">
          {label}
        </span>
        {preview ? (
          <>
            <span aria-hidden className="shrink-0 text-white/45">
              :
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-white/65">
              &quot;{preview}&quot;
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <StatusDot
          status={status}
          titles={{
            running: t.app.chat.blocks.dotRunning,
            ok: t.app.chat.blocks.dotDone,
            error: t.app.chat.blocks.dotError,
          }}
        />
      </button>
      {open && canExpand ? (
        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-white/10 bg-[#05070C]/60 px-3 py-2">
          {hasInput ? (
            <KvBox label={t.app.chat.blocks.inputLabel} body={inputJson} tone="call" />
          ) : null}
          {hasResultBody ? (
            <KvBox
              label={isError ? t.app.chat.blocks.errorLabel : t.app.chat.blocks.outputLabel}
              body={resultBody}
              tone={isError ? "error" : "ok"}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Small status dot at end of row.
 *  - emerald: tool completed ok
 *  - red: is_error=true
 *  - amber pulse: in-progress / streaming */
function StatusDot({
  status,
  titles,
}: {
  status: "running" | "ok" | "error";
  titles: { running: string; ok: string; error: string };
}) {
  return (
    <span
      aria-hidden
      title={
        status === "running"
          ? titles.running
          : status === "ok"
            ? titles.ok
            : titles.error
      }
      className={cn(
        "ml-1 inline-block size-[6px] shrink-0 rounded-full",
        status === "ok"
          ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
          : status === "error"
            ? "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]"
            : "animate-pulse bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.7)]",
      )}
    />
  );
}

/** Label + body box inside the expanded compact row. Replaces the old
 *  ToolRow's CodePre with explicit Input/Output framing. */
function KvBox({
  label,
  body,
  tone,
}: {
  label: string;
  body: string;
  tone: "call" | "ok" | "error";
}) {
  const labelColor =
    tone === "error"
      ? "text-red-300/85"
      : tone === "ok"
        ? "text-emerald-300/85"
        : "text-cyan-300/85";
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.18em]",
          labelColor,
        )}
      >
        {label}
      </span>
      <CodePre>{body}</CodePre>
    </div>
  );
}

// ── thinking ────────────────────────────────────────────────────────────
function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const text = block.thinking ?? "";
  const preview = useMemo(() => buildPreview(text), [text]);
  // Hooks above this line run unconditionally — redacted branch must come
  // AFTER the hook calls to stay rules-of-hooks compliant.
  if (block.redacted) {
    return (
      <ToolRow
        tone="thinking"
        label={t.app.chat.blocks.thinkingLabel}
        name={t.app.chat.blocks.thinkingRedacted}
        open={false}
        onToggle={null}
      >
        {null}
      </ToolRow>
    );
  }
  return (
    <ToolRow
      tone="thinking"
      label={t.app.chat.blocks.thinkingLabel}
      name={preview || ""}
      open={open}
      onToggle={text ? toggle : null}
    >
      {text ? (
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-white/70">
          {text}
        </p>
      ) : null}
    </ToolRow>
  );
}

// ── subagent ────────────────────────────────────────────────────────────
function SubagentRow({ block }: { block: SubagentBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const phaseLabel: Record<typeof block.phase, string> = {
    start: t.app.chat.blocks.subagentStart,
    tool: t.app.chat.blocks.subagentTool,
    complete: t.app.chat.blocks.subagentComplete,
  };
  const summary = useMemo(() => {
    if (block.phase === "complete") {
      const parts: string[] = [];
      if (block.summary) parts.push(block.summary);
      if (block.durationSeconds !== undefined)
        parts.push(`${block.durationSeconds.toFixed(2)}s`);
      if (block.inputTokens !== undefined || block.outputTokens !== undefined) {
        const io = `${block.inputTokens ?? "?"}↓ ${block.outputTokens ?? "?"}↑`;
        parts.push(io);
      }
      if (block.costUsd !== undefined) parts.push(`$${block.costUsd.toFixed(4)}`);
      return parts.join(" · ");
    }
    if (block.phase === "tool") {
      return [block.toolName, block.toolPreview].filter(Boolean).join(" · ");
    }
    if (block.phase === "start") {
      return block.goal || `task ${block.taskIndex ?? 0 + 1}/${block.taskCount ?? "?"}`;
    }
    return "";
  }, [block]);
  const bodyJson = useMemo(() => safeStringify(block), [block]);
  return (
    <ToolRow
      tone="subagent"
      label={phaseLabel[block.phase]}
      name={summary || ""}
      open={open}
      onToggle={toggle}
    >
      <CodePre>{bodyJson}</CodePre>
    </ToolRow>
  );
}

// ── status_update ───────────────────────────────────────────────────────
function StatusUpdateRow({ block }: { block: StatusUpdateBlock }) {
  return (
    <div className="inline-flex w-fit items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[11.5px] text-amber-100">
      <Zap className="size-3.5 text-amber-300" aria-hidden />
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-200/80">
        {block.statusKind}
      </span>
      <span className="text-amber-100/90">{block.text}</span>
    </div>
  );
}

// ── approval_request ────────────────────────────────────────────────────
// Telegram parity (Hermes 0.14 `send_exec_approval`): 2x2 button grid
// → ✅ Setuju sekali / Sesi ini / Selalu setuju / ❌ Tolak. On click,
// calls `approval.respond` RPC via `resolveApproval` store action.
// Block.resolved is set optimistically after RPC succeeds — bubble
// swaps from buttons to `✅ Disetujui {label} oleh {by}` line.
// Heuristic danger analysis → drives the "Disarankan" suggestion + the red
// warning banner. Patterns mirror the kinds of guards Hermes' approval system
// trips on (rm -rf, fork bomb, sudo, pipe-to-shell, disk ops, secret access).
const DANGEROUS_CMD_RE =
  /(\brm\s+-[a-z]*[rf]|:\(\)\s*\{|\bmkfs\b|\bdd\s+if=|\bchmod\s+-?R?\s*777|\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh|>\s*\/dev\/[sh]d|\bsudo\b|\bshutdown\b|\breboot\b|\bkill\s+-9|\bdrop\s+(table|database)\b|\btruncate\b|--no-preserve-root|-rf\b)/i;

type BlocksDict = Dictionary["app"]["chat"]["blocks"];

function choiceLabel(b: BlocksDict, choice: ApprovalChoice): string {
  const map: Record<ApprovalChoice, string> = {
    once: b.approvalChoiceOnce,
    session: b.approvalChoiceSession,
    always: b.approvalChoiceAlways,
    deny: b.approvalChoiceDeny,
  };
  return map[choice];
}

/** Raw command/script preview, COLLAPSED by default — a mass-market user
 *  doesn't need a wall of code shoved in their face (Chief: "gausah di lihatin
 *  lah usr"). The toggle keeps it accessible for anyone who wants to inspect
 *  exactly what runs. */
function CollapsibleCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = command.split("\n").length;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/50 transition hover:border-white/20 hover:text-white/75"
      >
        <span aria-hidden className="text-[9px]">{open ? "▾" : "▸"}</span>
        {open
          ? t.app.chat.blocks.showCode
          : `${t.app.chat.blocks.hideCode} (${lines} ${t.app.chat.blocks.codeLines})`}
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1117] p-2 font-mono text-[10.5px] text-white/75">
          {command}
        </pre>
      ) : null}
    </div>
  );
}

function analyzeApproval(
  block: ApprovalRequestBlock,
  b: BlocksDict,
): {
  suggested: ApprovalChoice;
  danger: "low" | "medium" | "high";
  reason: string;
} {
  const cmd = block.command ?? "";
  const patterns = block.patternKeys ?? [];
  const dangerousPattern = patterns.some((p) =>
    /rm|fork|sudo|delete|destroy|drop|force|mkfs|overwrite|secret|key|wipe|format|\bdd\b/i.test(p),
  );
  if (dangerousPattern || DANGEROUS_CMD_RE.test(cmd)) {
    return {
      suggested: "deny",
      danger: "high",
      reason: b.approvalReasonHigh,
    };
  }
  if (cmd || patterns.length > 0) {
    return {
      suggested: "once",
      danger: "medium",
      reason: b.approvalReasonMedium,
    };
  }
  return {
    suggested: "once",
    danger: "low",
    reason: b.approvalReasonLow,
  };
}

function ApprovalRow({ block }: { block: ApprovalRequestBlock }) {
  const { t } = useI18n();
  const b = t.app.chat.blocks;
  const resolveApproval = useAppStore((s) => s.resolveApproval);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  // Route the response to the approval's OWN session (multi-agent / non-active
  // safe). The store stamps `block.sessionKey`; fall back to active for older
  // blocks persisted before the field existed.
  const targetKey = block.sessionKey || activeKey;
  const [pending, setPending] = useState<ApprovalChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Post-resolution display — buttons replaced with status line.
  if (block.resolved) {
    const r = block.resolved;
    const map: Record<ApprovalChoice, { emoji: string; label: string; tone: "ok" | "deny" }> = {
      once: { emoji: "✅", label: `${b.approvedOnce} ${r.by}`, tone: "ok" },
      session: { emoji: "✅", label: `${b.approvedSession} ${r.by}`, tone: "ok" },
      always: { emoji: "✅", label: `${b.approvedAlways} ${r.by}`, tone: "ok" },
      deny: { emoji: "❌", label: `${b.denied} ${r.by}`, tone: "deny" },
    };
    const m = map[r.choice];
    return (
      <ResolvedActionRow
        emoji={m.emoji}
        label={m.label}
        tone={m.tone}
        command={block.command}
        description={block.description}
      />
    );
  }

  const handle = async (choice: "once" | "session" | "always" | "deny") => {
    setError(null);
    setPending(choice);
    try {
      await resolveApproval(block.requestId, choice, targetKey);
    } catch (err: unknown) {
      setPending(null);
      setError(err instanceof Error ? err.message : b.approvalSendFail);
    }
  };

  const analysis = analyzeApproval(block, b);
  const isHigh = analysis.danger === "high";

  return (
    <div
      className={cn(
        "w-full rounded-xl border p-3",
        isHigh
          ? "border-red-500/45 bg-red-500/[0.07]"
          : "border-amber-400/35 bg-amber-500/[0.06]",
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-[16px] leading-none">
          {isHigh ? "🚫" : "⚠️"}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-[13px] font-semibold", isHigh ? "text-red-50" : "text-amber-50")}>
            {block.title || b.approvalTitle}
          </p>
          {block.description ? (
            <p className="mt-0.5 text-[12px] text-white/70">{block.description}</p>
          ) : block.summary ? (
            <p className="mt-0.5 text-[12px] text-white/70">{block.summary}</p>
          ) : null}
        </div>
      </div>
      {block.command ? <CollapsibleCommand command={block.command} /> : null}

      {/* Recommendation + danger reasoning. High danger → red; otherwise a
          calm cyan "suggested answer" hint so the user isn't left guessing. */}
      <div
        className={cn(
          "mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug",
          isHigh
            ? "border-red-500/45 bg-red-500/10 text-red-100"
            : "border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-50/90",
        )}
      >
        <span aria-hidden className="mt-px">{isHigh ? "🚫" : "💡"}</span>
        <span className="min-w-0">
          <span className="font-semibold">{b.approvalSuggested}: {choiceLabel(b, analysis.suggested)}</span>
          {" — "}
          {analysis.reason}
          {isHigh && block.patternKeys && block.patternKeys.length > 0 ? (
            <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-red-200/80">
              {b.approvalDetected}: {block.patternKeys.join(", ")}
            </span>
          ) : null}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <ApprovalBtn
          label={b.approvalBtnOnce}
          sendingLabel={b.approvalSending}
          recommendedBadge={b.approvalRecommendedBadge}
          onClick={() => handle("once")}
          pending={pending === "once"}
          disabled={pending !== null}
          recommended={analysis.suggested === "once"}
        />
        <ApprovalBtn
          label={b.approvalBtnSession}
          sendingLabel={b.approvalSending}
          recommendedBadge={b.approvalRecommendedBadge}
          onClick={() => handle("session")}
          pending={pending === "session"}
          disabled={pending !== null}
        />
        <ApprovalBtn
          label={b.approvalBtnAlways}
          sendingLabel={b.approvalSending}
          recommendedBadge={b.approvalRecommendedBadge}
          onClick={() => handle("always")}
          pending={pending === "always"}
          disabled={pending !== null}
          warn
        />
        <ApprovalBtn
          label={b.approvalBtnDeny}
          sendingLabel={b.approvalSending}
          recommendedBadge={b.approvalRecommendedBadge}
          onClick={() => handle("deny")}
          pending={pending === "deny"}
          disabled={pending !== null}
          variant="deny"
          recommended={analysis.suggested === "deny"}
        />
      </div>

      {/* Scope explainer — what each "auto-approve" choice actually commits to.
          The danger of "Selalu setuju" is spelled out explicitly. */}
      <p className="mt-2 text-[11px] leading-snug text-white/55">
        <b className="text-white/75">{b.approvalScopeSessionLabel}</b>:{" "}
        {b.approvalScopeSessionDesc}
        <b className="text-amber-200/90">{b.approvalScopeAlwaysLabel}</b>:{" "}
        {b.approvalScopeAlwaysDesc1}
        <b className="text-amber-100">{b.approvalScopeAlwaysDesc2}</b>
        {b.approvalScopeAlwaysDesc3}
      </p>

      {error ? (
        <p className="mt-2 text-[11px] text-red-300">{error}</p>
      ) : null}
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
        ID {block.requestId.slice(0, 12)} · {b.approvalExpiresPrefix}
      </p>
    </div>
  );
}

function ApprovalBtn({
  label,
  sendingLabel,
  recommendedBadge,
  onClick,
  pending,
  disabled,
  variant,
  recommended,
  warn,
}: {
  label: string;
  sendingLabel: string;
  recommendedBadge: string;
  onClick: () => void;
  pending: boolean;
  disabled: boolean;
  variant?: "deny";
  /** Highlight as the suggested answer (ring + "Disarankan" badge). */
  recommended?: boolean;
  /** Amber caution styling for the high-commitment "Selalu setuju" option. */
  warn?: boolean;
}) {
  return (
    <div className="relative">
      {recommended ? (
        <span className="absolute -top-2 left-2 z-10 rounded-full border border-cyan-400/50 bg-[#0B0E14] px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.14em] text-cyan-200">
          {recommendedBadge}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-busy={pending}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-[12px] font-medium transition",
          "disabled:cursor-not-allowed disabled:opacity-60",
          variant === "deny"
            ? "border-red-500/40 bg-red-500/10 text-red-100 hover:bg-red-500/20 hover:border-red-500/60"
            : warn
              ? "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 hover:border-amber-500/60"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20 hover:border-emerald-500/60",
          recommended &&
            (variant === "deny"
              ? "ring-2 ring-red-400/60"
              : "ring-2 ring-cyan-400/60"),
        )}
      >
        {pending ? sendingLabel : label}
      </button>
    </div>
  );
}

// ── clarify_request ─────────────────────────────────────────────────────
// Telegram parity (Hermes 0.14 `send_clarify`): one row per choice +
// ✏️ Lainnya textarea for free-form responses. On click/Enter, calls
// `clarify.respond` RPC via `resolveClarify` store action. Block.resolved
// set optimistically — bubble swaps to question + `[Chief]: <response>`.
function ClarifyRow({ block }: { block: ClarifyRequestBlock }) {
  const { t } = useI18n();
  const b = t.app.chat.blocks;
  const resolveClarify = useAppStore((s) => s.resolveClarify);
  const sessionKey = useAppStore((s) => s.activeSessionKey);
  const [pending, setPending] = useState<string | null>(null);
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Post-resolution: show the question + user's response inline.
  if (block.resolved) {
    return (
      <ResolvedClarifyRow
        question={block.question}
        response={block.resolved.response}
        by={block.resolved.by}
      />
    );
  }

  const submit = async (response: string) => {
    const trimmed = response.trim();
    if (!trimmed) return;
    setError(null);
    setPending(trimmed);
    try {
      await resolveClarify(
        block.requestId,
        trimmed,
        block.sessionKey || sessionKey,
      );
    } catch (err: unknown) {
      setPending(null);
      setError(err instanceof Error ? err.message : b.clarifySendFail);
    }
  };

  return (
    <div className="w-full rounded-xl border border-cyan-400/35 bg-cyan-500/[0.06] p-3">
      <div className="mb-2 flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-[16px] leading-none">❓</span>
        <p className="min-w-0 flex-1 text-[13px] text-cyan-50">
          {block.question}
        </p>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {block.choices.map((choice, i) => (
          <button
            key={i}
            type="button"
            onClick={() => submit(choice)}
            disabled={pending !== null}
            className={cn(
              "flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.04]",
              "px-3 py-2 text-left text-[12px] text-white/85 transition",
              "hover:border-cyan-400/40 hover:bg-cyan-400/10",
              "disabled:cursor-not-allowed disabled:opacity-60",
              pending === choice && "border-cyan-400/60 bg-cyan-400/15",
            )}
          >
            <span className="shrink-0 font-mono text-[11px] text-cyan-300/85">
              {i + 1}.
            </span>
            <span className="flex-1">{choice}</span>
            {pending === choice ? (
              <span className="font-mono text-[10px] text-cyan-200/80">
                ...
              </span>
            ) : null}
          </button>
        ))}
        {!otherMode ? (
          <button
            type="button"
            onClick={() => setOtherMode(true)}
            disabled={pending !== null}
            className={cn(
              "flex items-start gap-2 rounded-md border border-dashed border-white/20",
              "px-3 py-2 text-left text-[12px] text-white/65 transition",
              "hover:border-cyan-400/40 hover:bg-cyan-400/5",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <span aria-hidden>✏️</span>
            <span>{b.clarifyOther}</span>
          </button>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit(otherText);
                }
                if (e.key === "Escape") {
                  setOtherMode(false);
                  setOtherText("");
                }
              }}
              placeholder={b.clarifyOtherPlaceholder}
              autoFocus
              disabled={pending !== null}
              className={cn(
                "flex-1 rounded-md border border-cyan-400/40 bg-[#0B0E14]/80 px-3 py-2",
                "text-[12px] text-white/95 placeholder:text-white/35",
                "focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400/50",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            />
            <button
              type="button"
              onClick={() => submit(otherText)}
              disabled={pending !== null || !otherText.trim()}
              className={cn(
                "rounded-md border border-cyan-400/50 bg-cyan-400/15 px-3 py-2",
                "text-[12px] font-medium text-cyan-100 transition",
                "hover:bg-cyan-400/25 hover:border-cyan-400/70",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {pending !== null ? "..." : b.clarifySend}
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p className="mt-2 text-[11px] text-red-300">{error}</p>
      ) : null}
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
        ID {block.requestId.slice(0, 12)} · {b.clarifyExpiresPrefix}
      </p>
    </div>
  );
}

/** Post-resolution narrative line for approval. */
function ResolvedActionRow({
  emoji,
  label,
  tone,
  command,
}: {
  emoji: string;
  label: string;
  tone: "ok" | "deny";
  command?: string;
  /** Accepted for caller compatibility but intentionally not rendered
   *  post-resolution (kept out of the UI to reduce noise). */
  description?: string;
}) {
  const accent =
    tone === "ok"
      ? "border-emerald-400/30 bg-emerald-500/[0.05]"
      : "border-red-400/30 bg-red-500/[0.05]";
  const labelTone = tone === "ok" ? "text-emerald-100" : "text-red-100";
  return (
    <div className={cn("w-full rounded-lg border px-3 py-2", accent)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[14px] leading-none">
          {emoji}
        </span>
        <span className={cn("text-[12.5px] font-medium", labelTone)}>
          {label}
        </span>
      </div>
      {/* Once resolved, the script + technical reason are noise — keep them
          tucked behind a collapsed toggle (default hidden) instead of dumping
          the whole block again. */}
      {command ? <CollapsibleCommand command={command} /> : null}
    </div>
  );
}

/** Post-resolution narrative line for clarify — question + answer. */
function ResolvedClarifyRow({
  question,
  response,
  by,
}: {
  question: string;
  response: string;
  by: string;
}) {
  return (
    <div className="w-full rounded-lg border border-cyan-400/20 bg-cyan-500/[0.03] px-3 py-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-[14px] leading-none">❓</span>
        <p className="min-w-0 flex-1 text-[12.5px] text-white/75">{question}</p>
      </div>
      <div className="mt-2 ml-6 flex items-start gap-2 rounded border border-cyan-400/15 bg-cyan-400/[0.04] px-2 py-1">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
          {by}
        </span>
        <span className="min-w-0 flex-1 text-[12px] text-white/85">
          {response}
        </span>
      </div>
    </div>
  );
}

// ── browser_progress ────────────────────────────────────────────────────
function BrowserProgressRow({ block }: { block: BrowserProgressBlock }) {
  const tone =
    block.level === "error"
      ? "text-red-300 border-red-500/30 bg-red-500/10"
      : block.level === "success"
      ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
      : block.level === "progress"
      ? "text-cyan-300 border-cyan-500/30 bg-cyan-500/10"
      : "text-white/70 border-white/10 bg-white/[0.03]";
  return (
    <div
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-md border px-2.5 py-1 text-[11.5px]",
        tone,
      )}
    >
      <Globe className="size-3.5 opacity-80" aria-hidden />
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] opacity-70">
        {block.level}
      </span>
      <span>{block.message}</span>
      {block.url ? (
        <span className="font-mono text-[10px] opacity-60">{block.url}</span>
      ) : null}
    </div>
  );
}

// ── unknown ─────────────────────────────────────────────────────────────
function UnknownBlockPill({ type }: { type: string }) {
  const { t } = useI18n();
  return (
    <div className="inline-flex w-fit items-center gap-1.5 rounded-md border border-dashed border-white/15 bg-white/[0.03] px-2 py-1 text-[11px] text-white/50">
      <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
      <span>{t.app.chat.blocks.unknownBlock}</span>
      <span className="font-mono">{type}</span>
    </div>
  );
}

// ── shared row chrome ───────────────────────────────────────────────────
type RowTone = "call" | "output" | "error" | "thinking" | "subagent";

/**
 * Single collapsible row — openclaw's `.chat-tool-msg-summary` translated
 * to Tailwind. Layout:
 *   [▸ chevron] [⚡ icon] [bold label] [mono tool-name] [trailing…]
 * Body expands below on click, bordered + darker bg for contrast.
 */
function ToolRow({
  tone,
  label,
  name,
  trailing,
  open,
  onToggle,
  children,
}: {
  tone: RowTone;
  label: string;
  name: string;
  trailing?: ReactNode;
  open: boolean;
  onToggle: (() => void) | null;
  children: ReactNode;
}) {
  // Per-tone accent for the icon + chevron (matches basecamp palette).
  const accentText =
    tone === "error"
      ? "text-red-400"
      : tone === "output"
      ? "text-emerald-400"
      : tone === "thinking"
      ? "text-indigo-300"
      : tone === "subagent"
      ? "text-fuchsia-300"
      : "text-cyan-300";

  // Per-tone glyph so rows aren't all lightning bolts.
  //  thinking → Brain  · call → Wrench  · output → Sparkles  · error → AlertTriangle
  const ToneIcon =
    tone === "error"
      ? AlertTriangle
      : tone === "output"
      ? Sparkles
      : tone === "thinking"
      ? Brain
      : tone === "subagent"
      ? Users
      : Wrench;

  // Per-tone left-bar accent so the rows VISIBLY differ from the dark
  // bubble bg — chief reported earlier "thinking ga muncul" because the
  // previous default (border-white/5 + bg-transparent) was nearly
  // invisible on the basecamp `#0B0E14` surface.
  const leftBar =
    tone === "error"
      ? "border-l-red-400/60"
      : tone === "thinking"
        ? "border-l-indigo-400/60"
        : tone === "subagent"
          ? "border-l-fuchsia-400/60"
          : tone === "output"
            ? "border-l-emerald-400/60"
            : "border-l-cyan-400/60";
  const header = (
    <div
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px]",
        "rounded-lg border border-l-2 border-white/[0.08] bg-white/[0.02]",
        leftBar,
        "transition-colors",
        onToggle
          ? "cursor-pointer hover:border-white/15 hover:bg-white/[0.05]"
          : "cursor-default",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "shrink-0 font-mono text-[10px] transition-transform",
          accentText,
          open ? "rotate-90" : "rotate-0",
        )}
      >
        ▸
      </span>
      <ToneIcon
        aria-hidden
        className={cn("size-3.5 shrink-0 opacity-80", accentText)}
      />
      <span className="shrink-0 font-semibold text-white/75">{label}</span>
      {name ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-white/55">
          {name}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {trailing}
    </div>
  );

  return (
    <div className="w-full">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="block w-full"
        >
          {header}
        </button>
      ) : (
        header
      )}
      {open && children ? (
        <div className="mt-1 rounded-lg border border-white/10 bg-[#05070C]/60 px-3 py-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// ── utilities ──────────────────────────────────────────────────────────
function CodePre({ children }: { children: string }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0d1117] p-2 font-mono text-[11.5px] leading-relaxed text-white/85">
      {children}
    </pre>
  );
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

/** Normalize a tool_result's content into a single string for display. */
function toolResultToString(
  content: ToolResultBlock["content"] | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    parts.push(safeStringify(part));
  }
  return parts.join("\n");
}

/** Collapse a multi-line body into a single-line teaser for the row header.
 *  Strips common markdown noise (bold/italic/heading/list/inline-code) so the
 *  teaser reads like prose in the mono pill — e.g. `**Initiating Bootstrap**`
 *  becomes `Initiating Bootstrap`, `# BOOTSTRAP.md` becomes `BOOTSTRAP.md`. */
function buildPreview(text: string): string {
  if (!text) return "";
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const clean = first
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(\S.*?\S|\S)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])_(\S.*?\S|\S)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 77)}…`;
}
