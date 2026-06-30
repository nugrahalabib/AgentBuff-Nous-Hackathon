// Promo coupon logic (D10/D14). validate (read-only preview) + computeDiscount,
// plus the atomic reserve/release used by the charge path so maxUses holds under
// concurrent redemptions.
//
// NO `import "server-only"`: releaseCoupon is reached from markTransactionFailed
// (settle.ts) which runs in the plain-Node worker chain (reconcile-worker).
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type CouponRow = typeof schema.coupons.$inferSelect;

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().slice(0, 40);
}

export type CouponError =
  | "NOT_FOUND"
  | "INACTIVE"
  | "EXPIRED"
  | "EXHAUSTED"
  | "TIER_MISMATCH";

/** Read-only check (no reservation) — for the checkout preview. */
export async function validateCoupon(
  rawCode: string,
  tier: string,
  exec: Executor = db,
): Promise<{ ok: true; coupon: CouponRow } | { ok: false; error: CouponError }> {
  const code = normalizeCode(rawCode);
  const [c] = await exec
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.code, code))
    .limit(1);
  if (!c) return { ok: false, error: "NOT_FOUND" };
  if (!c.active) return { ok: false, error: "INACTIVE" };
  if (c.expiresAt && c.expiresAt.getTime() <= Date.now())
    return { ok: false, error: "EXPIRED" };
  if (c.maxUses != null && c.used >= c.maxUses)
    return { ok: false, error: "EXHAUSTED" };
  if (c.tierScope && c.tierScope !== tier)
    return { ok: false, error: "TIER_MISMATCH" };
  return { ok: true, coupon: c };
}

/** Discount + final amount. Discount is capped at the amount (never negative). */
export function computeDiscount(
  coupon: Pick<CouponRow, "type" | "value">,
  amountRp: number,
): { discountRp: number; finalRp: number } {
  const raw =
    coupon.type === "percent"
      ? Math.floor((amountRp * coupon.value) / 100)
      : coupon.value;
  const discountRp = Math.max(0, Math.min(raw, amountRp));
  return { discountRp, finalRp: amountRp - discountRp };
}

/**
 * Atomically RESERVE one use: increments `used` only if the coupon is still
 * active, unexpired, under maxUses, and tier-scoped right. Returns the coupon
 * (post-increment) or null if it could not be reserved. This single conditional
 * UPDATE is the maxUses race guard.
 */
export async function reserveCoupon(
  rawCode: string,
  tier: string,
  exec: Executor = db,
): Promise<CouponRow | null> {
  const code = normalizeCode(rawCode);
  const now = new Date();
  const [row] = await exec
    .update(schema.coupons)
    .set({ used: sql`${schema.coupons.used} + 1`, updatedAt: now })
    .where(
      and(
        eq(schema.coupons.code, code),
        eq(schema.coupons.active, true),
        or(
          isNull(schema.coupons.maxUses),
          lt(schema.coupons.used, schema.coupons.maxUses),
        ),
        or(isNull(schema.coupons.expiresAt), gt(schema.coupons.expiresAt, now)),
        or(
          isNull(schema.coupons.tierScope),
          eq(schema.coupons.tierScope, ""),
          eq(schema.coupons.tierScope, tier),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Release a reservation (charge failed / payment lapsed). Floors at 0. */
export async function releaseCoupon(
  rawCode: string,
  exec: Executor = db,
): Promise<void> {
  const code = normalizeCode(rawCode);
  await exec
    .update(schema.coupons)
    .set({
      used: sql`GREATEST(0, ${schema.coupons.used} - 1)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.coupons.code, code));
}
