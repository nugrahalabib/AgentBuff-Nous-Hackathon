"use client";

/**
 * SessionCard — rich card per sesi.
 *
 * Visual:
 * - Left rail dengan kind tone color
 * - Title prominent (clickable → drawer)
 * - Status pill (Live/Aborted/etc) + Kind chip
 * - Token breakdown (in/out arrows) + model badge
 * - Compaction count badge if any
 * - Updated relative time
 * - Right actions: Buka chat / Detail / More menu
 */
import { cva } from "class-variance-authority";
import { motion } from "framer-motion";
import {
  Bot,
  ChevronRight,
  Coins,
  ExternalLink,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/app/store";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";
import {
  activityOf,
  formatModel,
  formatRelative,
  formatTokenBreakdown,
  formatTokens,
  kindLabel,
  kindTone,
  modelProviderBadge,
  statusLabel,
  statusTone,
  contextPercent,
} from "./helpers";

const cardVariants = cva(
  "group relative overflow-hidden rounded-2xl border bg-[#0B0E14]/45 backdrop-blur-xl transition-all hover:bg-[#0B0E14]/65",
  {
    variants: {
      tone: {
        cyan: "border-cyan-400/20 hover:border-cyan-400/40 hover:shadow-[0_10px_28px_-12px_rgba(34,211,238,0.4)]",
        indigo:
          "border-indigo-400/20 hover:border-indigo-400/40 hover:shadow-[0_10px_28px_-12px_rgba(99,102,241,0.4)]",
        fuchsia:
          "border-fuchsia-400/20 hover:border-fuchsia-400/40 hover:shadow-[0_10px_28px_-12px_rgba(217,70,239,0.4)]",
        slate: "border-white/[0.08] hover:border-white/15",
      },
      selected: {
        true: "border-cyan-400/45 bg-cyan-400/[0.04] ring-1 ring-cyan-400/20",
        false: "",
      },
    },
    defaultVariants: { tone: "slate", selected: false },
  },
);

const railVariants = cva("absolute inset-y-0 left-0 w-[3px]", {
  variants: {
    tone: {
      cyan: "bg-gradient-to-b from-cyan-400 to-cyan-500/40",
      indigo: "bg-gradient-to-b from-indigo-400 to-indigo-500/40",
      fuchsia: "bg-gradient-to-b from-fuchsia-400 to-fuchsia-500/40",
      slate: "bg-white/15",
    },
  },
  defaultVariants: { tone: "slate" },
});

export function SessionCard({
  session,
  selected,
  isActive,
  bulkMode,
  index,
  now,
  onOpen,
  onOpenDetail,
  onDelete,
  onToggleSelect,
  folderName,
  folderEmoji,
  agentLabels,
  showAgentBadge,
}: {
  session: SessionSummary;
  selected: boolean;
  /** Is this the currently-active chat session? */
  isActive: boolean;
  /** Bulk mode toggle — show checkbox + click-to-select. */
  bulkMode: boolean;
  index: number;
  now: number;
  onOpen: () => void;
  onOpenDetail: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  /** Folder this session is assigned to (null if unfoldered). Renders a
   *  small chip in the card meta row so chief can see grouping at-a-glance. */
  folderName?: string | null;
  folderEmoji?: string | null;
  /** id → friendly {label, emoji} for the owning agent. Resolved against the
   *  session key; only rendered when showAgentBadge is true (user has 2+ agents). */
  agentLabels?: Record<string, { label: string; emoji: string }>;
  showAgentBadge?: boolean;
}) {
  const { t } = useI18n();
  const s = t.app.sessions;
  const tone = kindTone(session.kind);
  const activity = activityOf(session, now);
  const statusToneColor = statusTone(session.status);
  const sLabel = statusLabel(session.status, session.abortedLastRun);
  const model = formatModel(session.model, session.modelProvider);
  const providerBadge = modelProviderBadge(session.modelProvider);
  const childCount = session.childSessions?.length ?? 0;
  const ctxPct = contextPercent(session);
  const agentBadge = showAgentBadge
    ? resolveSessionAgentBadge(session, agentLabels)
    : null;

  const statusDotClass =
    statusToneColor === "emerald"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]"
      : statusToneColor === "amber"
        ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.85)]"
        : statusToneColor === "red"
          ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.85)]"
          : activity === "live"
            ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]"
            : "bg-white/30";

  const handleCardClick = bulkMode
    ? onToggleSelect
    : onOpenDetail;

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: Math.min(index * 0.03, 0.4),
        type: "spring",
        stiffness: 320,
        damping: 28,
      }}
      className={cardVariants({ tone, selected })}
    >
      {/* Left tone rail */}
      <span className={railVariants({ tone })} aria-hidden />

      {/* HTML rule: <button> can't nest <button>. Card body is a div with
          role="button" + keyboard handlers so inner action buttons stay
          legal markup. */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardClick();
          }
        }}
        className="block w-full cursor-pointer px-5 py-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40"
      >
        <div className="flex items-start gap-3">
          {/* Bulk checkbox */}
          {bulkMode ? (
            <Checkbox checked={selected} onChange={onToggleSelect} />
          ) : null}

          {/* Status dot column */}
          <div
            className={cn(
              "mt-1 flex size-2.5 shrink-0 rounded-full",
              statusDotClass,
              (session.status === "running" || activity === "live") && "animate-pulse",
            )}
            aria-hidden
          />

          {/* Main content */}
          <div className="min-w-0 flex-1">
            {/* Title row */}
            <div className="flex flex-wrap items-baseline gap-2">
              <h3
                className={cn(
                  "truncate text-sm font-semibold text-white",
                  isActive && "text-cyan-100",
                )}
              >
                {session.title}
              </h3>
              {isActive ? (
                <span className="inline-flex items-center rounded-full border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-100">
                  Aktif
                </span>
              ) : null}
            </div>

            {/* Meta row 1: kind + status + model */}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {agentBadge ? (
                <Chip tone="fuchsia">
                  <span aria-hidden className="text-[10px]">
                    {agentBadge.emoji}
                  </span>
                  <span className="truncate max-w-[110px]">{agentBadge.label}</span>
                </Chip>
              ) : null}
              <Chip tone={tone}>{kindLabel(session.kind)}</Chip>
              {session.status === "running" || session.abortedLastRun ? (
                <Chip
                  tone={
                    statusToneColor === "emerald"
                      ? "emerald"
                      : statusToneColor === "amber"
                        ? "amber"
                        : "red"
                  }
                >
                  {sLabel}
                </Chip>
              ) : null}
              {childCount > 0 ? (
                <Chip tone="slate" icon={<Bot className="size-2.5" />}>
                  {childCount} {s.childBadge}
                </Chip>
              ) : null}
              {/* Folder badge — only when assigned */}
              {folderName ? (
                <Chip tone="indigo">
                  <span aria-hidden className="text-[10px]">
                    {folderEmoji ?? "📁"}
                  </span>
                  <span className="truncate max-w-[120px]">{folderName}</span>
                </Chip>
              ) : null}
            </div>

            {/* Meta row 2: tokens + model + updated */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/65">
              {session.totalTokens != null ? (
                <span
                  className="inline-flex items-center gap-1 font-mono"
                  title={`Total ${formatTokens(session.totalTokens)} token`}
                >
                  <Coins className="size-3 text-amber-300/85" aria-hidden />
                  {formatTokenBreakdown(session)}
                </span>
              ) : null}
              {ctxPct != null ? (
                <span
                  className="inline-flex items-center gap-1"
                  title={`Konteks ${ctxPct}% terisi`}
                >
                  {s.contextLabel}
                  <span
                    className={cn(
                      "font-mono font-semibold",
                      ctxPct >= 85
                        ? "text-red-300"
                        : ctxPct >= 60
                          ? "text-amber-300"
                          : "text-white/75",
                    )}
                  >
                    {ctxPct}%
                  </span>
                </span>
              ) : null}
              {model ? (
                <span className="inline-flex items-center gap-1">
                  <Bot className="size-3 text-indigo-300/85" aria-hidden />
                  <span className="font-mono">{model}</span>
                  {providerBadge ? (
                    <span className="text-white/40">· {providerBadge}</span>
                  ) : null}
                </span>
              ) : null}
              <span className="text-white/45">{formatRelative(session.updatedAt, now)}</span>
            </div>

            {/* Preview */}
            {session.lastMessagePreview ? (
              <p className="mt-2 truncate text-[12px] leading-snug text-white/55">
                {session.lastMessagePreview}
              </p>
            ) : null}
          </div>

          {/* Right actions (hover-only) */}
          {!bulkMode ? (
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                title={s.open}
                aria-label={s.open}
                className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                title={s.delete}
                aria-label={s.delete}
                className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-200"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
              <ChevronRight
                className="size-4 text-white/30 transition group-hover:translate-x-0.5 group-hover:text-white/55"
                aria-hidden
              />
            </div>
          ) : null}
        </div>
      </div>
    </motion.article>
  );
}

