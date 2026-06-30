"use client";

// Demo EARN-beat notification (hackathon Babak 1). A top-center toast that slides
// in when triggered, showing the agent "earned" money (a skill the user published
// was bought). For the demo it's fired by clicking the sidebar "Upgrade now" button
// (see triggerDemoEarn) so the presenter has a one-click cue. Auto-dismisses.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, TrendingUp, Sparkles } from "lucide-react";

export const DEMO_EARN_EVENT = "agentbuff:demo-earn";

/** Show the EARN toast AND fire the real Stripe income charge (Babak 1).
 *  Each click fires exactly one charge — predictable "click → Stripe updates".
 *  Wipe accumulated test charges via Stripe's "Delete all test data" before the
 *  final recording, then do one clean run. */
export function triggerDemoEarn(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEMO_EARN_EVENT));
  void fetch("/api/me/demo-earn", { method: "POST", credentials: "same-origin" }).catch(
    () => {},
  );
}

export function DemoEarnNotification() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const onEarn = () => {
      setShow(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShow(false), 7000);
    };
    window.addEventListener(DEMO_EARN_EVENT, onEarn);
    return () => {
      window.removeEventListener(DEMO_EARN_EVENT, onEarn);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
      <AnimatePresence>
        {show ? (
          <motion.div
            initial={{ opacity: 0, y: -24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 280, damping: 24 }}
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative flex w-full max-w-md items-center gap-3 overflow-hidden rounded-2xl border border-emerald-400/40 bg-[#0B0E14]/90 px-4 py-3 shadow-[0_0_50px_-10px_rgba(16,185,129,0.6)] ring-1 ring-emerald-400/30 backdrop-blur-xl"
          >
            <div
              className="pointer-events-none absolute -left-8 -top-8 size-24 rounded-full bg-emerald-400/20 blur-2xl"
              aria-hidden
            />
            <motion.span
              initial={{ scale: 0, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 340, damping: 16, delay: 0.06 }}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300"
            >
              <TrendingUp className="size-5" aria-hidden />
            </motion.span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-emerald-300/80">
                  Income received
                </span>
                <Sparkles className="size-3 text-emerald-300/70" aria-hidden />
              </div>
              <p className="mt-0.5 text-[13.5px] leading-snug text-white/90">
                <span className="font-bold text-emerald-200">+Rp 99.000</span> — someone bought your{" "}
                <span className="font-semibold text-white">&ldquo;Researcher Analyst&rdquo;</span> skill on BuffHub.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShow(false)}
              aria-label="Dismiss"
              className="shrink-0 self-start rounded-lg p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
            >
              <X className="size-4" aria-hidden />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
