import { count, eq, inArray, sum } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// Admin revenue metrics (D2). Read-only — admin AND support may read.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    // MRR estimate: active subscriptions normalized to a monthly figure.
    const activeSubs = await db
      .select({
        priceRp: schema.subscriptions.priceRp,
        billingCycle: schema.subscriptions.billingCycle,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.status, "active"));
    let mrr = 0;
    for (const s of activeSubs) {
      mrr += s.billingCycle === "yearly" ? Math.round(s.priceRp / 12) : s.priceRp;
    }

    const [revenue] = await db
      .select({ total: sum(schema.transactions.amountRp) })
      .from(schema.transactions)
      .where(inArray(schema.transactions.status, ["completed", "installed"]));
    const [pendingC] = await db
      .select({ c: count() })
      .from(schema.transactions)
      .where(eq(schema.transactions.status, "pending"));
    const [refunded] = await db
      .select({ total: sum(schema.transactions.amountRp) })
      .from(schema.transactions)
      .where(eq(schema.transactions.status, "refunded"));
    // Paid-but-undelivered: Midtrans captured the money but the skill never
    // installed (install_failed). Surfaced as its own bucket so this collected
    // cash is never invisible — the operator refunds it (-> refundedTotal) or
    // investigates. NOT folded into revenueCompleted: the service was not
    // delivered, so it is not recognized revenue.
    const [undelivered] = await db
      .select({ total: sum(schema.transactions.amountRp), c: count() })
      .from(schema.transactions)
      .where(eq(schema.transactions.status, "install_failed"));

    // ARPU (D2) — average recurring revenue per active subscriber. Derived from
    // the MRR + active-sub count we already computed; 0 when there are no subs.
    const arpu =
      activeSubs.length > 0 ? Math.round(mrr / activeSubs.length) : 0;

    return Response.json({
      mrr,
      arpu,
      activeSubs: activeSubs.length,
      revenueCompleted: Number(revenue?.total ?? 0),
      pendingCount: pendingC?.c ?? 0,
      refundedTotal: Number(refunded?.total ?? 0),
      undeliveredTotal: Number(undelivered?.total ?? 0),
      undeliveredCount: undelivered?.c ?? 0,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
