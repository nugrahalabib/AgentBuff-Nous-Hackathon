import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { invalidateCatalogCache } from "@/lib/billing/skill-catalog";
import { catalogEntrySchema } from "../route";
import { auditLog } from "@/lib/security/audit-log";

// D13 — update (PATCH) or delete (DELETE) a first-party catalog entry. The key
// is immutable (it is the install slug + transaction sku); omit it from updates.
export const dynamic = "force-dynamic";

const updateSchema = catalogEntrySchema.omit({ key: true }).partial();

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { key } = await params;
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    const d = parsed.data;
    if (Object.keys(d).length === 0)
      return Response.json({ error: "NO_FIELDS" }, { status: 400 });

    const [row] = await db
      .update(schema.skillCatalog)
      .set({
        ...d,
        version: d.version === undefined ? undefined : (d.version ?? null),
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.skillCatalog.key, key))
      .returning({ key: schema.skillCatalog.key });
    if (!row) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    invalidateCatalogCache();
    auditLog({
      event: "admin.catalog.update",
      outcome: "ok",
      actor: actor.id,
      target: key,
      details: { action: "update", fields: Object.keys(d) },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { key } = await params;
    const [row] = await db
      .delete(schema.skillCatalog)
      .where(eq(schema.skillCatalog.key, key))
      .returning({ key: schema.skillCatalog.key });
    if (!row) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    invalidateCatalogCache();
    auditLog({
      event: "admin.catalog.update",
      outcome: "ok",
      actor: actor.id,
      target: key,
      details: { action: "delete" },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