function Chip({
  children,
  tone,
  icon,
}: {
  children: React.ReactNode;
  tone: "cyan" | "indigo" | "fuchsia" | "slate" | "emerald" | "amber" | "red";
  icon?: React.ReactNode;
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
      : tone === "indigo"
        ? "border-indigo-400/30 bg-indigo-400/10 text-indigo-100"
        : tone === "fuchsia"
          ? "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100"
          : tone === "emerald"
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            : tone === "amber"
              ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
              : tone === "red"
                ? "border-red-500/30 bg-red-500/10 text-red-100"
                : "border-white/15 bg-white/[0.04] text-white/65";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
        toneClass,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Minimal checkbox (we don't have shadcn Checkbox installed). */
function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Batal pilih sesi ini" : "Pilih sesi ini"}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "mt-1 flex size-4 shrink-0 items-center justify-center rounded border transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50",
        checked
          ? "border-cyan-400 bg-cyan-400 text-[#0B0E14]"
          : "border-white/20 bg-transparent hover:border-white/40",
      )}
    >
      {checked ? (
        <svg viewBox="0 0 12 12" className="size-2.5" fill="none">
          <path
            d="M2 6l3 3 5-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}

/**
 * Resolve the owning-agent badge for a session. Prefers the bridge-resolved
 * `agentId` (channel accounts carry it in config) and falls back to parsing
 * the canonical key prefix for legacy rows. `agentLabels` already carries the
 * prettified default-agent entry (built in SessionsTab from agentsCatalog).
 */
function resolveSessionAgentBadge(
  session: SessionSummary,
  labels: Record<string, { label: string; emoji: string }> | undefined,
): { label: string; emoji: string } | null {
  const id = session.agentId || agentIdFromSessionKey(session.key);
  if (!id) return null;
  return labels?.[id] ?? { label: id, emoji: "🤖" };
}
