import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { auth } from "@/lib/auth.config";
import { writeSessionCookie } from "@/lib/auth/impersonation";
import { auditLog } from "@/lib/security/audit-log";

// D1 — STOP impersonation. Reachable by the impersonated session (which may be a
// non-admin user), so the gate is the `impersonatedBy` marker on the session, not
// the admin RBAC check. Re-mints the original admin's session (role re-read from
// DB) and audits the return.
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  const impersonatedBy = session?.user?.impersonatedBy;
  const currentId = session?.user?.id;
  if (!impersonatedBy || !currentId) {
    return Response.json({ error: "NOT_IMPERSONATING" }, { status: 400 });
  }

  try {
    const [admin] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
      })
      .from(schema.users)
      .where(eq(schema.users.id, impersonatedBy))
      .limit(1);
    if (!admin) {
      // The original admin no longer exists — leave the impersonated session as
      // is rather than minting a session for a ghost. Operator can sign out.
      return Response.json({ error: "ADMIN_NOT_FOUND" }, { status: 404 });
    }

    await writeSessionCookie({
      id: admin.id,
      role: admin.role ?? "user",
      name: admin.name,
      email: admin.email,
      // no impersonatedBy → back to a normal admin session
    });

    auditLog({
      event: "admin.impersonate.stop",
      outcome: "ok",
      actor: impersonatedBy,
      target: currentId,
    });

    return Response.json({ ok: true, redirect: "/admin" });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
