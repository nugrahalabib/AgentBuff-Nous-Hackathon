import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveSellerForUser } from "@/lib/seller/resolve";
import { auditLog } from "@/lib/security/audit-log";

// D4 seller portal — edit/submit/delete a listing the SELLER owns. A seller can
// only edit a draft/rejected listing or submit it for review (draft -> pending);
// it can NEVER self-approve or self-publish (admin owns approved/published via
// the admin DAG). Ownership (sellerId) is re-checked on every call.
export const dynamic = "force-dynamic";

const SELLER_EDITABLE = new Set(["draft", "rejected"]);

async function ownListing(userId: string, id: string) {
  const seller = await resolveSellerForUser(userId);
  if (!seller) return { error: "NOT_SELLER" as const };
  const [row] = await db
    .select({
      id: schema.listings.id,
      sellerId: schema.listings.sellerId,
      status: schema.listings.status,
    })
    .from(schema.listings)
    .where(eq(schema.listings.id, id))
    .limit(1);
  if (!row || row.sellerId !== seller.id) return { error: "NOT_FOUND" as const };
  return { seller, listing: row };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const { id } = await params;
    const owned = await ownListing(session.user.id, id);
    if ("error" in owned) {
      return Response.json(
        { error: owned.error },
        { status: owned.error === "NOT_SELLER" ? 403 : 404 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      title?: string;
      description?: string;
      category?: string;
      priceRp?: number;
      clawhubSlug?: string;
    };

    // Submit for review: draft -> pending. (Seller can't go further.)
    if (body.action === "submit") {
      if (owned.listing.status !== "draft") {
        return Response.json(
          { error: "ONLY_DRAFT_SUBMITTABLE", status: owned.listing.status },
          { status: 409 },
        );
      }
      await db
        .update(schema.listings)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(schema.listings.id, id));
      auditLog({
        event: "admin.listing.update",
        outcome: "ok",
        actor: session.user.id,
        target: id,
        details: { self_seller: true, action: "submit" },
      });
      return Response.json({ ok: true, status: "pending" });
    }

    // Edit content — only while draft or rejected (a rejected listing can be
    // fixed + resubmitted). Never touches status here.
    if (!SELLER_EDITABLE.has(owned.listing.status)) {
      return Response.json(
        { error: "NOT_EDITABLE", status: owned.listing.status },
        { status: 409 },
      );
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.title === "string" && body.title.trim())
      updates.title = body.title.trim().slice(0, 120);
    if (typeof body.description === "string")
      updates.description = body.description.trim().slice(0, 2000) || null;
    if (typeof body.category === "string")
      updates.category = body.category.trim().slice(0, 40) || null;
    if (body.priceRp !== undefined)
      updates.priceRp = Math.max(
        0,
        Math.min(100_000_000, Math.trunc(Number(body.priceRp)) || 0),
      );
    if (typeof body.clawhubSlug === "string" && body.clawhubSlug.trim())
      updates.installSpec = { source: "clawhub", slug: body.clawhubSlug.trim().slice(0, 80) };

    await db
      .update(schema.listings)
      .set(updates)
      .where(eq(schema.listings.id, id));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const { id } = await params;
    const owned = await ownListing(session.user.id, id);
    if ("error" in owned) {
      return Response.json(
        { error: owned.error },
        { status: owned.error === "NOT_SELLER" ? 403 : 404 },
      );
    }
    // Only a draft can be deleted by the seller — a live/pending item is the
    // platform's to manage (delist via admin).
    if (owned.listing.status !== "draft") {
      return Response.json(
        { error: "ONLY_DRAFT_DELETABLE", status: owned.listing.status },
        { status: 409 },
      );
    }
    await db
      .delete(schema.listings)
      .where(
        and(
          eq(schema.listings.id, id),
          eq(schema.listings.status, "draft"),
        ),
      );
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
