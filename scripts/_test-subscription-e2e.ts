// Throwaway: FULL subscription chain end-to-end, with email ON so the receipt
// + PDF struk actually land in the SMTP_USER inbox. Proves:
//   Snap token (real charge step) → settle (webhook path) → sub active +
//   trial converted (self-heal INSERT from tx.metadata) → receipt email + struk.
//   pnpm tsx --env-file=.env.local scripts/_test-subscription-e2e.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createSnapTransaction } from "@/lib/midtrans";
import { applySettlement } from "@/lib/billing/settle";

async function main() {
  const to = process.env.SMTP_USER;
  if (!to) {
    console.error("SMTP_USER not set — set it so the receipt has an inbox.");
    process.exit(1);
  }
  const uid = `subdemo-${Date.now()}`;
  const orderId = `SUB-${uid.slice(0, 10)}-${Date.now()}`;

  try {
    await db.insert(schema.users).values({ id: uid, email: to, name: "Sub Demo" });
    await db.insert(schema.userTrials).values({
      userId: uid,
      endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      status: "active",
    });

    // 1) Real Snap token — the charge step (proves the keys + endpoint work).
    const snap = await createSnapTransaction({
      orderId,
      grossAmount: 99000,
      customerEmail: to,
      itemDetails: [{ id: "op_buff", price: 99000, quantity: 1, name: "OP Buff (monthly)" }],
    });
    console.log("1) Snap token created:", snap.token.slice(0, 18) + "...");

    // 2) Transaction (exactly as the API writes it — metadata drives self-heal).
    await db.insert(schema.transactions).values({
      userId: uid,
      type: "subscription",
      description: "op_buff (monthly)",
      amountRp: 99000,
      status: "pending",
      midtransOrderId: orderId,
      metadata: { tier: "op_buff", billingCycle: "monthly" },
    });

    // 3) Settlement (what the Midtrans webhook triggers). Email is ON.
    //    Pass a payment method so the emailed struk exercises the "Metode Bayar"
    //    row of the redesigned receipt.
    await applySettlement(orderId, "99000.00", "demo-pay-ref", "127.0.0.1", "bank_transfer:bca");

    // 4) Verify the chain.
    const [tx] = await db
      .select({ status: schema.transactions.status })
      .from(schema.transactions)
      .where(eq(schema.transactions.midtransOrderId, orderId));
    const [sub] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.midtransOrderId, orderId));
    const [trial] = await db
      .select({ status: schema.userTrials.status })
      .from(schema.userTrials)
      .where(eq(schema.userTrials.userId, uid));

    console.log("2) transaction:", tx?.status);
    console.log(
      "3) subscription:",
      sub?.status,
      "| tier:",
      sub?.tier,
      "| expires:",
      sub?.expiresAt?.toISOString().slice(0, 10),
      "| autoRenew:",
      sub?.autoRenew,
    );
    console.log("4) trial:", trial?.status);
    console.log(`5) receipt email + PDF struk -> sent to ${to} (give it a few seconds)`);

    // Let the fire-and-forget receipt email actually flush before we exit.
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    await db.delete(schema.users).where(eq(schema.users.id, uid));
    console.log("\ncleanup: throwaway user deleted (cascade).");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
