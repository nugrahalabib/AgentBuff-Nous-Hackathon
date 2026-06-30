import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createCharge } from "@/lib/midtrans";
import { installSkillForTransaction } from "@/lib/billing/skill-installer";
import { isAtSkillCap } from "@/lib/admin/limits";
import { isStaleSessionError } from "@/lib/billing/db-errors";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// C3 Phase B — purchase a marketplace LISTING (vs the static skill catalog).
// Reuses transaction.type='skill-install' + metadata.source='marketplace' so
// settlement (commission ledger), install dispatch, retry, and self-heal all
// flow through the existing machinery. Free listings settle inline (no charge,
// no ledger row — net is 0).
const purchaseSchema = z.object({
  listingId: z.string().min(1).max(100),
  paymentType: z.enum(["qris", "gopay", "bank_transfer"]),
});

const CHARGE_LIMIT = 30;
const CHARGE_WINDOW_MS = 10 * 60_000;
const RECENT_PENDING_MS = 15 * 60_000;

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    const ip = clientIpFromRequest(req);

    const rl = take(
      keyFromRequest("billing.charge", req, userId),
      CHARGE_LIMIT,
      CHARGE_WINDOW_MS,
    );
    if (!rl.ok) {
      auditLog({
        event: "rate_limit.exceeded",
        outcome: "reject",
        actor: userId,
        ip,
        details: { ns: "billing.charge.listing" },
      });
      return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    const { listingId, paymentType } = parsed.data;

    const [listing] = await db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId))
      .limit(1);
    if (!listing)
      return Response.json({ error: "LISTING_NOT_FOUND" }, { status: 404 });

    // Only published listings are buyable (guards a crafted request even though
    // the shop only renders published items with a buy button).
    if (listing.status !== "published") {
      auditLog({
        event: "billing.charge.create",
        outcome: "reject",
        actor: userId,
        target: listingId,
        ip,
        details: { kind: "listing", reason: `status=${listing.status}` },
      });
      return Response.json({ error: "LISTING_NOT_AVAILABLE" }, { status: 409 });
    }

    const [seller] = await db
      .select({ id: schema.sellers.id, status: schema.sellers.status })
      .from(schema.sellers)
      .where(eq(schema.sellers.id, listing.sellerId))
      .limit(1);
    if (!seller || seller.status !== "active")
      return Response.json({ error: "LISTING_NOT_AVAILABLE" }, { status: 409 });

    // Already owned — don't let a user pay twice for the same item.
    const [owned] = await db
      .select({ id: schema.containerSkills.id })
      .from(schema.containerSkills)
      .where(
        and(
          eq(schema.containerSkills.userId, userId),
          eq(schema.containerSkills.marketplaceItemId, listingId),
        ),
      )
      .limit(1);
    if (owned)
      return Response.json({ error: "ALREADY_OWNED" }, { status: 409 });

    // Per-tier cap (D7): block a NEW listing purchase at the tier installed-skill
    // limit (already-owned is handled above, so this only fires for new items).
    if (await isAtSkillCap(userId))
      return Response.json({ error: "SKILL_LIMIT_REACHED" }, { status: 409 });

    // In-flight charge for the same listing → don't mint a second order.
    const [pending] = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.type, "skill-install"),
          eq(schema.transactions.status, "pending"),
          sql`${schema.transactions.metadata}->>'listingId' = ${listingId}`,
          gt(
            schema.transactions.createdAt,
            new Date(Date.now() - RECENT_PENDING_MS),
          ),
        ),
      )
      .limit(1);
    if (pending)
      return Response.json(
        { error: "PENDING_ORDER_EXISTS", transactionId: pending.id },
        { status: 409 },
      );

    const priceRp = listing.priceRp;
    const orderId = `MKT-${userId.slice(0, 8)}-${Date.now()}`;
    const metadata = {
      source: "marketplace" as const,
      listingId,
      sellerId: listing.sellerId,
      version: listing.version ?? null,
    };

    // Free listing → settle inline: no charge, no payout ledger (net is 0).
    if (priceRp <= 0) {
      const now = new Date();
      const [tx] = await db
        .insert(schema.transactions)
        .values({
          userId,
          type: "skill-install",
          description: listing.title,
          amountRp: 0,
          energyDelta: 0,
          status: "completed",
          paidAt: now,
          midtransOrderId: orderId,
          sku: listing.slug,
          metadata,
        })
        .returning({ id: schema.transactions.id });
      auditLog({
        event: "billing.charge.create",
        outcome: "ok",
        actor: userId,
        target: orderId,
        ip,
        details: { kind: "listing", listingId, amountRp: 0, free: true },
      });
      void installSkillForTransaction(tx.id).catch((e) =>
        console.error("[listing POST] free install dispatch failed:", e),
      );
      return Response.json({ free: true, transactionId: tx.id });
    }

    const [tx] = await db
      .insert(schema.transactions)
      .values({
        userId,
        type: "skill-install",
        description: listing.title,
        amountRp: priceRp,
        energyDelta: 0,
        status: "pending",
        midtransOrderId: orderId,
        sku: listing.slug,
        metadata,
      })
      .returning({ id: schema.transactions.id });

    let charge: Awaited<ReturnType<typeof createCharge>>;
    try {
      charge = await createCharge({
        orderId,
        grossAmount: priceRp,
        paymentType,
        customerEmail: session.user.email ?? undefined,
        itemDetails: [
          { id: listing.slug, price: priceRp, quantity: 1, name: listing.title },
        ],
      });
    } catch {
      await db
        .update(schema.transactions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(schema.transactions.id, tx.id));
      return Response.json({ error: "CHARGE_FAILED" }, { status: 502 });
    }

    auditLog({
      event: "billing.charge.create",
      outcome: "ok",
      actor: userId,
      target: orderId,
      ip,
      details: { kind: "listing", listingId, amountRp: priceRp, paymentType },
    });

    return Response.json({ ...charge, transactionId: tx.id });
  } catch (e) {
    if (isStaleSessionError(e))
      return Response.json({ error: "SESSION_INVALID" }, { status: 401 });
    console.error("[listing POST]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
