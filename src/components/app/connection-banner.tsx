"use client";

import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";

/** Full-width banner that appears only when the connection is unhealthy.
 *  Stays hidden during `idle` / `connecting` (the first-paint connect is
 *  already obvious from the composer being disabled) and `ready` (green
 *  status pill is enough). `reconnecting` shows amber; `closed` shows red
 *  with a reload CTA. */
export function ConnectionBanner() {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);

  if (status !== "reconnecting" && status !== "closed") return null;

  const isClosed = status === "closed";

  return (
    <div
      role="status"
      className={
        isClosed
          ? "flex items-center justify-between gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200 backdrop-blur-md"
          : "flex items-center justify-between gap-3 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-200 backdrop-blur-md"
      }
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={
            isClosed
              ? "h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]"
              : "h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]"
          }
        />
        <span className="font-medium">
          {isClosed
            ? t.app.chat.banners.connClosedTitle
            : t.app.chat.banners.connReconnectingTitle}
        </span>
        <span className="hidden text-[11px] opacity-80 sm:inline">
          {isClosed
            ? t.app.chat.banners.connClosedHint
            : t.app.chat.banners.connReconnectingHint}
        </span>
      </div>
      {isClosed ? (
        <button
          type="button"
          onClick={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
          className="rounded-md border border-red-500/50 bg-red-500/20 px-2.5 py-1 text-[11px] font-medium text-red-100 transition hover:bg-red-500/30"
        >
          {t.app.chat.banners.reload}
        </button>
      ) : null}
    </div>
  );
}
