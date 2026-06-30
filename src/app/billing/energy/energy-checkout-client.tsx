"use client";

import { useEffect, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { PopupCheckout } from "../_components/popup-checkout";

type Bundle = {
  id: string;
  name: string;
  energy: number;
  bonusEnergy: number;
  priceRp: number;
};

function formatRp(n: number) {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

export function EnergyCheckoutClient() {
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Bundle | null>(null);

  useEffect(() => {
    fetch("/api/billing/bundles", { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Bundle[];
      })
      .then((rows) => setBundles(rows))
      .catch((e) => setErr(e instanceof Error ? e.message : "Gagal memuat bundle."));
  }, []);

  if (selected) {
    const total = selected.energy + selected.bonusEnergy;
    return (
      <PopupCheckout
        product={{
          kind: "topup",
          title: selected.name,
          subtitle: `+${total} ⚡ Energy${selected.bonusEnergy > 0 ? ` (${selected.energy} + ${selected.bonusEnergy} bonus)` : ""}`,
          priceRp: selected.priceRp,
          meta: { bundleId: selected.id, energyDelta: total },
        }}
        settleWhen="completed"
        initiate={async (paymentType) => {
          const r = await fetch("/api/billing/energy/topup", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bundleId: selected.id, paymentType }),
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

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Zap className="size-4 text-amber-300" />
        <h1 className="text-lg font-display text-white">Energy Vault</h1>
      </div>
      <p className="text-sm text-white/60">
        Pilih bundle buat top up energy. Makin gede, makin banyak bonus.
      </p>
      {err ? (
        <div className="text-sm text-red-300">{err}</div>
      ) : !bundles ? (
        <div className="flex items-center gap-2 text-white/50 text-sm py-6 justify-center">
          <Loader2 className="size-4 animate-spin" />
          Loading...
        </div>
      ) : (
        <div className="space-y-2">
          {bundles.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected(b)}
              className="w-full text-left rounded-xl border border-white/10 bg-white/[0.02] hover:border-cyan-400/40 p-3 transition"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-display">{b.name}</div>
                  <div className="text-xs text-white/50">
                    {b.energy} ⚡
                    {b.bonusEnergy > 0 ? ` + ${b.bonusEnergy} bonus` : ""}
                  </div>
                </div>
                <div className="text-sm text-cyan-300 font-display">{formatRp(b.priceRp)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
