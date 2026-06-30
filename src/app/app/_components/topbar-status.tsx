"use client";

/**
 * Topbar status row — tick pulse + connection pill + engine version + update
 * pill. Subscribes to the app store's `status` + `health` slices with shallow
 * selectors so re-renders are cheap.
 *
 * We intentionally do NOT subscribe to tick payload here — the status dot is
 * pure CSS `animate-pulse` so the topbar stays at 0 renders/s during normal
 * operation. Tick sparkline lives in the Overview tab only.
 */
import { Menu, Search } from "lucide-react";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useTrialClock } from "@/lib/app/use-trial-clock";
import { openBillingPopup } from "@/lib/app/billing-popup";
import type { TrialInfo } from "@/lib/billing/trial-resolver";
import { findNavItemByRoute } from "./nav-config";
import { usePathname } from "next/navigation";

type TopbarStatusProps = {
  mobileNavOpen?: boolean;
  onOpenMobileNav?: () => void;
  /** Active trial (null when subscribed / no trial) → renders countdown pill. */
  trial?: TrialInfo | null;
};

export function TopbarStatus({
  mobileNavOpen = false,
  onOpenMobileNav,
  trial = null,
}: TopbarStatusProps = {}) {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const openPalette = useAppStore((s) => s.setCommandPaletteOpen);
  const pathname = usePathname();
  const active = findNavItemByRoute(pathname ?? "/app/chat");

  const statusPalette =
    status === "ready"
      ? {
          border: "border-emerald-400/30",
          dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]",
          text: "text-emerald-200/90",
          label: t.app.connection.ready,
        }
      : status === "connecting"
        ? {
            border: "border-amber-400/30",
            dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)] animate-pulse",
            text: "text-amber-200/90",
            label: t.app.connection.connecting,
          }
        : status === "reconnecting"
          ? {
              border: "border-amber-400/30",
              dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)] animate-pulse",
              text: "text-amber-200/90",
              label: t.app.connection.reconnecting,
            }
          : {
              border: "border-red-500/40",
              dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.75)]",
              text: "text-red-200/90",
              label: t.app.connection.closed,
            };

  const activeGroup = active?.groupKey;
  const groupLabel = activeGroup ? t.app.nav.groups[activeGroup] : "";
  const tabLabel = active
    ? t.app.nav.tabs[active.id as keyof typeof t.app.nav.tabs]
    : "";

  return (
    <div className="flex items-center gap-3 border-b border-white/[0.06] bg-[#0B0E14]/60 px-5 py-3 backdrop-blur-xl">
      {/* M2 — Mobile-only hamburger that opens the nav sidebar drawer. */}
      {onOpenMobileNav ? (
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Buka menu navigasi"
          aria-expanded={mobileNavOpen}
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/65 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200 md:hidden"
        >
          <Menu className="size-4" />
        </button>
      ) : null}
      <div className="flex min-w-0 flex-col leading-tight">
        {groupLabel ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/40">
            {groupLabel}
          </span>
        ) : null}
        <span className="truncate text-sm font-semibold text-white/90">
          {tabLabel}
        </span>
      </div>
      <div className="flex-1" />
      {/* Command palette trigger — opens the same Cmd/Ctrl+K overlay for users
          who don't know the shortcut. */}
      <button
        type="button"
        onClick={() => openPalette(true)}
        aria-label={t.app.commandPalette.placeholder}
        title={t.app.commandPalette.placeholder}
        className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200"
      >
        <Search className="size-3.5 shrink-0" />
        <kbd className="rounded border border-white/15 bg-white/[0.06] px-1 font-mono text-[9px] not-italic text-white/45">
          Ctrl K
        </kbd>
      </button>
      {trial ? <TrialCountdownPill trial={trial} /> : null}
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1 backdrop-blur-md ${statusPalette.border} bg-white/[0.04]`}
      >
        <span className={`size-2 rounded-full ${statusPalette.dot}`} />
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.18em] ${statusPalette.text}`}
        >
          {statusPalette.label}
        </span>
      </div>
    </div>
  );
}

// Trial countdown pill — escalating states: normal (>=4d cyan), H-3 (2-3d
// amber), H-1 (<=1d red "hari terakhir"). Click opens the upgrade popup.
// The clock recomputes client-side every 60s so an open tab rolls the counter.
function TrialCountdownPill({ trial }: { trial: TrialInfo }) {
  const { t } = useI18n();
  const days = useTrialClock(trial.endsAt, trial.daysLeft);
  const urgent = days <= 1;
  const warn = days <= 3;
  const label = urgent
    ? t.app.trial.pillLastDay
    : t.app.trial.pillDays.replace("{n}", String(days));
  const palette = urgent
    ? {
        border: "border-red-500/40",
        dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.75)] animate-pulse",
        text: "text-red-200/90",
      }
    : warn
      ? {
          border: "border-amber-400/30",
          dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]",
          text: "text-amber-200/90",
        }
      : {
          border: "border-cyan-400/30",
          dot: "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]",
          text: "text-cyan-200/90",
        };
  return (
    <button
      type="button"
      onClick={() => openBillingPopup("/checkout")}
      title={t.app.trial.upgradeCta}
      className={cn(
        "flex items-center gap-2 rounded-full border bg-white/[0.04] px-3 py-1 backdrop-blur-md transition hover:brightness-125",
        palette.border,
      )}
    >
      <span className={cn("size-2 rounded-full", palette.dot)} />
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.18em]",
          palette.text,
        )}
      >
        {label}
      </span>
    </button>
  );
}
