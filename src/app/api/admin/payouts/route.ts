import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { isIrisConfigured } from "@/lib/iris";

// C3 Phase C — payout admin view. Lists the commission ledger (grouped by seller
// client-side) + recent disbursement batches. `configured` tells the UI whether
// live Iris payout is wired (else create/approve are disabled). Read =
// admin/support.
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const now = Date.now();
    const ledgerRows = await db
      .select({
        id: schema.payoutLedger.id,
        sellerId: schema.payoutLedger.sellerId,
        sellerName: schema.sellers.displayName,
        listingId: schema.payoutLedger.listingId,
        grossRp: schema.payoutLedger.grossRp,
        commissionRp: schema.payoutLedger.commissionRp,
        netRp: schema.payoutLedger.netRp,
        period: schema.payoutLedger.period,
        holdUntil: schema.payoutLedger.holdUntil,
        status: schema.payoutLedger.status,
        batchId: schema.payoutLedger.batchId,
      })
      .from(schema.payoutLedger)
      .leftJoin(
        schema.sellers,
        eq(schema.payoutLedger.sellerId, schema.sellers.id),
      )
      .where(
        inArray(schema.payoutLedger.status, ["pending", "batched", "paid", "failed"]),
      )
      .orderBy(desc(schema.payoutLedger.createdAt))
      .limit(500);

    const batches = await db
      .select({
        id: schema.payoutBatches.id,
        sellerId: schema.payoutBatches.sellerId,
        sellerName: schema.sellers.displayName,
        totalNetRp: schema.payoutBatches.totalNetRp,
        status: schema.payoutBatches.status,
        createdBy: schema.payoutBatches.createdBy,
        approvedBy: schema.payoutBatches.approvedBy,
        submittedAt: schema.payoutBatches.submittedAt,
        approvedAt: schema.payoutBatches.approvedAt,
        completedAt: schema.payoutBatches.completedAt,
        lastError: schema.payoutBatches.lastError,
        createdAt: schema.payoutBatches.createdAt,
      })
      .from(schema.payoutBatches)
      .leftJoin(
        schema.sellers,
        eq(schema.payoutBatches.sellerId, schema.sellers.id),
      )
      .orderBy(desc(schema.payoutBatches.createdAt))
      .limit(200);

    const ledger = ledgerRows.map((r) => ({
      ...r,
      eligible: r.status === "pending" && r.holdUntil.getTime() <= now,
    }));

    return Response.json({ configured: isIrisConfigured(), ledger, batches });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
