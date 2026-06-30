"use client";

import { PopupCheckout } from "../../_components/popup-checkout";

export function SkillCheckoutClient({
  skillKey,
  title,
  description,
  priceRp,
}: {
  skillKey: string;
  title: string;
  description: string;
  priceRp: number;
}) {
  return (
    <PopupCheckout
      product={{
        kind: "skill",
        title,
        subtitle: description,
        priceRp,
        meta: { skillKey },
      }}
      settleWhen="installed"
      initiate={async (paymentType) => {
        const r = await fetch("/api/billing/skill", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillKey, paymentType }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: "UNKNOWN" }));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      }}
    />
  );
}
