import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import {
  isIrisConfigured,
  irisApprovePayout,
  IrisError,
  IrisNotConfiguredError,
} from "@/lib/iris";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// C3 Phase C — approve a submitted payout batch (APPROVER key). DUAL CONTROL:
// the approver MUST be a different operator than the creator (anti-self-payout
// fraud). Admin-only.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  // Money-movement op — rate-limit per admin (defense-in-depth; dual-control
  // already requires a different operator than the creator).
  const rl = take(keyFromRequest("admin.payout.approve", req, actor.id), 20, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  if (!isIrisConfigured())
    return Response.json({ error: "IRIS_NOT_CONFIGURED" }, { status: 503 });

  try {
    const { id } = await params;
    const [batch] = await db
      .select({
        id: schema.payoutBatches.id,
        status: schema.payoutBatches.status,
        createdBy: schema.payoutBatches.createdBy,
        irisReferenceNo: schema.payoutBatches.irisReferenceNo,
      })
      .from(schema.payoutBatches)
      .where(eq(schema.payoutBatches.id, id))
      .limit(1);
    if (!batch) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    if (batch.status !== "submitted")
      return Response.json(
        { error: "NOT_APPROVABLE", status: batch.status },
        { status: 409 },
      );

    // Dual control — fail CLOSED: reject if the creator is the approver, OR if
    // we can't verify the creator at all (null createdBy). Never approve a batch
    // whose dual-control we cannot prove.
    if (!batch.createdBy || batch.createdBy === actor.id) {
      auditLog({
        event: "billing.payout.approve",
        outcome: "reject",
        actor: actor.id,
        target: batch.id,
        details: { reason: batch.createdBy ? "self_approval" : "no_creator" },
      });
      return Response.json({ error: "SELF_APPROVAL_FORBIDDEN" }, { status: 403 });
    }

    try {
      await irisApprovePayout([batch.irisReferenceNo ?? batch.id]);
    } catch (e) {
      const code = e instanceof IrisNotConfiguredError ? "IRIS_NOT_CONFIGURED" : "IRIS_ERROR";
      const msg = e instanceof IrisError ? e.message : String(e);
      await db
        .update(schema.payoutBatches)
        .set({ lastError: msg.slice(0, 500), updatedAt: new Date() })
        .where(eq(schema.payoutBatches.id, batch.id));
      return Response.json({ error: code }, { status: code === "IRIS_NOT_CONFIGURED" ? 503 : 502 });
    }

    const now = new Date();
    await db
      .update(schema.payoutBatches)
      .set({
        status: "approved",
        approvedBy: actor.id,
        approvedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(schema.payoutBatches.id, batch.id));

    auditLog({
      event: "billing.payout.approve",
      outcome: "ok",
      actor: actor.id,
      target: batch.id,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
