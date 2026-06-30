import { eq, and, gt, desc, inArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { isStaleSessionError } from "@/lib/billing/db-errors";

// Cancel = stop here, but KEEP paid access until expiresAt. op_buff is a
// one-time per-period charge (autoRenew already false), so "cancel" must never
// forfeit days the user already paid for — the resolver treats a 'canceled' row
// as the active tier until it expires, then degrades to starter.
//
// The freeze / discount-retention branch was removed: it wrote status:'frozen'
// that the resolver never recognized (split-brain → silently 'starter') and had
// no unfreeze→active transition anywhere (one-way trap). Re-introduce only with
// a designed lifecycle.
export async function PUT() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    // Serialize with settlement (same advisory lock used by settle.ts) so a
    // payment landing at the same instant can't be silently clobbered, and we
    // always read+write fresh state. "Has paid access" = active OR
    // canceled-but-not-yet-expired (the resolver's definition) — a re-cancel of
    // an already-canceled-not-expired row is idempotent.
    const result = await db.transaction(async (dbtx) => {
      await dbtx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

      const [subscription] = await dbtx
        .select()
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, userId),
            inArray(schema.subscriptions.status, ["active", "canceled"]),
            gt(schema.subscriptions.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(schema.subscriptions.createdAt))
        .limit(1);

      if (!subscription) return { ok: false as const };
      const wasActive = subscription.status === "active";

      await dbtx
        .update(schema.subscriptions)
        .set({ status: "canceled", autoRenew: false, updatedAt: new Date() })
        .where(eq(schema.subscriptions.id, subscription.id));
      // F4 subscription lifecycle history (atomic with the cancel).
      await dbtx.insert(schema.subscriptionHistory).values({
        userId,
        subscriptionId: subscription.id,
        fromTier: subscription.tier,
        toTier: subscription.tier,
        fromStatus: subscription.status,
        toStatus: "canceled",
        reason: "user_cancel",
      });
      return { ok: true as const, wasActive };
    });

    if (!result.ok)
      return Response.json({ error: "NO_ACTIVE_SUBSCRIPTION" }, { status: 404 });

    // Notify only on a real active -> canceled transition (re-cancel = no-op).
    if (result.wasActive) {
      await db.insert(schema.notifications).values({
        userId,
        tab: "system",
        icon: "x-circle",
        text: "Langganan dibatalkan. Akses tetap aktif sampai masa berlaku habis.",
        highPriority: true,
      });
    }

    return Response.json({ status: "canceled" });
  } catch (e) {
    if (isStaleSessionError(e))
      return Response.json({ error: "SESSION_INVALID" }, { status: 401 });
    console.error("[subscription cancel]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
