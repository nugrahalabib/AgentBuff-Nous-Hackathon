import { resolveEffectivePlans } from "@/lib/billing/pricing-resolver";

// Public effective-pricing feed for CLIENT display surfaces (landing item-shop,
// in-app shop tab) via usePricing(). The CHARGE path does NOT trust this — it
// re-resolves server-side and confirms the client's shown price (PRICE_CHANGED).
// Browser-cached 30s to match the resolveSetting TTL: that 30s is the documented
// eventual-consistency window for an admin price edit to reach display.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const plans = await resolveEffectivePlans();
    return Response.json(
      { plans },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
        },
      },
    );
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
