import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// PRD D4: a payout batch is only created once a seller's eligible (held-out)
// balance reaches this floor — avoids dust disbursements + per-transfer Iris fees.
const PAYOUT_MIN_RP = 50_000;
import {
  isIrisConfigured,
  irisCreatePayout,
  IrisError,
  IrisNotConfiguredError,
} from "@/lib/iris";
import { auditLog } from "@/lib/security/audit-log";

// C3 Phase C — create a payout batch for ONE seller from its eligible ledger
// rows (status=pending, hold window elapsed), then submit it to Iris (CREATOR
// key). Admin-triggered, admin-only. A per-seller advisory lock serializes batch
// creation so two operators can't batch the same rows / mis-total. On an Iris
// failure the ledger rows are reverted to pending so nothing is stranded.
export const dynamic = "force-dynamic";

type PayoutInfo = {
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  email?: string;
};

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  // Money-movement op — rate-limit per admin even though it's admin-gated
  // (defense-in-depth, same posture as the rpc-test tool).
  const rl = take(keyFromRequest("admin.payout.batch", req, actor.id), 20, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  if (!isIrisConfigured())
    return Response.json({ error: "IRIS_NOT_CONFIGURED" }, { status: 503 });

  try {
    const body = (await req.json().catch(() => ({}))) as { sellerId?: unknown };
    const sellerId = typeof body.sellerId === "string" ? body.sellerId : "";
    if (!sellerId)
      return Response.json({ error: "INVALID_SELLER" }, { status: 400 });

    const [seller] = await db
      .select({
        id: schema.sellers.id,
        type: schema.sellers.type,
        status: schema.sellers.status,
        displayName: schema.sellers.displayName,
        payoutInfo: schema.sellers.payoutInfo,
      })
      .from(schema.sellers)
      .where(eq(schema.sellers.id, sellerId))
      .limit(1);
    if (!seller) return Response.json({ error: "SELLER_NOT_FOUND" }, { status: 404 });
    if (seller.type === "first_party")
      return Response.json({ error: "FIRST_PARTY_NO_PAYOUT" }, { status: 400 });
    // Never disburse to a frozen seller. Symmetric with the money-IN guard
    // (billing/listing rejects a non-active seller) — suspension exists exactly
    // to halt payout during a fraud/dispute/chargeback hold.
    if (seller.status !== "active")
      return Response.json({ error: "SELLER_SUSPENDED" }, { status: 400 });

    const pi = (seller.payoutInfo ?? {}) as PayoutInfo;
    if (!pi.bankCode || !pi.accountNumber || !pi.accountName)
      return Response.json({ error: "NO_BENEFICIARY" }, { status: 400 });

    const now = new Date();

    // Atomic + serialized per seller: select eligible rows, create the batch,
    // mark the rows batched — so a concurrent batch can't double-claim rows or
    // compute a stale total.
    const made = await db.transaction(async (dbtx) => {
      await dbtx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"payout:" + sellerId}))`,
      );
      const rows = await dbtx
        .select({ id: schema.payoutLedger.id, netRp: schema.payoutLedger.netRp })
        .from(schema.payoutLedger)
        .where(
          and(
            eq(schema.payoutLedger.sellerId, sellerId),
            eq(schema.payoutLedger.status, "pending"),
            lte(schema.payoutLedger.holdUntil, now),
          ),
        );
      if (rows.length === 0) return null;
      const totalNetRp = rows.reduce((a, r) => a + r.netRp, 0);
      // PRD D4 floor: leave the rows pending (don't batch) until they accumulate
      // to the minimum — they'll be swept into a future batch once the seller
      // crosses the threshold.
      if (totalNetRp < PAYOUT_MIN_RP)
        return { belowThreshold: true as const, totalNetRp };
      const ledgerIds = rows.map((r) => r.id);
      const [batch] = await dbtx
        .insert(schema.payoutBatches)
        .values({
          sellerId,
          totalNetRp,
          status: "created",
          createdBy: actor.id,
        })
        .returning({ id: schema.payoutBatches.id });
      await dbtx
        .update(schema.payoutLedger)
        .set({ status: "batched", batchId: batch.id, updatedAt: now })
        .where(
          and(
            inArray(schema.payoutLedger.id, ledgerIds),
            eq(schema.payoutLedger.status, "pending"),
          ),
        );
      return { batchId: batch.id, totalNetRp, ledgerIds };
    });

    if (!made)
      return Response.json({ error: "NOTHING_ELIGIBLE" }, { status: 400 });
    if ("belowThreshold" in made)
      return Response.json(
        { error: "BELOW_THRESHOLD", totalNetRp: made.totalNetRp, minRp: PAYOUT_MIN_RP },
        { status: 400 },
      );

    // Submit to Iris (CREATOR). reference_no = batch.id (idempotent at Iris).
    try {
      await irisCreatePayout([
        {
          beneficiary_name: pi.accountName,
          beneficiary_account: pi.accountNumber,
          beneficiary_bank: pi.bankCode,
          beneficiary_email: pi.email,
          amount: made.totalNetRp,
          notes: `AgentBuff payout ${seller.displayName}`.slice(0, 100),
          reference_no: made.batchId,
        },
      ]);
    } catch (e) {
      const code = e instanceof IrisNotConfiguredError ? "IRIS_NOT_CONFIGURED" : "IRIS_ERROR";
      const msg = e instanceof IrisError ? e.message : String(e);
      // Revert atomically: un-batch the rows so they can be retried + mark the
      // batch failed in one transaction (a crash between the two would otherwise
      // leave an inert 'created' batch — harmless but untidy).
      const revertNow = new Date();
      await db.transaction(async (dbtx) => {
        await dbtx
          .update(schema.payoutLedger)
          .set({ status: "pending", batchId: null, updatedAt: revertNow })
          .where(eq(schema.payoutLedger.batchId, made.batchId));
        await dbtx
          .update(schema.payoutBatches)
          .set({ status: "failed", lastError: msg.slice(0, 500), updatedAt: revertNow })
          .where(eq(schema.payoutBatches.id, made.batchId));
      });
      auditLog({
        event: "billing.payout.create",
        outcome: "error",
        actor: actor.id,
        target: made.batchId,
        details: { sellerId, code },
      });
      return Response.json({ error: code }, { status: code === "IRIS_NOT_CONFIGURED" ? 503 : 502 });
    }

    await db
      .update(schema.payoutBatches)
      .set({
        status: "submitted",
        irisReferenceNo: made.batchId,
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.payoutBatches.id, made.batchId));

    auditLog({
      event: "billing.payout.create",
      outcome: "ok",
      actor: actor.id,
      target: made.batchId,
      details: { sellerId, totalNetRp: made.totalNetRp, rows: made.ledgerIds.length },
    });
    return Response.json({ ok: true, batchId: made.batchId, totalNetRp: made.totalNetRp });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
