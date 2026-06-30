import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createCharge } from "@/lib/midtrans";
import { getSkill } from "@/lib/billing/skill-catalog";
import { isAtSkillCap } from "@/lib/admin/limits";
import { isStaleSessionError } from "@/lib/billing/db-errors";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const purchaseSchema = z.object({
  skillKey: z.string().min(1).max(100),
  paymentType: z.enum(["qris", "gopay", "bank_transfer"]),
});

// 30 charge attempts per user per 10 minutes — covers browse-and-try patterns
// while cutting off runaway retries.
const CHARGE_LIMIT = 30;
const CHARGE_WINDOW_MS = 10 * 60_000;

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
        details: { ns: "billing.charge.skill" },
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

    const { skillKey, paymentType } = parsed.data;
    const skill = await getSkill(skillKey);
    if (!skill)
      return Response.json({ error: "SKILL_NOT_FOUND" }, { status: 404 });

    // Refuse to charge for items whose web app + MCP aren't live yet. The Shop
    // renders these as "Segera Hadir" (no Buy button), but guard the API too so
    // a crafted request can't pay for a vacuum. (Chief 2026-06-02.)
    if (skill.status !== "available") {
      auditLog({
        event: "billing.charge.create",
        outcome: "reject",
        actor: userId,
        target: skillKey,
        ip,
        details: { kind: "skill", sku: skillKey, reason: "coming_soon" },
      });
      return Response.json({ error: "SKILL_NOT_AVAILABLE" }, { status: 409 });
    }

    // Per-tier cap (D7): block a NEW skill purchase at the tier limit. A
    // re-purchase of an already-owned skill is idempotent (upsert) — not blocked.
    const [owned] = await db
      .select({ id: schema.containerSkills.id })
      .from(schema.containerSkills)
      .where(
        and(
          eq(schema.containerSkills.userId, userId),
          eq(schema.containerSkills.skillKey, skillKey),
        ),
      )
      .limit(1);
    if (!owned && (await isAtSkillCap(userId))) {
      auditLog({
        event: "billing.charge.create",
        outcome: "reject",
        actor: userId,
        target: skillKey,
        ip,
        details: { kind: "skill", sku: skillKey, reason: "skill_limit" },
      });
      return Response.json({ error: "SKILL_LIMIT_REACHED" }, { status: 409 });
    }

    const orderId = `SKILL-${userId.slice(0, 8)}-${Date.now()}`;

    const [tx] = await db
      .insert(schema.transactions)
      .values({
        userId,
        type: "skill-install",
        description: skill.title,
        amountRp: skill.priceRp,
        energyDelta: 0,
        status: "pending",
        midtransOrderId: orderId,
        sku: skillKey,
        metadata: { version: skill.version ?? null, source: skill.source },
      })
      .returning({ id: schema.transactions.id });

    // Mark the row failed if the charge call throws, so it can't sit 'pending'
    // forever (no webhook resolves an order that was never registered).
    let charge: Awaited<ReturnType<typeof createCharge>>;
    try {
      charge = await createCharge({
        orderId,
        grossAmount: skill.priceRp,
        paymentType,
        customerEmail: session.user.email ?? undefined,
        itemDetails: [
          { id: skill.key, price: skill.priceRp, quantity: 1, name: skill.title },
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
      details: { kind: "skill", sku: skillKey, amountRp: skill.priceRp, paymentType },
    });

    return Response.json({ ...charge, transactionId: tx.id });
  } catch (e) {
    if (isStaleSessionError(e))
      return Response.json({ error: "SESSION_INVALID" }, { status: 401 });
    console.error("[skill POST]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
