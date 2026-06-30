"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useTrialClock } from "@/lib/app/use-trial-clock";
import { openBillingPopup } from "@/lib/app/billing-popup";
import type { TrialInfo } from "@/lib/billing/trial-resolver";
import { cn } from "@/lib/utils";

// Per-browser dismiss for the H-3 (amber) warning only. The H-1 (red) urgent
// banner is NON-dismissible — last-day nudge must stay. Persisted in
// localStorage so a reload keeps the amber banner dismissed for that user.
const DISMISS_KEY = "agentbuff:app:trial-banner-dismissed:h3";

export function TrialBanner({ trial }: { trial: TrialInfo | null }) {
  const { t } = useI18n();
  // Hooks unconditional (before any early return). When trial is null the clock
  // gets undefined endsAt → just returns 0, no interval.
  const days = useTrialClock(trial?.endsAt, trial?.daysLeft ?? 0);
  // Lazy initializer (not an effect) — SSR-guarded so server renders false and
  // the client seeds from localStorage on first render. Avoids set-state-in-effect.
  const [dismissedH3, setDismissedH3] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (!trial || days >= 4) return null;
  const urgent = days <= 1;
  if (!urgent && dismissedH3) return null;

  const body = urgent
    ? t.app.trial.bannerUrgentBody
    : t.app.trial.bannerWarnBody.replace("{n}", String(days));

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* quota — non-fatal */
    }
    setDismissedH3(true);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-5 py-2.5 text-sm backdrop-blur-md",
        urgent
          ? "border-red-500/40 bg-red-500/10 text-red-100"
          : "border-amber-400/30 bg-amber-400/10 text-amber-100",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          urgent
            ? "bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse"
            : "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]",
        )}
      />
      <span className="min-w-0 flex-1">{body}</span>
      <button
        type="button"
        onClick={() => openBillingPopup("/checkout")}
        className={cn(
          "shrink-0 rounded-md px-3 py-1 text-xs font-semibold transition",
          urgent
            ? "bg-red-500/25 text-red-50 hover:bg-red-500/35"
            : "bg-amber-400/25 text-amber-50 hover:bg-amber-400/35",
        )}
      >
        {t.app.trial.upgradeCta}
      </button>
      {!urgent ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.app.trial.dismiss}
          className="shrink-0 rounded p-1 text-white/55 transition hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
