import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const STATUSES = new Set(["new", "contacted", "converted", "archived"]);

// Admin lead status update (D10). Mutation — admin only.
export async function PATCH(
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
    const body = (await req.json().catch(() => ({}))) as { status?: string };
    const status = body.status ?? "";
    if (!STATUSES.has(status)) {
      return Response.json({ error: "INVALID_STATUS" }, { status: 400 });
    }

    const res = await db
      .update(schema.earlyAccessLeads)
      .set({ status })
      .where(eq(schema.earlyAccessLeads.id, id))
      .returning({ id: schema.earlyAccessLeads.id });
    if (res.length === 0) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    auditLog({
      event: "admin.lead.update",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: { status },
    });
    return Response.json({ ok: true, status });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
