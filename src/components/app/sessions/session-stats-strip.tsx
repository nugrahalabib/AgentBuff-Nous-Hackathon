"use client";

/**
 * SessionsStatsStrip — 4 stat tile di top sebelum list.
 * - Total Obrolan
 * - Total Token (kumulasi)
 * - Aktif Hari Ini
 * - Paling Boros (sesi token tertinggi)
 */
import { useMemo } from "react";
import { Activity, BarChart3, MessageSquare, Trophy } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/app/store";
import { aggregateSessions, formatTokens } from "./helpers";

export function SessionsStatsStrip({
  sessions,
  loading,
  onSelectLargest,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  onSelectLargest?: (key: string) => void;
}) {
  const { t } = useI18n();
  const s = t.app.sessions;
  // Memoize the O(n) aggregate — the parent re-renders every 10s (now tick), so
  // without this it recomputed over every session on each tick.
  const stats = useMemo(() => aggregateSessions(sessions), [sessions]);
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
          >
            <div className="skeleton h-3 w-24 rounded" aria-hidden />
            <div className="skeleton mt-2 h-6 w-16 rounded" aria-hidden />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        icon={MessageSquare}
        label={s.statTotal}
        value={String(stats.totalSessions)}
        tone="cyan"
      />
      <Tile
        icon={BarChart3}
        label={s.statTokens}
        value={formatTokens(stats.totalTokens)}
        sublabel="kumulasi"
        tone="indigo"
        mono
      />
      <Tile
        icon={Activity}
        label={s.statActiveToday}
        value={String(stats.activeToday)}
        sublabel={stats.runningCount > 0 ? `${stats.runningCount} berjalan` : undefined}
        tone="emerald"
      />
      <Tile
        icon={Trophy}
        label={s.statLargest}
        value={
          stats.largestSession
            ? formatTokens(stats.largestSession.totalTokens)
            : "—"
        }
        sublabel={stats.largestSession?.title}
        tone="fuchsia"
        mono
        onClick={
          stats.largestSession
            ? () => onSelectLargest?.(stats.largestSession!.key)
            : undefined
        }
      />
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  sublabel,
  tone,
  mono,
  onClick,
}: {
  icon: typeof MessageSquare;
  label: string;
  value: string;
  sublabel?: string;
  tone: "cyan" | "indigo" | "emerald" | "fuchsia";
  mono?: boolean;
  onClick?: () => void;
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan-400/25 bg-cyan-400/[0.04]"
      : tone === "indigo"
        ? "border-indigo-400/25 bg-indigo-400/[0.04]"
        : tone === "emerald"
          ? "border-emerald-400/25 bg-emerald-400/[0.04]"
          : "border-fuchsia-400/25 bg-fuchsia-400/[0.04]";
  const iconColor =
    tone === "cyan"
      ? "text-cyan-300"
      : tone === "indigo"
        ? "text-indigo-300"
        : tone === "emerald"
          ? "text-emerald-300"
          : "text-fuchsia-300";

  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-xl border px-4 py-3 text-left backdrop-blur-md transition",
        toneClass,
        onClick && "cursor-pointer hover:bg-white/[0.05] active:scale-[0.98]",
      )}
    >
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
        <Icon className={cn("size-3.5", iconColor)} aria-hidden />
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-xl font-semibold text-white",
          mono && "font-mono text-lg",
        )}
      >
        {value}
      </div>
      {sublabel ? (
        <div className="mt-0.5 truncate text-[10px] text-white/55" title={sublabel}>
          {sublabel}
        </div>
      ) : null}
    </Wrapper>
  );
}
