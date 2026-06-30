import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { validateCoupon, computeDiscount } from "@/lib/billing/coupon";
import { resolveEffectivePlanPrice } from "@/lib/billing/pricing-resolver";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// Read-only coupon preview for the checkout UI (no reservation). The authoritative
// validate + reserve happens at the charge route. Rate-limited to blunt code
// enumeration.
const schema = z.object({
  code: z.string().trim().min(1).max(40),
  tier: z.enum(["op_buff"]),
  billingCycle: z.enum(["monthly", "yearly"]),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const rl = take(keyFromRequest("coupon.validate", req, session.user.id), 20, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    const { code, tier, billingCycle } = parsed.data;

    const v = await validateCoupon(code, tier);
    if (!v.ok) return Response.json({ valid: false, error: v.error });

    const basePrice = await resolveEffectivePlanPrice(tier, billingCycle);
    const { discountRp, finalRp } = computeDiscount(v.coupon, basePrice);
    if (finalRp <= 0)
      return Response.json({ valid: false, error: "FULL_DISCOUNT" });

    return Response.json({ valid: true, basePrice, discountRp, finalRp });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
