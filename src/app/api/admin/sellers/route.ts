import { count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

// Marketplace sellers (Fase C / D4 C2). Read = admin/support.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const rows = await db
      .select({
        id: schema.sellers.id,
        type: schema.sellers.type,
        displayName: schema.sellers.displayName,
        status: schema.sellers.status,
        commissionPct: schema.sellers.commissionPct,
        ownerUserId: schema.sellers.ownerUserId,
        createdAt: schema.sellers.createdAt,
        listingCount: count(schema.listings.id),
      })
      .from(schema.sellers)
      .leftJoin(schema.listings, eq(schema.listings.sellerId, schema.sellers.id))
      .groupBy(schema.sellers.id)
      .orderBy(desc(schema.sellers.createdAt));
    return Response.json({ rows });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

function clampPct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Create a 3rd-party seller (admin only). first_party house seller is auto-seeded.
export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const displayName = String(body.displayName ?? "").trim().slice(0, 80);
    if (!displayName)
      return Response.json({ error: "INVALID_NAME" }, { status: 400 });
    const commissionPct = clampPct(body.commissionPct);
    const ownerUserId = body.ownerUserId
      ? String(body.ownerUserId).slice(0, 80)
      : null;

    const [created] = await db
      .insert(schema.sellers)
      .values({
        type: "third_party",
        displayName,
        status: "active",
        commissionPct,
        ownerUserId,
      })
      .returning({ id: schema.sellers.id });

    auditLog({
      event: "admin.seller.create",
      outcome: "ok",
      actor: actor.id,
      target: created.id,
      details: { displayName },
    });
    return Response.json({ ok: true, id: created.id });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
