import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveSellerForUser } from "@/lib/seller/resolve";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D4 seller portal — list my listings (GET) + create a draft (POST). A seller
// only ever touches their OWN listings; admin still approves draft->pending via
// the lifecycle DAG before anything goes live.
export const dynamic = "force-dynamic";

const KINDS = new Set(["skill", "mcp_app", "bundle"]);

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const seller = await resolveSellerForUser(session.user.id);
  if (!seller) return Response.json({ error: "NOT_SELLER" }, { status: 403 });

  const rows = await db
    .select({
      id: schema.listings.id,
      kind: schema.listings.kind,
      slug: schema.listings.slug,
      title: schema.listings.title,
      description: schema.listings.description,
      category: schema.listings.category,
      priceRp: schema.listings.priceRp,
      status: schema.listings.status,
      reviewNotes: schema.listings.reviewNotes,
      createdAt: schema.listings.createdAt,
    })
    .from(schema.listings)
    .where(eq(schema.listings.sellerId, seller.id))
    .orderBy(desc(schema.listings.createdAt))
    .limit(200);
  return Response.json({ rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const userId = session.user.id;
  const seller = await resolveSellerForUser(userId);
  if (!seller) return Response.json({ error: "NOT_SELLER" }, { status: 403 });
  const rl = take(keyFromRequest("seller-listing-create", req, userId), 30, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    title?: string;
    description?: string;
    category?: string;
    priceRp?: number;
    clawhubSlug?: string;
  };
  const kind = String(body.kind ?? "");
  const title = (body.title ?? "").trim().slice(0, 120);
  if (!KINDS.has(kind) || !title) {
    return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
  }
  const priceRp = Math.max(0, Math.min(100_000_000, Math.trunc(Number(body.priceRp ?? 0)) || 0));
  const clawhubSlug = (body.clawhubSlug ?? "").trim().slice(0, 80);
  // installSpec: for a skill, the clawhub slug is what installs into a container.
  const installSpec =
    kind === "skill" && clawhubSlug
      ? { source: "clawhub", slug: clawhubSlug }
      : null;

  // Unique slug: base from title + short deterministic suffix (slug is UNIQUE).
  const rand = Math.abs(
    [...title].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, userId.length),
  )
    .toString(36)
    .slice(0, 6);
  const slug = `${slugify(title) || "item"}-${rand}`;

  try {
    const [row] = await db
      .insert(schema.listings)
      .values({
        sellerId: seller.id,
        kind,
        slug,
        title,
        description: (body.description ?? "").trim().slice(0, 2000) || null,
        category: (body.category ?? "").trim().slice(0, 40) || null,
        priceRp,
        status: "draft",
        installSpec,
        createdBy: userId,
      })
      .returning({ id: schema.listings.id });
    auditLog({
      event: "admin.listing.create",
      outcome: "ok",
      actor: userId,
      target: row.id,
      details: { self_seller: true, kind },
    });
    return Response.json({ ok: true, id: row.id });
  } catch {
    return Response.json({ error: "SLUG_CONFLICT" }, { status: 409 });
  }
}
