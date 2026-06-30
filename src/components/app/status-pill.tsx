"use client";

import { useAppStore, type ConnStatus } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// Per-status dot styling. `ready` gets an emerald glow that mirrors the
// basecamp status chip; `reconnecting` uses an amber pulse; `closed` red;
// `idle` stays muted.
const DOT_CLASS: Record<ConnStatus, string> = {
  idle: "bg-white/30",
  connecting: "bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.7)]",
  ready:
    "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]",
  reconnecting: "bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.7)]",
  closed: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]",
};

const RING_CLASS: Record<ConnStatus, string> = {
  idle: "border-white/10",
  connecting: "border-amber-400/30",
  ready: "border-emerald-400/30",
  reconnecting: "border-amber-400/30",
  closed: "border-red-500/40",
};

export function StatusPill() {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const LABEL: Record<ConnStatus, string> = {
    idle: t.app.chat.statusPill.idle,
    connecting: t.app.chat.statusPill.connecting,
    ready: t.app.chat.statusPill.ready,
    reconnecting: t.app.chat.statusPill.reconnecting,
    closed: t.app.chat.statusPill.closed,
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/75 backdrop-blur-md transition-colors",
        RING_CLASS[status],
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[status])}
        aria-hidden
      />
      <span className="font-mono uppercase tracking-[0.18em]">
        {LABEL[status]}
      </span>
    </span>
  );
}
