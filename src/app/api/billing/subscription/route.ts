import { eq, and, gt, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createSnapTransaction } from "@/lib/midtrans";
import {
  resolveEffectivePlanPrice,
  isTierBuyable,
} from "@/lib/billing/pricing-resolver";
import { reserveCoupon, computeDiscount, releaseCoupon } from "@/lib/billing/coupon";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";
import { isStaleSessionError } from "@/lib/billing/db-errors";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const createSubscriptionSchema = z.object({
  // Self-serve buyable tiers only. guild_master is enterprise/Spead-only,
  // rejected here + by isSubscribableTier below. No paymentType — Snap shows
  // ALL methods and the user picks inside the embedded widget.
  tier: z.enum(["op_buff"]),
  billingCycle: z.enum(["monthly", "yearly"]),
  // The price the client actually DISPLAYED at confirm time. When present, the
  // charge re-resolves the effective price and rejects (PRICE_CHANGED) on a
  // mismatch — so an admin price edit mid-session can never silently charge a
  // different amount than the user agreed to. Optional for backward-compat.
  expectedPriceRp: z.number().int().nonnegative().optional(),
  // Optional promo code; validated + applied server-side after the price guard.
  couponCode: z.string().trim().max(40).optional(),
});

const CHARGE_LIMIT = 30;
const CHARGE_WINDOW_MS = 10 * 60_000;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const [subscription] = await db
      .select()
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.userId, userId),
          inArray(schema.subscriptions.status, ["active", "canceled"]),
        ),
      );

    return Response.json(subscription ?? null);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Tracks a coupon reservation across the handler. Once the pending transaction
  // is recorded, the settle/fail path owns the release (via metadata.couponCode);
  // before that, an unexpected error in the outer catch must release it here so a
  // crash mid-charge never burns a coupon use.
  let reservedCoupon: string | null = null;
  let pendingTxRecorded = false;
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    const ip = clientIpFromRequest(req);

    const rl = take(
      keyFromRequest("billing.charge", req, userId),
      CHARGE_LIMIT,
      CHARGE_WINDOW_MS,
    );
    if (!rl.ok) {
      auditLog({
        event: "rate_limit.exceeded",
        outcome: "reject",
        actor: userId,
        ip,
        details: { ns: "billing.charge.subscription" },
      });
      return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    const body = await req.json();
    const parsed = createSubscriptionSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );

    const { tier, billingCycle, expectedPriceRp, couponCode } = parsed.data;
    // Buyability is admin-aware (D14): catalog selfServe AND effective status
    // "live". Lets an admin PAUSE op_buff sales (status -> coming_soon) without
    // code. Catalog selfServe + the zod enum above keep this op_buff-only.
    if (!(await isTierBuyable(tier)))
      return Response.json({ error: "TIER_NOT_AVAILABLE" }, { status: 400 });

    // Renewal IS allowed (the user can extend / switch cycle), but an enterprise
    // (guild_master) user must NOT self-serve buy a lower tier — that would be a
    // silent downgrade. Everyone else proceeds: settle.ts decides extend (active
    // op_buff renewal — stacks onto remaining paid time) vs reset (starter /
    // lapsed — counts from now). The resolver reports guild_master only while
    // that enterprise sub is effective.
    const current = await resolveSubscription(userId);
    if (current.tier === "guild_master")
      return Response.json({ error: "ALREADY_ENTERPRISE" }, { status: 409 });

    // Double-charge / double-extend guard. If a subscription charge for this
    // user is already in flight (a recent pending order), do NOT mint a second
    // one. Without this, a Snap widget-layer error after the card was actually
    // charged would let the user retry, and BOTH orders would settle — stacking
    // two periods AND charging twice. The renewal (extend) semantics make that
    // strictly worse than the old reset behavior, so we block it at the source.
    const RECENT_PENDING_MS = 15 * 60_000;
    const [pendingOrder] = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.type, "subscription"),
          eq(schema.transactions.status, "pending"),
          gt(
            schema.transactions.createdAt,
            new Date(Date.now() - RECENT_PENDING_MS),
          ),
        ),
      )
      .limit(1);
    if (pendingOrder) {
      return Response.json(
        { error: "PENDING_ORDER_EXISTS", transactionId: pendingOrder.id },
        { status: 409 },
      );
    }

    // Renewal = the user already holds an ACTIVE op_buff sub (vs a fresh
    // activation from starter / a reactivation after lapse). Only affects copy
    // here; the authoritative extend-vs-reset decision is made at settlement
    // against the live sub state (time passes between charge and settle).
    const isRenewal = current.status === "active" && current.tier === "op_buff";

    // Authoritative charge price = admin-effective (override > catalog default).
    const priceRp = await resolveEffectivePlanPrice(tier, billingCycle);

    // Money-safety: if the client sent the price it displayed and it no longer
    // matches (admin edited mid-session), refuse rather than charge a different
    // amount than the user saw. The client reloads to re-confirm the new price.
    if (expectedPriceRp !== undefined && expectedPriceRp !== priceRp) {
      return Response.json(
        { error: "PRICE_CHANGED", priceRp },
        { status: 409 },
      );
    }

    // Optional promo coupon. RESERVE atomically (enforces maxUses under
    // concurrency); the reservation is released if the charge call fails (below)
    // or the payment later lapses (markTransactionFailed). chargeAmount is what
    // we actually charge + record, so the settle amount cross-check still holds.
    let chargeAmount = priceRp;
    let discountRp = 0;
    if (couponCode) {
      const reserved = await reserveCoupon(couponCode, tier);
      if (!reserved)
        return Response.json({ error: "COUPON_INVALID" }, { status: 400 });
      reservedCoupon = couponCode;
      const split = computeDiscount(reserved, priceRp);
      if (split.finalRp <= 0) {
        // Midtrans can't charge 0 — a full-discount coupon isn't supported on the
        // paid path. Release the reservation and reject cleanly.
        await releaseCoupon(couponCode);
        reservedCoupon = null;
        return Response.json({ error: "COUPON_FULL_DISCOUNT" }, { status: 400 });
      }
      chargeAmount = split.finalRp;
      discountRp = split.discountRp;
    }

    const orderId = `SUB-${userId.slice(0, 8)}-${Date.now()}`;
    // Human-readable description used verbatim in the receipt email + PDF struk.
    const cycleLabel = billingCycle === "yearly" ? "tahunan" : "bulanan";
    const description = isRenewal
      ? `OP Buff - Perpanjang (${cycleLabel})`
      : `OP Buff (${cycleLabel})`;

    const [tx] = await db
      .insert(schema.transactions)
      .values({
        userId,
        type: "subscription",
        description,
        amountRp: chargeAmount,
        status: "pending",
        midtransOrderId: orderId,
        // The subscription row is created at SETTLEMENT from this metadata
        // (settle.ts activateSubscription), not here — so a settled payment
        // always yields an active sub, and unpaid retries never leave orphan
        // 'pending' subscription rows. couponCode is recorded so a lapsed payment
        // releases the reservation (markTransactionFailed).
        metadata: couponCode
          ? { tier, billingCycle, couponCode, discountRp }
          : { tier, billingCycle },
      })
      .returning({ id: schema.transactions.id });
    // Pending row now carries metadata.couponCode — release ownership passes to
    // the settle/fail path; the outer catch must NOT release after this point.
    pendingTxRecorded = true;

    // If the charge call fails, mark the just-inserted row 'failed' so it can't
    // sit 'pending' forever — no Midtrans webhook will ever resolve an order
    // that was never registered. Keeps reconciliation clean.
    // One Snap token = every payment method enabled in the Midtrans dashboard.
    // Settlement still arrives via the same /api/billing/webhook.
    let snapTx: Awaited<ReturnType<typeof createSnapTransaction>>;
    try {
      snapTx = await createSnapTransaction({
        orderId,
        grossAmount: chargeAmount,
        customerEmail: session.user.email ?? undefined,
        itemDetails: [{ id: tier, price: chargeAmount, quantity: 1, name: description }],
      });
    } catch {
      await db
        .update(schema.transactions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(schema.transactions.id, tx.id));
      // Charge never registered — release the coupon reservation. The tx is now
      // 'failed', so the settle/fail path won't double-release.
      if (reservedCoupon) {
        await releaseCoupon(reservedCoupon);
        reservedCoupon = null;
      }
      return Response.json({ error: "CHARGE_FAILED" }, { status: 502 });
    }

    auditLog({
      event: "billing.charge.create",
      outcome: "ok",
      actor: userId,
      target: orderId,
      ip,
      details: { kind: "subscription", tier, billingCycle, amountRp: chargeAmount, couponCode: couponCode ?? null, discountRp },
    });

    return Response.json({
      token: snapTx.token,
      redirectUrl: snapTx.redirect_url,
      transactionId: tx.id,
    });
  } catch (e) {
    // An error before the pending tx was recorded leaks the coupon reservation
    // (no metadata row exists for markTransactionFailed to release). Give it back
    // here. Best-effort: a release failure must not mask the original error.
    if (reservedCoupon && !pendingTxRecorded) {
      await releaseCoupon(reservedCoupon).catch(() => {});
    }
    // A stale auth session (the JWT carries a user id that was removed from the
    // DB in a past reset) trips the transaction.user_id foreign key. Surface
    // that as an auth problem so the client can re-login, instead of a 500.
    if (isStaleSessionError(e)) {
      return Response.json({ error: "SESSION_INVALID" }, { status: 401 });
    }
    console.error("[subscription POST]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
