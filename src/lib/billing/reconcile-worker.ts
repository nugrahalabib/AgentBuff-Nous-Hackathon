import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";
import { getTransactionStatus, verifySignature } from "@/lib/midtrans";
import { applySettlement, markTransactionFailed } from "@/lib/billing/settle";
import { midtransMethodString } from "@/lib/billing/payment-method";
import { auditLog } from "@/lib/security/audit-log";

// Reconcile-worker — the safety net for LOST or late Midtrans webhooks. The
// checkout popup only polls OUR DB, so if a settlement notification never
// arrives (network flap, out-of-sequence delivery, dashboard URL not set), a
// PAID transaction would be stuck 'pending' forever and the user would never
// get what they paid for. Official Midtrans docs name Get-Status as the
// "critical safeguard" for exactly this.
//
// Each tick: find transactions pending > STALE_MS, call Get-Status, verify the
// response signature, then converge via the SHARED settle module (same
// idempotent effect as the webhook). Transactions still pending after MAX_AGE
// are marked failed so we stop polling them forever.

const SETTLED = new Set(["settlement", "capture"]);
const CANCELED = new Set(["deny", "cancel", "expire", "failure"]);

const STALE_MS = 2 * 60_000; // only poll pending older than 2 min
const MAX_AGE_MS = 24 * 60 * 60_000; // abandon (mark failed) after 24h
const INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AGENTBUFF_RECONCILE_INTERVAL_MS ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000; // 5 min default
})();

// Exported so the on-demand reconcile endpoint
// (POST /api/billing/transactions/[id]/reconcile) can run the EXACT same
// idempotent path the background worker uses — Get-Status -> verify signature ->
// shared applySettlement / markTransactionFailed. The on-demand call is the fast
// path (settles within seconds of the user paying); the worker is the safety net.
export async function reconcileOne(orderId: string): Promise<void> {
  let status;
  try {
    status = await getTransactionStatus(orderId);
  } catch (e) {
    // 404 = never reached Midtrans (charge-create failed) — leave it; once it
    // ages past MAX_AGE the sweep marks it failed.
    console.error("[reconcile] getTransactionStatus failed for", orderId, e);
    return;
  }
  // A 404 / error response (order never reached Midtrans — e.g. charge-create
  // failed, or a stale test order) has no transaction_status AND no
  // signature_key. Don't run the signature check on it; leave it for MAX_AGE
  // abandonment instead of logging a misleading signature_mismatch every tick.
  if (!status?.transaction_status) {
    return;
  }
  // Verify the Get-Status response signature too (same SHA512 formula).
  if (
    !verifySignature(
      orderId,
      status.status_code,
      status.gross_amount,
      status.signature_key,
    )
  ) {
    auditLog({
      event: "billing.webhook.signature_mismatch",
      outcome: "reject",
      target: orderId,
    });
    return;
  }
  if (status.fraud_status === "challenge") {
    // Don't credit a challenged payment, but leave a trail (the webhook path
    // logs the same) so a later MAX_AGE abandonment isn't a silent black hole.
    auditLog({
      event: "billing.reconcile.fraud_challenge",
      outcome: "ok",
      target: orderId,
      details: { txStatus: status.transaction_status },
    });
    return;
  }
  if (status.fraud_status === "deny") {
    await markTransactionFailed(orderId);
    return;
  }
  const txStatus = status.transaction_status;
  if (SETTLED.has(txStatus)) {
    // Pass the Midtrans transaction_id through as paymentRef so a reconcile-
    // settled payment keeps the authoritative gateway reference (receipt's
    // payment-ref line + dispute lookups), exactly like the webhook path.
    await applySettlement(
      orderId,
      status.gross_amount,
      status.transaction_id ?? null,
      null,
      midtransMethodString(status.payment_type, status.va_numbers),
    );
    auditLog({
      event: "billing.reconcile.settled",
      outcome: "ok",
      target: orderId,
      details: { txStatus },
    });
  } else if (CANCELED.has(txStatus)) {
    await markTransactionFailed(orderId);
  }
  // pending → still waiting; leave for next tick.
}

export async function sweepPendingTransactions(): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - STALE_MS);
  const rows = await db
    .select({
      orderId: schema.transactions.midtransOrderId,
      createdAt: schema.transactions.createdAt,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.status, "pending"),
        isNotNull(schema.transactions.midtransOrderId),
        lt(schema.transactions.createdAt, cutoff),
      ),
    );

  let touched = 0;
  for (const r of rows) {
    if (!r.orderId) continue;
    // SAFETY (money never silently lost): ask Midtrans FIRST, every time.
    // reconcileOne settles a genuinely-paid order (capture/settlement) or marks
    // it failed ONLY when Midtrans itself confirms deny/cancel/expire/failure.
    // Per-item guard: one bad order must NEVER abort the whole sweep, or a
    // single un-reconcilable transaction starves every other pending order.
    try {
      await reconcileOne(r.orderId);
    } catch (e) {
      console.error("[reconcile] reconcileOne failed for", r.orderId, e);
    }
    touched++;
    // Abandon (mark failed) ONLY if it is STILL pending after that authoritative
    // check AND has aged past MAX_AGE — i.e. Midtrans never confirmed a payment
    // (expired VA, or an order that never reached Midtrans because charge-create
    // failed). A paid order is already 'completed' here and can never be
    // abandoned, so a user who paid can never be wrongly marked failed.
    if (now - r.createdAt.getTime() > MAX_AGE_MS) {
      const [cur] = await db
        .select({ status: schema.transactions.status })
        .from(schema.transactions)
        .where(eq(schema.transactions.midtransOrderId, r.orderId))
        .limit(1);
      if (cur?.status === "pending") {
        await markTransactionFailed(r.orderId);
        auditLog({
          event: "billing.reconcile.abandoned",
          outcome: "ok",
          target: r.orderId,
        });
      }
    }
  }
  return touched;
}

export type ReconcileWorkerHandle = { stop: () => Promise<void> };

export function startReconcileWorker(): ReconcileWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepPendingTransactions();
      } catch (e) {
        ok = false;
        console.error("[reconcile] sweep failed:", e);
      } finally {
        recordHeartbeat("reconcile", ok, { intervalMs: INTERVAL_MS });
        inFlight = null;
      }
    })();
  }, INTERVAL_MS);

  console.log(`[reconcile] started — interval=${INTERVAL_MS}ms`);

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      if (inFlight) await inFlight;
    },
  };
}
