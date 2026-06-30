import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { invalidateSettingCache } from "@/lib/admin/settings";
import {
  resolveEffectivePlans,
  PRICEABLE_TIERS,
  PRICE_MAX,
} from "@/lib/billing/pricing-resolver";
import { PLANS, type PlanTier } from "@/lib/billing/plans";
import { auditLog } from "@/lib/security/audit-log";

// Admin pricing editor (D14). Plan price + status overrides stored in
// admin_setting (global scope), overlaid on the plans.ts catalog by
// pricing-resolver. The charge path + every price display resolve through the
// SAME resolver, so an edit here drives checkout with no redeploy. A blank field
// deletes the override (revert to the compiled-in catalog default) — we never
// persist a row equal to the default that would shadow a future code change.
//
// Editable status values: only live | coming_soon (op_buff/full_managed are the
// two priceable tiers). Read = admin/support; write = admin only.
const EDITABLE_STATUS = ["live", "coming_soon"] as const;
const FIELD_KEYS = ["monthly", "yearly", "status"] as const;

function keyFor(tier: PlanTier, field: (typeof FIELD_KEYS)[number]): string {
  return `pricing.${tier}.${field}`;
}

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const keys = PRICEABLE_TIERS.flatMap((t) =>
      FIELD_KEYS.map((f) => keyFor(t, f)),
    );
    const rows = await db
      .select({
        key: schema.adminSettings.key,
        value: schema.adminSettings.value,
      })
      .from(schema.adminSettings)
      .where(
        and(
          eq(schema.adminSettings.scope, "global"),
          inArray(schema.adminSettings.key, keys),
        ),
      );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    // Raw overrides (only present when a real override row exists) so a blank
    // input means "use catalog default", and saving it deletes the override.
    const overrides: Record<
      string,
      { monthly?: number; yearly?: number; status?: string }
    > = {};
    const defaults: Record<
      string,
      {
        monthly: number | null;
        yearly: number | null;
        status: string;
        selfServe: boolean;
      }
    > = {};
    for (const t of PRICEABLE_TIERS) {
      const o: { monthly?: number; yearly?: number; status?: string } = {};
      const m = byKey.get(keyFor(t, "monthly"));
      const y = byKey.get(keyFor(t, "yearly"));
      const s = byKey.get(keyFor(t, "status"));
      if (typeof m === "number") o.monthly = m;
      if (typeof y === "number") o.yearly = y;
      if (typeof s === "string") o.status = s;
      if (Object.keys(o).length) overrides[t] = o;
      defaults[t] = {
        monthly: PLANS[t].priceMonthly,
        yearly: PLANS[t].priceYearly,
        status: PLANS[t].status,
        selfServe: PLANS[t].selfServe,
      };
    }
    return Response.json({ overrides, defaults });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

type Op = {
  key: string;
  value: number | string | null; // null = delete override (revert to catalog)
};

function priceOp(
  tier: PlanTier,
  field: "monthly" | "yearly",
  raw: unknown,
  errors: string[],
): Op | null {
  if (raw === undefined) return null;
  const v = String(raw ?? "").trim();
  if (v === "") return { key: keyFor(tier, field), value: null };
  const n = Math.trunc(Number(v));
  if (Number.isFinite(n) && n >= 0 && n <= PRICE_MAX)
    return { key: keyFor(tier, field), value: n };
  errors.push(`${tier}.${field}`);
  return null;
}

function statusOp(tier: PlanTier, raw: unknown, errors: string[]): Op | null {
  if (raw === undefined) return null;
  const v = String(raw ?? "").trim();
  if (v === "") return { key: keyFor(tier, "status"), value: null };
  // Status is only a coherent lever for self-serve tiers (op_buff: pause/resume
  // sales). A non-self-serve tier (full_managed) flipped to "live" would show a
  // price with a waitlist CTA and still be rejected by the charge gate — a
  // misleading half-state. Truly making it buyable needs backend work beyond
  // D14, so reject the status edit here rather than ship the trap.
  if (!PLANS[tier].selfServe) {
    errors.push(`${tier}.status`);
    return null;
  }
  if ((EDITABLE_STATUS as readonly string[]).includes(v))
    return { key: keyFor(tier, "status"), value: v };
  errors.push(`${tier}.status`);
  return null;
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      prices?: Record<
        string,
        { monthly?: unknown; yearly?: unknown; status?: unknown }
      >;
    };

    const ops: Op[] = [];
    const errors: string[] = [];
    for (const tier of PRICEABLE_TIERS) {
      const p = body.prices?.[tier];
      if (!p) continue;
      for (const op of [
        priceOp(tier, "monthly", p.monthly, errors),
        priceOp(tier, "yearly", p.yearly, errors),
        statusOp(tier, p.status, errors),
      ]) {
        if (op) ops.push(op);
      }
    }

    if (errors.length)
      return Response.json(
        { error: "INVALID_VALUES", fields: errors },
        { status: 400 },
      );
    if (!ops.length) return Response.json({ ok: true, changed: 0 });

    // Capture the EFFECTIVE before-state for the audit trail (history requirement
    // — who changed what from what to what).
    const before = await resolveEffectivePlans();

    const now = new Date();
    // Atomic: all price/status ops commit together or not at all. Without this,
    // a mid-loop failure could leave e.g. a new price persisted but a paired
    // status edit dropped (a live-but-repriced tier) and skip the cache flush
    // below — a money-state inconsistency. Matches the db.transaction convention
    // used by settle.ts / cancel / onboarding.
    await db.transaction(async (tx) => {
      for (const op of ops) {
        if (op.value === null) {
          await tx
            .delete(schema.adminSettings)
            .where(
              and(
                eq(schema.adminSettings.key, op.key),
                eq(schema.adminSettings.scope, "global"),
                eq(schema.adminSettings.scopeId, ""),
              ),
            );
        } else {
          await tx
            .insert(schema.adminSettings)
            .values({
              key: op.key,
              scope: "global",
              scopeId: "",
              value: op.value,
              updatedBy: actor.id,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                schema.adminSettings.key,
                schema.adminSettings.scope,
                schema.adminSettings.scopeId,
              ],
              set: { value: op.value, updatedBy: actor.id, updatedAt: now },
            });
        }
      }
    });

    invalidateSettingCache();
    const after = await resolveEffectivePlans();

    // before/after diff per priceable tier — the auditable "history".
    const changes = PRICEABLE_TIERS.flatMap((t) => {
      const b = before[t];
      const a = after[t];
      const out: { field: string; from: unknown; to: unknown }[] = [];
      if (b.priceMonthly !== a.priceMonthly)
        out.push({ field: `${t}.monthly`, from: b.priceMonthly, to: a.priceMonthly });
      if (b.priceYearly !== a.priceYearly)
        out.push({ field: `${t}.yearly`, from: b.priceYearly, to: a.priceYearly });
      if (b.status !== a.status)
        out.push({ field: `${t}.status`, from: b.status, to: a.status });
      return out;
    });

    auditLog({
      event: "admin.pricing.update",
      outcome: "ok",
      actor: actor.id,
      details: { area: "pricing", changes },
    });
    return Response.json({ ok: true, changed: changes.length });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
