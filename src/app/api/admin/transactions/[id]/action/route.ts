import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { reconcileOne } from "@/lib/billing/reconcile-worker";
import { auditLog } from "@/lib/security/audit-log";

const ACTIONS = new Set(["refund", "reconcile"]);
// Money-received statuses. 'install_failed' = Midtrans captured the payment but
// the skill never installed (retries exhausted in skill-installer) — the rest of
// the system already treats it as paid (billing receipt PDF, riwayat
// MONEY_RECEIVED, attention feed), so it MUST be refundable too; otherwise a
// customer who paid but got nothing has no in-product refund lever and the cash
// sits in no metric bucket. (install_failed only ever applies to skill-install,
// so the subscription audit-history branch below is unaffected.)
const REFUNDABLE = ["completed", "installed", "install_failed"];

// Admin transaction actions (D2 finisher). Mutation — admin only (getAdminMutator;
// support stays read-only). Two Postgres-only actions:
//
//   refund — mark a completed/installed tx 'refunded' in OUR DB. Does NOT call any
//     Midtrans money-movement API; the operator issues the real refund manually in
//     the Midtrans dashboard and this only records it + audits. The subscription
//     (if any) is left UNTOUCHED on purpose: refund != access revocation, those are
//     separate operator levers, and settle.ts exposes no safe cancel helper. Energy
//     is intentionally NOT clawed back (gate is OFF; topups never credited balance —
//     revisit if energy is ever re-enabled).
//
//   reconcile — re-run the worker's exact idempotent settlement path for ONE pending
//     tx (Midtrans Get-Status -> verify signature -> applySettlement/markFailed). NOT
//     a read-only peek: a genuinely-paid pending tx is fully SETTLED (credit/activate/
//     install), exactly as the webhook would have. Refused on non-pending rows so a
//     still-valid Midtrans signature can't mutate a finalized/refunded row.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      reason?: string;
    };
    const action = body.action ?? "";
    if (!ACTIONS.has(action)) {
      return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
    }

    const [tx] = await db
      .select({
        id: schema.transactions.id,
        userId: schema.transactions.userId,
        type: schema.transactions.type,
        status: schema.transactions.status,
        amountRp: schema.transactions.amountRp,
        midtransOrderId: schema.transactions.midtransOrderId,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id))
      .limit(1);
    if (!tx) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    if (action === "refund") {
      const reason = (body.reason ?? "").trim().slice(0, 300) || null;
      // Atomic + idempotent: the guarded UPDATE's status-set IS the mutex. A
      // double-submit re-runs it; the 2nd time the row is already 'refunded' so 0
      // rows match -> we reject below. Wrapping the flip + the audit-only history
      // marker in one transaction means a failed history insert rolls back the
      // flip too (no orphaned refund).
      let refundedId: string | undefined;
      let hadSubscription = false;
      await db.transaction(async (txdb) => {
        const upd = await txdb
          .update(schema.transactions)
          .set({ status: "refunded", refundReason: reason, updatedAt: new Date() })
          .where(
            and(
              eq(schema.transactions.id, id),
              inArray(schema.transactions.status, REFUNDABLE),
            ),
          )
          .returning({ id: schema.transactions.id });
        refundedId = upd[0]?.id;
        if (!refundedId) return; // not refundable — commit no-op, reject outside

        if (tx.type === "subscription") {
          const [sub] = await txdb
            .select({
              id: schema.subscriptions.id,
              tier: schema.subscriptions.tier,
              status: schema.subscriptions.status,
            })
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, tx.userId))
            .orderBy(desc(schema.subscriptions.createdAt))
            .limit(1);
          hadSubscription = Boolean(sub);
          // Audit-only marker: toStatus = fromStatus (sub state UNCHANGED).
          await txdb.insert(schema.subscriptionHistory).values({
            userId: tx.userId,
            subscriptionId: sub?.id ?? null,
            fromTier: sub?.tier ?? null,
            toTier: sub?.tier ?? null,
            fromStatus: sub?.status ?? null,
            toStatus: sub?.status ?? null,
            reason: "admin_refund",
          });
        }
      });

      if (!refundedId) {
        auditLog({
          event: "admin.transaction.refund",
          outcome: "reject",
          actor: actor.id,
          target: id,
          details: { reason: "not_refundable", currentStatus: tx.status },
        });
        return Response.json(
          { error: "NOT_REFUNDABLE", currentStatus: tx.status },
          { status: 409 },
        );
      }

      auditLog({
        event: "admin.transaction.refund",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { type: tx.type, amountRp: tx.amountRp, hadSubscription, reason },
      });
      return Response.json({ ok: true, status: "refunded" });
    }

    // action === "reconcile"
    if (tx.status !== "pending") {
      return Response.json(
        { error: "NOT_PENDING", currentStatus: tx.status },
        { status: 409 },
      );
    }
    if (!tx.midtransOrderId) {
      return Response.json({ error: "NO_ORDER_ID" }, { status: 400 });
    }
    // reconcileOne owns the Midtrans Get-Status + signature verify + idempotent
    // settle path; it never throws on 404/challenge (logs + returns). We only
    // re-read + audit the converged status.
    await reconcileOne(tx.midtransOrderId);
    const [fresh] = await db
      .select({ status: schema.transactions.status })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id))
      .limit(1);
    const afterStatus = fresh?.status ?? tx.status;
    auditLog({
      event: "admin.transaction.reconcile",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: { beforeStatus: "pending", afterStatus },
    });
    return Response.json({ ok: true, status: afterStatus });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
