import "server-only";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { auditLog } from "@/lib/security/audit-log";

export type AdminRole = "admin" | "support";
export type AdminActor = { id: string; email: string | null; role: AdminRole };

/**
 * Authoritative staff check for the /admin surface (admin-panel foundation F1).
 * Reads users.role from the DB — NOT the JWT — so a granted/revoked role takes
 * effect immediately and a stale token can never claim admin. Returns null for
 * anyone who is not admin/support.
 */
export async function getAdminActor(): Promise<AdminActor | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const [row] = await db
    .select({ role: schema.users.role, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  if (!row) return null;
  if (row.role !== "admin" && row.role !== "support") return null;
  return { id, email: row.email, role: row.role };
}

/**
 * Page guard for /admin/** server layouts. Bounces non-staff: unauthenticated →
 * /login, authenticated-but-not-staff → /app (never reveal that /admin exists).
 */
export async function requireAdminPage(): Promise<AdminActor> {
  const actor = await getAdminActor();
  if (!actor) {
    const session = await auth();
    const uid = session?.user?.id;
    if (uid) {
      auditLog({ event: "admin.access.denied", outcome: "reject", actor: uid });
      redirect("/app");
    }
    redirect("/login?next=/admin");
  }
  return actor;
}

/**
 * Mutation guard: `support` is read-only, only `admin` may mutate. Returns the
 * actor when allowed, else null (callers respond 403). Use in /api/admin/*
 * routes that change state.
 */
export async function getAdminMutator(): Promise<AdminActor | null> {
  const actor = await getAdminActor();
  return actor && actor.role === "admin" ? actor : null;
}

/**
 * Page guard for ADMIN-ONLY tab pages (Harga, Marketplace, Kontainer, Konten,
 * Pengaturan, Dev). Staff pass the layout gate, but `support` must not reach
 * these even by typing the URL — bounce them back to /admin. Defense-in-depth on
 * top of the server-side mutation guard.
 */
export async function requireAdmin(): Promise<AdminActor> {
  const actor = await requireAdminPage();
  if (actor.role !== "admin") {
    auditLog({ event: "admin.access.denied", outcome: "reject", actor: actor.id });
    redirect("/admin");
  }
  return actor;
}
