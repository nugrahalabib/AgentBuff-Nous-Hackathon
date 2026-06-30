import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { hermesConfig } from "@/lib/hermes/config";
import { EnergyCheckoutClient } from "./energy-checkout-client";

export const dynamic = "force-dynamic";

export default async function EnergyBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    const sp = await searchParams;
    const parent = typeof sp.parent === "string" ? sp.parent : "";
    const next = `/billing/energy?parent=${encodeURIComponent(parent)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(next)}`);
  }

  // Energy system is OFF in the BYOK phase. The whole top-up surface stays
  // hidden behind the engine's energy flag so no real money is taken for a
  // feature that does nothing. Flip HERMES_ENERGY_GATE_ENABLED=true to enable.
  if (!hermesConfig.energyGateEnabled) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center space-y-2">
        <h1 className="text-lg font-display text-white">Energy - Segera Hadir</h1>
        <p className="text-sm text-white/60">
          Sistem Energy belum aktif. Saat ini AgentBuff pakai API key kamu
          sendiri (BYOK), jadi belum ada top-up Energy. Nantikan ya!
        </p>
      </div>
    );
  }

  return <EnergyCheckoutClient />;
}
