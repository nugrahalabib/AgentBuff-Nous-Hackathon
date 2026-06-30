import { auth } from "@/lib/auth.config";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";
import { resolveEffectivePlan } from "@/lib/billing/pricing-resolver";
import { CheckoutClient } from "./checkout-client";

export const dynamic = "force-dynamic";

// Exclusive subscription checkout. Guests see a "register first" panel
// (Google); members see the plan + the embedded Snap widget (ALL payment
// methods). `?cycle=` deep-links monthly/yearly from the entry points.
//
// The current sub state is resolved server-side so the page can reframe itself:
// an ACTIVE op_buff member sees "Perpanjang" (extend), a lapsed member sees
// "Aktifkan lagi" (reset), an enterprise member is told they already have a
// higher tier (no charge), and a fresh/trial user sees "Aktifkan". This is why
// an already-subscribed user no longer lands on a plain "buy again" surface.
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const cycle = sp.cycle === "yearly" ? "yearly" : "monthly";
  const session = await auth();
  const userId = session?.user?.id ?? null;
  const [sub, opBuff] = await Promise.all([
    userId ? resolveSubscription(userId) : Promise.resolve(null),
    resolveEffectivePlan("op_buff"),
  ]);
  return (
    <CheckoutClient
      isAuthed={Boolean(userId)}
      initialCycle={cycle}
      currentTier={sub?.tier ?? null}
      currentStatus={sub?.status ?? null}
      currentExpiresAt={sub?.expiresAt ?? null}
      // Admin-effective OP Buff prices resolved server-side (no client flash;
      // deterministic for the money-safety confirm). The same resolver backs the
      // charge route, so display == charge barring a mid-session admin edit
      // (which the PRICE_CHANGED guard catches).
      priceMonthly={opBuff.priceMonthly ?? 0}
      priceYearly={opBuff.priceYearly ?? 0}
    />
  );
}
