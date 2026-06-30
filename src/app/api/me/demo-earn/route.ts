import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { stripeChargeIdr } from "@/lib/hack/stripe";

export const dynamic = "force-dynamic";

// Demo EARN beat (hackathon Babak 1): a REAL Stripe TEST charge representing
// INCOME — another user bought a skill the Chief published on BuffHub. It lands
// in the Stripe test dashboard so judges can verify the agent genuinely EARNS
// (not only SPENDS). The skill is deliberately NOT pos-umkm — that's the one the
// agent BUYS later in the demo, so they must be different to avoid confusion.
const EARN_SKILL = "Researcher Analyst";
const EARN_SLUG = "researcher-analyst";
const AMOUNT_RP = 99_000;

export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });

  const charge = await stripeChargeIdr({
    amountRp: AMOUNT_RP,
    description: `BuffHub: someone bought your '${EARN_SKILL}' skill`,
    metadata: { kind: "buffhub_earn", skill: EARN_SLUG },
    customer: { name: "BuffHub Buyer", email: "buyer@buffhub.demo" },
  });
  if (!charge.ok || !charge.id) {
    return NextResponse.json(
      { ok: false, error: charge.error ?? "STRIPE_FAILED" },
      { status: 200 },
    );
  }

  const now = new Date();
  await db.insert(schema.transactions).values({
    userId,
    type: "skill-sale",
    description: `Someone bought your '${EARN_SKILL}' skill on BuffHub`,
    amountRp: AMOUNT_RP,
    status: "completed",
    sku: EARN_SLUG,
    paymentRef: charge.id,
    paymentMethod: "stripe_test",
    paidAt: now,
    midtransOrderId: `hack-earn-${now.getTime()}`,
  });

  return NextResponse.json({
    ok: true,
    skill: EARN_SKILL,
    amountRp: AMOUNT_RP,
    stripePaymentIntent: charge.id,
  });
}
