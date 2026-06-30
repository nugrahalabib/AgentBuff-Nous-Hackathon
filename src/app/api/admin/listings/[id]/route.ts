import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const STATUSES = new Set([
  "draft",
  "pending",
  "approved",
  "published",
  "rejected",
  "delisted",
]);

// Lifecycle DAG (PRD D4: draft -> pending -> approved -> published ->
// delisted/rejected) plus sensible admin recovery edges. A status change must
// be in the source status's allowed set, so the approval queue can't be bypassed
// (e.g. rejected -> published directly). Same -> same is always allowed so an
// admin can edit reviewNotes without a transition.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending", "published", "rejected"],
  pending: ["approved", "rejected", "published", "draft"],
  approved: ["published", "rejected", "delisted"],
  published: ["delisted", "rejected"],
  rejected: ["pending", "draft"],
  delisted: ["published", "pending", "draft"],
};

// Listing status transition + review notes (Fase C / D4). Mutation — admin only.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      reviewNotes?: string;
    };
    const status = body.status ?? "";
    if (!STATUSES.has(status)) {
      return Response.json({ error: "INVALID_STATUS" }, { status: 400 });
    }

    // DAG guard: read the current status and reject illegal transitions so the
    // review queue can't be skipped. Read-before-write (admin-only route, low
    // volume — no need for a CAS) ; NOT_FOUND is surfaced here too.
    const [current] = await db
      .select({ status: schema.listings.status })
      .from(schema.listings)
      .where(eq(schema.listings.id, id))
      .limit(1);
    if (!current) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (
      current.status !== status &&
      !(ALLOWED_TRANSITIONS[current.status] ?? []).includes(status)
    ) {
      return Response.json(
        { error: "INVALID_TRANSITION", from: current.status, to: status },
        { status: 409 },
      );
    }

    const now = new Date();
    const updates: {
      status: string;
      updatedAt: Date;
      reviewNotes?: string;
      publishedAt?: Date;
    } = { status, updatedAt: now };
    if (typeof body.reviewNotes === "string") {
      updates.reviewNotes = body.reviewNotes.slice(0, 1000);
    }
    if (status === "published") updates.publishedAt = now;

    const res = await db
      .update(schema.listings)
      .set(updates)
      .where(eq(schema.listings.id, id))
      .returning({ id: schema.listings.id });
    if (res.length === 0) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    auditLog({
      event: "admin.listing.update",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: { status },
    });
    return Response.json({ ok: true, status });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
