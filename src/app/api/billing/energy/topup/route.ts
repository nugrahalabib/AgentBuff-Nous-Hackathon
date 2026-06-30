import { eq, and } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createCharge } from "@/lib/midtrans";
import { hermesConfig } from "@/lib/hermes/config";
import { isStaleSessionError } from "@/lib/billing/db-errors";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const topupSchema = z.object({
  bundleId: z.string().min(1).max(100),
  paymentType: z.enum(["qris", "gopay", "bank_transfer"]),
});

const CHARGE_LIMIT = 30;
const CHARGE_WINDOW_MS = 10 * 60_000;

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    // Energy system OFF (BYOK) — no top-up charges while the flag is off.
    if (!hermesConfig.energyGateEnabled)
      return Response.json({ error: "ENERGY_DISABLED" }, { status: 503 });
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
        details: { ns: "billing.charge.topup" },
      });
      return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    const body = await req.json();
    const parsed = topupSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );

    const { bundleId, paymentType } = parsed.data;

    const [bundle] = await db
      .select()
      .from(schema.energyBundles)
      .where(
        and(
          eq(schema.energyBundles.id, bundleId),
          eq(schema.energyBundles.active, true),
        ),
      );

    if (!bundle)
      return Response.json({ error: "BUNDLE_NOT_FOUND" }, { status: 404 });

    const orderId = `TOP-${userId.slice(0, 8)}-${Date.now()}`;
    const energyDelta = bundle.energy + bundle.bonusEnergy;

    const [tx] = await db
      .insert(schema.transactions)
      .values({
        userId,
        type: "topup",
        description: bundle.name,
        amountRp: bundle.priceRp,
        energyDelta,
        status: "pending",
        midtransOrderId: orderId,
      })
      .returning({ id: schema.transactions.id });

    // If the charge call fails, mark the just-inserted row 'failed' so it can't
    // sit 'pending' forever (no webhook resolves an order never registered).
    let charge: Awaited<ReturnType<typeof createCharge>>;
    try {
      charge = await createCharge({
        orderId,
        grossAmount: bundle.priceRp,
        paymentType,
        customerEmail: session.user.email ?? undefined,
        itemDetails: [
          { id: bundle.id, price: bundle.priceRp, quantity: 1, name: bundle.name },
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
      details: { kind: "topup", bundleId, amountRp: bundle.priceRp, paymentType },
    });

    return Response.json({ ...charge, transactionId: tx.id });
  } catch (e) {
    if (isStaleSessionError(e))
      return Response.json({ error: "SESSION_INVALID" }, { status: 401 });
    console.error("[topup POST]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
