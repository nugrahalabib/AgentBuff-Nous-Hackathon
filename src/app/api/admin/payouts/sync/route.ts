import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { isIrisConfigured, irisGetPayout } from "@/lib/iris";
import { auditLog } from "@/lib/security/audit-log";

// C3 Phase C — poll Iris for in-flight batches and reconcile DB state:
//   completed        -> batch completed, ledger rows paid
//   failed/rejected  -> batch failed, ledger rows reverted to pending (re-eligible)
//   else (queued/processing) -> unchanged
// Admin-triggered, admin-only.
export const dynamic = "force-dynamic";

export async function POST() {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  if (!isIrisConfigured())
    return Response.json({ error: "IRIS_NOT_CONFIGURED" }, { status: 503 });

  try {
    const batches = await db
      .select({
        id: schema.payoutBatches.id,
        irisReferenceNo: schema.payoutBatches.irisReferenceNo,
      })
      .from(schema.payoutBatches)
      .where(inArray(schema.payoutBatches.status, ["submitted", "approved"]))
      // Oldest in-flight first so a backlog >100 never starves older batches
      // from ever being reconciled with Iris.
      .orderBy(asc(schema.payoutBatches.createdAt))
      .limit(100);

    let completed = 0;
    let failed = 0;
    const now = new Date();

    for (const b of batches) {
      const ref = b.irisReferenceNo ?? b.id;
      let irisStatus: string | undefined;
      try {
        irisStatus = (await irisGetPayout(ref)).status?.toLowerCase();
      } catch {
        continue; // transient — leave for the next sweep
      }
      if (!irisStatus) continue;

      if (irisStatus === "completed") {
        // Atomic: batch + its ledger rows flip together, so a crash can't strand
        // a paid seller's ledger at 'batched'.
        await db.transaction(async (dbtx) => {
          await dbtx
            .update(schema.payoutBatches)
            .set({ status: "completed", completedAt: now, lastError: null, updatedAt: now })
            .where(eq(schema.payoutBatches.id, b.id));
          await dbtx
            .update(schema.payoutLedger)
            .set({ status: "paid", updatedAt: now })
            .where(eq(schema.payoutLedger.batchId, b.id));
        });
        completed++;
      } else if (irisStatus === "failed" || irisStatus === "rejected") {
        await db.transaction(async (dbtx) => {
          await dbtx
            .update(schema.payoutBatches)
            .set({
              status: "failed",
              lastError: `iris status=${irisStatus}`,
              updatedAt: now,
            })
            .where(eq(schema.payoutBatches.id, b.id));
          // Money did NOT move — return rows to the eligible pool.
          await dbtx
            .update(schema.payoutLedger)
            .set({ status: "pending", batchId: null, updatedAt: now })
            .where(eq(schema.payoutLedger.batchId, b.id));
        });
        failed++;
      }
    }

    auditLog({
      event: "billing.payout.sync",
      outcome: "ok",
      actor: actor.id,
      details: { checked: batches.length, completed, failed },
    });
    return Response.json({ ok: true, checked: batches.length, completed, failed });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
