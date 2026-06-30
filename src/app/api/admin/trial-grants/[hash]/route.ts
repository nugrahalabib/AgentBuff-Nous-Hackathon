import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D3 — remove an email from the anti-farm trial-grant ledger so that email can
// claim a fresh trial again (PRD "allowlist remove"). Admin-only, audited.
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.trial.grant.del", req, actor.id), 30, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const { hash } = await params;
    // sha256 hex is exactly 64 chars — reject anything else.
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
      return Response.json({ error: "INVALID_HASH" }, { status: 400 });
    }
    const removed = await db
      .delete(schema.trialGrants)
      .where(eq(schema.trialGrants.emailHash, hash))
      .returning({ emailHash: schema.trialGrants.emailHash });
    if (removed.length === 0) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    auditLog({
      event: "admin.user.action",
      outcome: "ok",
      actor: actor.id,
      target: hash.slice(0, 12),
      details: { action: "trial_grant_remove" },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
