import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { writeSessionCookie } from "@/lib/auth/impersonation";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D1 — admin impersonation START. Mints a session for the target user with an
// `impersonatedBy` marker, so the admin acts AS the user. Admin-only, rate-
// limited, audited. The impersonated session still re-resolves the target's DB
// role on every admin route — so impersonating a regular user drops admin power.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.impersonate", req, actor.id), 20, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    if (id === actor.id) {
      return Response.json({ error: "CANNOT_SELF" }, { status: 400 });
    }

    const [target] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    if (!target) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    await writeSessionCookie({
      id: target.id,
      role: target.role ?? "user",
      name: target.name,
      email: target.email,
      impersonatedBy: actor.id,
    });

    auditLog({
      event: "admin.impersonate.start",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: { targetEmail: target.email ?? undefined },
    });

    return Response.json({ ok: true, redirect: "/app" });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
