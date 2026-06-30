import { desc } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { normalizeCode } from "@/lib/billing/coupon";
import { auditLog } from "@/lib/security/audit-log";

// D10/D14 coupon management. Read = admin/support; create = admin only.
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const rows = await db
      .select()
      .from(schema.coupons)
      .orderBy(desc(schema.coupons.createdAt))
      .limit(500);
    return Response.json({ coupons: rows });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

// Upper bound for a fixed-Rp coupon value — a data-entry guardrail (computeDiscount
// caps the discount at the charged amount regardless, so this can't enable a
// free purchase; it just stops absurd records).
const MAX_FIXED_VALUE_RP = 100_000_000;

const createSchema = z.object({
  code: z.string().trim().min(1).max(40),
  type: z.enum(["percent", "fixed"]),
  value: z.number().int().positive().max(MAX_FIXED_VALUE_RP),
  tierScope: z.enum(["", "op_buff", "full_managed"]).default(""),
  maxUses: z.number().int().positive().nullable().optional(),
  // ISO date string or null.
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
});

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    const d = parsed.data;
    // A percent coupon must be 1..100.
    if (d.type === "percent" && (d.value < 1 || d.value > 100))
      return Response.json({ error: "INVALID_PERCENT" }, { status: 400 });

    const code = normalizeCode(d.code);
    try {
      const [row] = await db
        .insert(schema.coupons)
        .values({
          code,
          type: d.type,
          value: d.value,
          tierScope: d.tierScope,
          maxUses: d.maxUses ?? null,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
          active: d.active,
          createdBy: actor.id,
        })
        .returning({ id: schema.coupons.id });
      auditLog({
        event: "admin.coupon.create",
        outcome: "ok",
        actor: actor.id,
        target: code,
        details: { type: d.type, value: d.value },
      });
      return Response.json({ ok: true, id: row.id });
    } catch {
      // Unique-code violation is the expected conflict.
      return Response.json({ error: "CODE_EXISTS" }, { status: 409 });
    }
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
