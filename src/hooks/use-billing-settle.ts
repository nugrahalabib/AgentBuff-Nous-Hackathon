"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

// Mounted ONCE high in the /app tree (AppShell). Listens for the billing
// popup's settle signal and refreshes everything so a JUST-PAID user sees their
// new state WITHOUT a manual reload — the trial overlay drops, the tier badge
// flips, the countdown pill disappears, energy/balance updates.
//
// Contract (verified against the popup checkout + shop-tab):
//   postMessage({ source: "agentbuff-billing", event: "billing:settled" })
//   validated by ev.origin === window.location.origin (popup posts to the
//   parent origin it received via ?parent + validateParentOrigin).
const SETTLE_QUERY_KEYS: readonly string[][] = [
  ["subscription-state"],
  ["subscription"],
  ["energy"],
  ["profile"],
];

export function useBillingSettleListener(): void {
  const qc = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; event?: string } | null;
      if (data?.source !== "agentbuff-billing" || data.event !== "billing:settled") {
        return;
      }
      for (const queryKey of SETTLE_QUERY_KEYS) {
        void qc.invalidateQueries({ queryKey });
      }
      // Re-run the server layout → resolveAccessState re-evaluates: now
      // subscribed → trial overlay + countdown pill both vanish. This is what
      // makes the post-pay transition feel instant, no reload.
      router.refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [qc, router]);
}
