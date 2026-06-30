"use client";

import { useState } from "react";
import { AlertTriangle, Trash2, Loader2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// Account deletion — the irreversible action. Always-visible "danger zone" card
// at the bottom of Settings (GitHub/Vercel convention) + a type-to-confirm modal
// so it can't be triggered by a stray click. Warns explicitly that re-registering
// the same email will NOT grant the 14-day trial again (the one-time-trial ledger
// in the complete-onboarding route enforces that server-side).
export function DangerZone() {
  const { t } = useI18n();
  const d = t.app.settings.danger;
  const warns = [d.warn1, d.warn2, d.warn3];

  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm =
    confirmText.trim().toUpperCase() === d.confirmWord.toUpperCase();

  const close = () => {
    if (deleting) return;
    setOpen(false);
    setConfirmText("");
    setError(null);
  };

  const doDelete = async () => {
    if (!canConfirm || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch("/api/account/delete", {
        method: "POST",
        credentials: "include",
      });
      if (r.status === 429) {
        setError(d.rateLimited);
        setDeleting(false);
        return;
      }
      if (!r.ok) {
        setError(d.error);
        setDeleting(false);
        return;
      }
      // Account + container gone, session signed out server-side. A full nav to
      // the landing page tears down all in-memory client state.
      window.location.href = "/";
    } catch {
      setError(d.error);
      setDeleting(false);
    }
  };

  return (
    <section className="scroll-mt-4 overflow-hidden rounded-2xl border border-red-500/30 bg-red-500/[0.04] backdrop-blur-xl">
      <div className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <AlertTriangle className="size-4 text-red-400" />
          <h2 className="text-base font-semibold text-red-100">{d.title}</h2>
        </div>
        <p className="mb-4 text-xs text-white/45">{d.desc}</p>

        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/[0.05] p-3.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-red-300/80">
            {d.warnTitle}
          </p>
          <ul className="space-y-1.5 text-sm text-white/70">
            {warns.map((w, i) => (
              <li key={w} className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-red-400/70">•</span>
                <span className={cn(i === 2 && "font-semibold text-red-100")}>
                  {w}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-500/25"
        >
          <Trash2 className="size-4" />
          {d.deleteBtn}
        </button>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0B0E14] p-6 shadow-[0_30px_120px_-40px_rgba(239,68,68,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-red-400" />
                <h3 className="font-display text-lg font-bold text-white">
                  {d.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label={d.cancel}
                className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>
            <ul className="mb-4 space-y-1.5 text-sm text-white/75">
              {warns.map((w, i) => (
                <li key={w} className="flex gap-2">
                  <span className="mt-0.5 shrink-0 text-red-400/70">•</span>
                  <span className={cn(i === 2 && "font-semibold text-red-100")}>
                    {w}
                  </span>
                </li>
              ))}
            </ul>
            <label className="mb-1.5 block text-xs text-white/55">
              {d.confirmHint}
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={d.confirmPlaceholder}
              autoFocus
              disabled={deleting}
              className="mb-3 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-red-500/50 disabled:opacity-50"
            />
            {error ? <p className="mb-3 text-sm text-red-300">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={deleting}
                className="rounded-xl px-4 py-2 text-sm text-white/60 transition hover:text-white disabled:opacity-50"
              >
                {d.cancel}
              </button>
              <button
                type="button"
                onClick={() => void doDelete()}
                disabled={!canConfirm || deleting}
                className="inline-flex items-center gap-2 rounded-xl bg-red-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                {deleting ? d.deleting : d.confirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
