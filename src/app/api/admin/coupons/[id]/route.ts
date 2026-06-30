import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

// D10/D14 — edit a coupon (PATCH: full field edit or active toggle) or delete it
// (DELETE). Admin only. We never edit `code` (identity) or reset `used` (the
// redemption history is preserved).
export const dynamic = "force-dynamic";

const MAX_FIXED_VALUE_RP = 100_000_000;

// Every field optional — PATCH applies whatever subset is sent (a bare {active}
// toggle keeps working; a full edit form sends the rest).
const editSchema = z.object({
  type: z.enum(["percent", "fixed"]).optional(),
  value: z.number().int().positive().max(MAX_FIXED_VALUE_RP).optional(),
  tierScope: z.enum(["", "op_buff", "full_managed"]).optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { id } = await params;
    const parsed = editSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    const d = parsed.data;
    if (Object.keys(d).length === 0)
      return Response.json({ error: "NO_FIELDS" }, { status: 400 });
    // A percent coupon must be 1..100 (mirrors create).
    if (d.type === "percent" && d.value !== undefined && (d.value < 1 || d.value > 100))
      return Response.json({ error: "INVALID_PERCENT" }, { status: 400 });

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (d.type !== undefined) patch.type = d.type;
    if (d.value !== undefined) patch.value = d.value;
    if (d.tierScope !== undefined) patch.tierScope = d.tierScope;
    if (d.maxUses !== undefined) patch.maxUses = d.maxUses;
    if (d.expiresAt !== undefined)
      patch.expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
    if (d.active !== undefined) patch.active = d.active;

    const [row] = await db
      .update(schema.coupons)
      .set(patch)
      .where(eq(schema.coupons.id, id))
      .returning({ code: schema.coupons.code });
    if (!row) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    auditLog({
      event: "admin.coupon.update",
      outcome: "ok",
      actor: actor.id,
      target: row.code,
      details: {
        action: Object.keys(d).length === 1 && d.active !== undefined ? "toggle" : "edit",
        fields: Object.keys(d),
      },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { id } = await params;
    const [target] = await db
      .select({ code: schema.coupons.code })
      .from(schema.coupons)
      .where(eq(schema.coupons.id, id))
      .limit(1);
    if (!target) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    // A hard delete while a pending charge still holds a reservation against this
    // code would strand that reservation (markTransactionFailed could never give
    // the use back) and, on re-create, silently reset `used` mid-campaign. Refuse
    // — the admin should deactivate (PATCH active:false) instead, which is safe.
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.status, "pending"),
          sql`${schema.transactions.metadata} ->> 'couponCode' = ${target.code}`,
        ),
      );
    if ((pending?.n ?? 0) > 0)
      return Response.json({ error: "COUPON_IN_USE" }, { status: 409 });

    const [row] = await db
      .delete(schema.coupons)
      .where(eq(schema.coupons.id, id))
      .returning({ code: schema.coupons.code });
    if (!row) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    auditLog({
      event: "admin.coupon.update",
      outcome: "ok",
      actor: actor.id,
      target: row.code,
      details: { action: "delete" },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
