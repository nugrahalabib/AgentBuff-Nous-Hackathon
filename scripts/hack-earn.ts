/**
 * HACKATHON demo — seed the EARN beat: a REAL Stripe test PaymentIntent (lands
 * in the test dashboard) + an in-app notification + a demo "Saldo Agen" balance.
 * Story: someone bought the skill the Chief published in BuffHub → agent got paid.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/hack-earn.ts [email]
 */
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { stripeChargeIdr } from "@/lib/hack/stripe";

const EMAIL = process.argv[2] ?? "nugrahalabib@gmail.com";
const AMOUNT_RP = 99000;

async function stripeCharge(): Promise<string | null> {
  const charge = await stripeChargeIdr({
    amountRp: AMOUNT_RP,
    description: "BuffHub payout: someone bought your 'Researcher Analyst' skill",
    metadata: { kind: "buffhub_payout", skill: "researcher-analyst" },
    customer: { name: "BuffHub Buyer", email: "buyer@buffhub.demo" },
  });
  if (!charge.ok) {
    console.warn("[stripe] earn charge failed (non-fatal):", charge.error);
    return null;
  }
  console.log(`[stripe] PaymentIntent ${charge.id} (Rp ${AMOUNT_RP.toLocaleString("id-ID")})`);
  return charge.id;
}

async function main() {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, EMAIL))
    .limit(1);
  if (!user) {
    console.error(`No user for ${EMAIL}`);
    process.exit(1);
  }
  const userId = user.id;

  const pi = await stripeCharge();

  // Idempotent: clear any prior earn notification so re-running never piles up a
  // duplicate or leaves a stale (pre-fix currency) one behind. The pi_ id is NOT
  // embedded in user-facing text — it lives only in the Stripe dashboard + logs.
  await db
    .delete(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), like(schema.notifications.text, "Income received%")));

  await db.insert(schema.notifications).values({
    userId,
    tab: "shop",
    icon: "sparkles",
    highPriority: true,
    text:
      "Income received! Your agent earned Rp 99.000 — someone bought your 'Researcher Analyst' skill on BuffHub.",
    actionLabel: "View Item Shop",
    actionHref: "/app/shop",
  });

  await db
    .insert(schema.userEnergy)
    .values({ userId, balance: AMOUNT_RP, maxBalance: AMOUNT_RP })
    .onConflictDoUpdate({
      target: schema.userEnergy.userId,
      set: { balance: AMOUNT_RP, maxBalance: AMOUNT_RP },
    });

  console.log(`EARN seeded for ${EMAIL}: notification + saldo Rp ${AMOUNT_RP.toLocaleString("id-ID")}${pi ? " + Stripe " + pi : ""}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
