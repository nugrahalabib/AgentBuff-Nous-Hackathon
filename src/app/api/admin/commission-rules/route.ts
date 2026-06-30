import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const DEFAULT_GLOBAL_PCT = 20;
// Scoped rules the editor can manage. Per-seller overrides ALSO live on the
// seller row (resolver checks seller.commissionPct first); a scope="seller" rule
// here is the next precedence tier. scope="category" keys on listing.category.
const SCOPED = new Set(["seller", "category"]);

// Commission rules (Fase C / D4). Platform cut % for 3rd-party sales — consumed
// by the Shop buy/payout flow (Iris) when that lands. Read = admin/support.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const rules = await db
      .select({
        id: schema.commissionRules.id,
        scope: schema.commissionRules.scope,
        scopeId: schema.commissionRules.scopeId,
        pct: schema.commissionRules.pct,
        updatedAt: schema.commissionRules.updatedAt,
      })
      .from(schema.commissionRules)
      .orderBy(desc(schema.commissionRules.updatedAt));
    const global =
      rules.find((r) => r.scope === "global")?.pct ?? DEFAULT_GLOBAL_PCT;
    return Response.json({ global, rules });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

function clampPct(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_GLOBAL_PCT;
  return Math.max(0, Math.min(100, n));
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as { global?: unknown };
    const pct = clampPct(body.global);
    const now = new Date();
    await db
      .insert(schema.commissionRules)
      .values({ scope: "global", scopeId: "", pct, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.commissionRules.scope, schema.commissionRules.scopeId],
        set: { pct, updatedBy: actor.id, updatedAt: now },
      });
    auditLog({
      event: "admin.commission.update",
      outcome: "ok",
      actor: actor.id,
      details: { scope: "global", pct },
    });
    return Response.json({ ok: true, global: pct });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

// Upsert a scoped rule (seller / category). scopeId = seller.id or the category
// string. The resolver already honors these tiers (src/lib/admin/commission.ts).
export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      scope?: unknown;
      scopeId?: unknown;
      pct?: unknown;
    };
    const scope = String(body.scope ?? "");
    const scopeId = String(body.scopeId ?? "").trim().slice(0, 120);
    if (!SCOPED.has(scope) || !scopeId) {
      return Response.json({ error: "INVALID_SCOPE" }, { status: 400 });
    }
    const pct = clampPct(body.pct);
    const now = new Date();
    await db
      .insert(schema.commissionRules)
      .values({ scope, scopeId, pct, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.commissionRules.scope, schema.commissionRules.scopeId],
        set: { pct, updatedBy: actor.id, updatedAt: now },
      });
    auditLog({
      event: "admin.commission.update",
      outcome: "ok",
      actor: actor.id,
      details: { scope, scopeId, pct },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

// Remove a scoped rule (falls back to the next precedence tier).
export async function DELETE(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") ?? "";
    const scopeId = (url.searchParams.get("scopeId") ?? "").slice(0, 120);
    if (!SCOPED.has(scope) || !scopeId) {
      return Response.json({ error: "INVALID_SCOPE" }, { status: 400 });
    }
    await db
      .delete(schema.commissionRules)
      .where(
        and(
          eq(schema.commissionRules.scope, scope),
          eq(schema.commissionRules.scopeId, scopeId),
        ),
      );
    auditLog({
      event: "admin.commission.update",
      outcome: "ok",
      actor: actor.id,
      details: { action: "delete", scope, scopeId },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
