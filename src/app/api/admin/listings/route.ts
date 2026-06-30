import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";
import { ensureFirstPartySeller } from "@/lib/admin/marketplace";

const PAGE_SIZE = 25;
const MAX_Q = 100;
const KINDS = new Set(["skill", "mcp_app", "bundle"]);

// Marketplace listings (Fase C / D4). Read = admin/support.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 12);
    const kind = (url.searchParams.get("kind") ?? "").trim().slice(0, 16);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const conds = [];
    if (q)
      conds.push(
        or(
          ilike(schema.listings.title, `%${q}%`),
          ilike(schema.listings.slug, `%${q}%`),
        ),
      );
    if (status) conds.push(eq(schema.listings.status, status));
    if (kind) conds.push(eq(schema.listings.kind, kind));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: schema.listings.id,
        title: schema.listings.title,
        slug: schema.listings.slug,
        kind: schema.listings.kind,
        category: schema.listings.category,
        priceRp: schema.listings.priceRp,
        status: schema.listings.status,
        version: schema.listings.version,
        sellerName: schema.sellers.displayName,
        sellerType: schema.sellers.type,
        installSpec: schema.listings.installSpec,
        reviewNotes: schema.listings.reviewNotes,
        createdAt: schema.listings.createdAt,
        publishedAt: schema.listings.publishedAt,
      })
      .from(schema.listings)
      .leftJoin(schema.sellers, eq(schema.sellers.id, schema.listings.sellerId))
      .where(where)
      .orderBy(desc(schema.listings.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.listings)
      .where(where);

    const byStatus = await db
      .select({ status: schema.listings.status, c: count() })
      .from(schema.listings)
      .groupBy(schema.listings.status);
    const counts: Record<string, number> = {};
    for (const r of byStatus) counts[r.status] = r.c;

    return Response.json({
      rows,
      page,
      pageSize: PAGE_SIZE,
      total: totalRow?.total ?? 0,
      counts,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Create a first-party listing (admin only). 3rd-party submission flow later.
export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = String(body.kind ?? "");
    if (!KINDS.has(kind))
      return Response.json({ error: "INVALID_KIND" }, { status: 400 });
    const title = String(body.title ?? "").trim().slice(0, 120);
    if (!title)
      return Response.json({ error: "INVALID_TITLE" }, { status: 400 });
    const slug = slugify(String(body.slug ?? title));
    if (!slug) return Response.json({ error: "INVALID_SLUG" }, { status: 400 });
    const priceRp = Math.max(0, Math.trunc(Number(body.priceRp ?? 0)) || 0);
    const category = body.category ? String(body.category).slice(0, 40) : null;
    const version = body.version ? String(body.version).slice(0, 40) : null;
    const description = body.description
      ? String(body.description).slice(0, 2000)
      : null;
    const installSpec =
      body.installSpec && typeof body.installSpec === "object"
        ? (body.installSpec as Record<string, unknown>)
        : null;
    const status = body.status === "published" ? "published" : "draft";

    const [dupe] = await db
      .select({ id: schema.listings.id })
      .from(schema.listings)
      .where(eq(schema.listings.slug, slug))
      .limit(1);
    if (dupe) return Response.json({ error: "SLUG_TAKEN" }, { status: 409 });

    const sellerId = await ensureFirstPartySeller();
    const now = new Date();
    const [created] = await db
      .insert(schema.listings)
      .values({
        sellerId,
        kind,
        slug,
        title,
        description,
        category,
        version,
        priceRp,
        status,
        installSpec,
        createdBy: actor.id,
        publishedAt: status === "published" ? now : null,
      })
      .returning({ id: schema.listings.id });

    auditLog({
      event: "admin.listing.create",
      outcome: "ok",
      actor: actor.id,
      target: created.id,
      details: { kind, slug, status },
    });
    return Response.json({ ok: true, id: created.id, slug });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
