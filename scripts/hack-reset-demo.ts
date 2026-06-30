/**
 * HACKATHON demo reset — put the demo back to its PRE-BUY start state so the
 * Chief can re-record cleanly:
 *   - delete the "berhasil dipasang" buy notifications
 *   - delete the demo buy transactions (sku=pos-umkm, payment_method=stripe_test)
 *   - delete the container_skill ownership row for pos-umkm
 *   - reset the demo wallet balance back to Rp 99.000 (the EARN state)
 * Keeps the EARN notification. Re-run scripts/hack-earn.ts if you want a fresh one.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/hack-reset-demo.ts [email]
 */
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { connectPosMcp } from "@/lib/hack/pos-mcp";

const EMAIL = process.argv[2] ?? "nugrahalabib@gmail.com";
const SLUG = "pos-umkm";
const SALDO = 99000;

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

  // Ensure the POS MCP is CONNECTED at clean-start so the demo works reliably in a
  // SINGLE chat thread (Hermes loads MCP tools at thread start — a mid-thread
  // connect isn't seen until a new thread). Buying pos-umkm re-runs this connect
  // idempotently and narrates "POS aktif", so the purchase still drives the beat.
  const [c] = await db
    .select({ containerName: schema.userContainers.containerName })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);
  if (c?.containerName) {
    const r = await connectPosMcp(c.containerName);
    console.log(`  POS MCP ensured connected for demo: ${r.status}`);
  }

  // Remove the install-success notifications (keep the EARN one).
  await db
    .delete(schema.notifications)
    .where(
      and(eq(schema.notifications.userId, userId), like(schema.notifications.text, "%berhasil dipasang%")),
    );

  // Remove the demo buy transactions.
  await db
    .delete(schema.transactions)
    .where(and(eq(schema.transactions.userId, userId), eq(schema.transactions.sku, SLUG)));

  // Remove the ownership row (best-effort).
  try {
    await db
      .delete(schema.containerSkills)
      .where(and(eq(schema.containerSkills.userId, userId), eq(schema.containerSkills.skillKey, SLUG)));
  } catch {
    /* shape varies; non-fatal */
  }

  // Reset wallet to the EARN balance.
  await db
    .insert(schema.userEnergy)
    .values({ userId, balance: SALDO, maxBalance: SALDO })
    .onConflictDoUpdate({ target: schema.userEnergy.userId, set: { balance: SALDO, maxBalance: SALDO } });

  console.log(`Reset done for ${EMAIL}: buy tx + install notif cleared, saldo → Rp ${SALDO.toLocaleString("id-ID")}.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
