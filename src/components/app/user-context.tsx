"use client";

/**
 * Collapsible audit card rendered BELOW a user bubble. Surfaces the
 * gateway-injected preamble layers (bootstrap prelude, channel envelope,
 * leading timestamp, and the six inbound-meta JSON blocks) that the LLM
 * actually saw alongside the user's typed text.
 *
 * Why this exists:
 *  - Phase 4 MVP strips the preamble from user bubbles so they show only
 *    what the user typed (see `src/lib/app/strip-inbound-meta.ts`).
 *  - Without this card, the stripped data would vanish from the UI entirely.
 *    That's fine for the default reader but hostile to power users debugging
 *    why the agent responded the way it did.
 *  - Cron / scheduled-event messages also flow through the user-role path
 *    (`Reff/openclaw/src/infra/heartbeat-runner.ts:1022`) so the context
 *    card doubles as a "why did this fire" trace for automated triggers.
 *
 * Visual idiom mirrors `ToolRow` in `message-blocks.tsx`: chevron + icon +
 * label + mono preview on a translucent row, expanded body below. Default
 * collapsed — unchanged at rest, opt-in reveal on click.
 */

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import {
  Clock,
  FileAudio,
  GitBranch,
  History as HistoryIcon,
  Info,
  MessageSquare,
  Paperclip,
  Radio,
  Reply,
  Share2,
  Sparkles,
  UserRound,
} from "lucide-react";
import {
  rebrand,
  type MediaSummary,
  type UserContextMeta,
} from "@/lib/app/strip-inbound-meta";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function UserContextRowImpl({ context }: { context: UserContextMeta }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const summary = useMemo(() => buildSummary(context), [context]);
  if (!context.hasAny) return null;
  return (
    <div className="w-full max-w-md">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="block w-full"
      >
        <div
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px]",
            "rounded-lg border border-white/5 bg-transparent",
            "cursor-pointer transition-colors",
            "hover:border-indigo-300/25 hover:bg-white/[0.02]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "shrink-0 font-mono text-[10px] text-indigo-300/90 transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          >
            ▸
          </span>
          <Info
            aria-hidden
            className="size-3.5 shrink-0 text-indigo-300/90 opacity-80"
          />
          <span className="shrink-0 font-semibold text-white/70">
            Konteks yang AI terima
          </span>
          {summary ? (
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-white/45">
              {summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
        </div>
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-0.5 rounded-lg border border-white/10 bg-[#05070C]/60 px-1.5 py-2">
          {context.bootstrap ? (
            <MultiField
              icon={Sparkles}
              label="Bootstrap"
              value={rebrand(context.bootstrap)}
            />
          ) : null}
          {context.channel || context.channelHeader ? (
            <InlineField
              icon={Radio}
              label="Channel"
              value={rebrand(context.channel ?? context.channelHeader ?? "")}
            />
          ) : null}
          {context.timestamp ? (
            <InlineField
              icon={Clock}
              label="Waktu"
              value={rebrand(context.timestamp)}
            />
          ) : null}
          {context.sender !== undefined ? (
            <MultiField
              icon={UserRound}
              label="Pengirim"
              value={formatPayload(context.sender)}
            />
          ) : null}
          {context.conversation !== undefined ? (
            <MultiField
              icon={MessageSquare}
              label="Percakapan"
              value={formatPayload(context.conversation)}
            />
          ) : null}
          {context.threadStarter !== undefined ? (
            <MultiField
              icon={GitBranch}
              label="Thread starter"
              value={formatPayload(context.threadStarter)}
            />
          ) : null}
          {context.replied !== undefined ? (
            <MultiField
              icon={Reply}
              label="Balasan"
              value={formatPayload(context.replied)}
            />
          ) : null}
          {context.forwarded !== undefined ? (
            <MultiField
              icon={Share2}
              label="Diteruskan"
              value={formatPayload(context.forwarded)}
            />
          ) : null}
          {context.history !== undefined ? (
            <MultiField
              icon={HistoryIcon}
              label="Riwayat"
              value={formatPayload(context.history)}
            />
          ) : null}
          {context.mediaSummaries && context.mediaSummaries.length > 0 ? (
            <MultiField
              icon={FileAudio}
              label="Lampiran media"
              value={context.mediaSummaries
                .map(formatMediaSummary)
                .join("\n\n")}
            />
          ) : null}
          {context.portalAttachmentUrls &&
          context.portalAttachmentUrls.length > 0 ? (
            <MultiField
              icon={Paperclip}
              label="URL persisten"
              value={context.portalAttachmentUrls
                .map(
                  (u) =>
                    `${u.kind} · ${u.name}${u.sizeBytes ? ` (${u.sizeBytes} B)` : ""}\n${u.displayUrl}`,
                )
                .join("\n\n")}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Per-kind pretty-printer for the "Lampiran media" field. Mirrors the
 *  bridge's prefix-text format so chief can correlate what AI received
 *  to what they actually sent (transcript for VN, description for video,
 *  filename + extracted snippet for document, etc).
 */
function formatMediaSummary(m: MediaSummary): string {
  if (m.kind === "audio") {
    return `🎤 Voice note: "${m.transcript}"`;
  }
  if (m.kind === "video") {
    return `🎬 Video: ${m.description}`;
  }
  if (m.kind === "document") {
    const head = `📄 ${m.name}${m.docKind ? ` (${m.docKind})` : ""}`;
    if (!m.extractedContent) return head;
    const preview = m.extractedContent.slice(0, 280);
    const ellipsis = m.extractedContent.length > 280 ? "…" : "";
    return `${head}\n\n${preview}${ellipsis}`;
  }
  if (m.kind === "image") {
    return `🖼️ Gambar${m.description ? `: ${m.description}` : ""}`;
  }
  return "";
}

export const UserContextRow = memo(UserContextRowImpl);

// ── sub-rows ──────────────────────────────────────────────────────────────
/** Single-line field: label + value inline, no expand. Used for scalar
 *  captures (channel name, timestamp prefix). */
function InlineField({
  icon: Icon,
  label,
  value,
}: {
  icon: IconType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <Icon aria-hidden className="mt-[3px] size-3 shrink-0 text-white/50" />
      <span className="shrink-0 text-[11px] font-semibold text-white/70">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-white/55">
        {value}
      </span>
    </div>
  );
}

/** Collapsible field: single-line preview when closed, pretty-printed body
 *  when open. Used for JSON / markdown payloads that would blow up the row
 *  if rendered inline. */
function MultiField({
  icon: Icon,
  label,
  value,
}: {
  icon: IconType;
  label: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const preview = useMemo(() => collapseToPreview(value), [value]);
  const hasBody = value.trim().length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        disabled={!hasBody}
        className={cn(
          "block w-full text-left",
          hasBody ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div
          className={cn(
            "flex items-start gap-2 rounded px-2 py-1 transition-colors",
            hasBody && "hover:bg-white/[0.02]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-[4px] shrink-0 font-mono text-[9px] text-white/40 transition-transform",
              open ? "rotate-90" : "rotate-0",
              !hasBody && "opacity-0",
            )}
          >
            ▸
          </span>
          <Icon aria-hidden className="mt-[3px] size-3 shrink-0 text-white/50" />
          <span className="shrink-0 text-[11px] font-semibold text-white/70">
            {label}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-white/45">
            {preview}
          </span>
        </div>
      </button>
      {open && hasBody ? (
        <pre className="mx-2 mb-1 mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0d1117] p-2 font-mono text-[11px] leading-relaxed text-white/80">
          {value}
        </pre>
      ) : null}
    </div>
  );
}

// ── utilities ────────────────────────────────────────────────────────────
/** One-line teaser for the collapsed header. Lists which layers are present
 *  so a glance tells the user "there's a bootstrap + sender JSON here"
 *  without needing to expand. */
function buildSummary(ctx: UserContextMeta): string {
  const bits: string[] = [];
  if (ctx.channel) bits.push(rebrand(ctx.channel));
  else if (ctx.channelHeader) bits.push(rebrand(ctx.channelHeader));
  if (ctx.bootstrap) bits.push("bootstrap");
  if (ctx.sender !== undefined) bits.push("sender");
  if (ctx.conversation !== undefined) bits.push("conversation");
  if (ctx.threadStarter !== undefined) bits.push("thread");
  if (ctx.replied !== undefined) bits.push("reply");
  if (ctx.forwarded !== undefined) bits.push("forward");
  if (ctx.history !== undefined) bits.push("history");
  if (ctx.mediaSummaries?.length) bits.push("media");
  if (ctx.portalAttachmentUrls?.length) bits.push("urls");
  return bits.join(" · ");
}

/**
 * Serialize a captured payload for display. Applies the rebrand pass so
 * any leaked `OpenClaw` / `openclaw` strings — field names, namespaced IDs,
 * error messages — render as AgentBuff to the end user.
 */
function formatPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return rebrand(value);
  try {
    return rebrand(JSON.stringify(value, null, 2));
  } catch {
    try {
      return rebrand(String(value));
    } catch {
      return "";
    }
  }
}

/** Grab the first non-empty line and cap at 60 chars for the preview column. */
function collapseToPreview(text: string): string {
  if (!text) return "";
  const first =
    text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const clean = first.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean;
  return `${clean.slice(0, 57)}…`;
}
