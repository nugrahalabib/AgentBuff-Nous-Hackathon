"use client";

import { useEffect, useRef } from "react";
import { Lock } from "lucide-react";
import { signOut } from "next-auth/react";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";
import { openBillingPopup } from "@/lib/app/billing-popup";
import { useI18n } from "@/lib/i18n/context";

// Full-screen blocking overlay shown over /app when access has lapsed and there
// is no active subscription (Chief's choice: overlay-over-app, not a redirect).
// Two lock reasons share this overlay: an ended 14-day trial ("trial") and a
// lapsed paid subscription ("subscription") — the badge/headline/body swap to
// match, but the pay CTA + logout are identical. The agent's container is also
// docker-stopped server-side, so this is the visible half of a hard lock — the
// user can only pay or sign out.
//
// Payment opens the billing page in a popup (same-origin, ?parent forwarded),
// falling back to a same-tab navigation if the popup is blocked.
//
// A11y: it's a hard paywall, so the dialog autofocuses the pay CTA, TRAPS Tab
// focus between the two actions (pay / logout), SWALLOWS Escape (no escape
// hatch out of the lock), and locks body scroll while mounted.

type LockReason = "trial" | "subscription";

export function TrialLockedOverlay({
  reason = "trial",
}: {
  reason?: LockReason;
}) {
  const { t } = useI18n();
  const base = t.trialLock;
  // Subscription-lapse swaps badge/headline/body; pay CTA + note + logout shared.
  const c =
    reason === "subscription"
      ? { ...base, ...base.subscription }
      : base;
  const payRef = useRef<HTMLButtonElement>(null);
  const logoutRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    payRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      // Hard paywall — Escape must NOT dismiss it.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = [payRef.current, logoutRef.current].filter(
        (el): el is HTMLButtonElement => el != null,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      const inTrap = focusables.includes(activeEl as HTMLButtonElement);
      if (e.shiftKey) {
        if (activeEl === first || !inTrap) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !inTrap) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        aria-hidden
        className="absolute inset-0 bg-[#030014]/85 backdrop-blur-xl"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trial-lock-headline"
        aria-describedby="trial-lock-body"
        className="relative w-full max-w-md"
      >
        <div
          aria-hidden
          className="absolute -inset-px rounded-[1.5rem] bg-gradient-to-br from-cyan-400/40 via-indigo-400/10 to-fuchsia-500/40 opacity-70 blur-[2px]"
        />
        <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#0B0E14]/95 p-7 text-center shadow-[0_40px_120px_-20px_rgba(8,145,178,0.5)]">
          <div className="mx-auto mb-4 inline-flex size-14 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/15">
            <Lock className="size-7 text-cyan-300" />
          </div>
          <span className="inline-block rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-200">
            {c.badge}
          </span>
          <h1
            id="trial-lock-headline"
            className="mt-4 font-display text-2xl font-bold leading-tight"
          >
            {c.headline}
          </h1>
          <p
            id="trial-lock-body"
            className="mt-2 text-[13px] leading-relaxed text-white/55"
          >
            {c.body}
          </p>

          <button
            ref={payRef}
            type="button"
            onClick={() => openBillingPopup("/checkout")}
            className="group relative mt-6 inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-5 py-3.5 text-sm font-bold text-white shadow-[0_12px_32px_-6px_rgba(99,102,241,0.55)] transition-all hover:brightness-110 active:scale-[0.99]"
          >
            <span
              aria-hidden
              className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
            />
            {c.payCta}
          </button>

          <p className="mt-3 text-[11px] text-white/40">{c.note}</p>

          <button
            ref={logoutRef}
            type="button"
            onClick={() => {
              clearAgentbuffClientState();
              signOut({ callbackUrl: "/" });
            }}
            className="mt-5 text-[12px] font-medium text-white/35 transition-colors hover:text-white/70"
          >
            {c.logoutLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
