// Grant testing-only Guild Master tier ke user existing supaya semua channel
// (Google Chat, Signal, iMessage, Nostr) tidak ke-locked di catalog selama
// testing manual. Insert subscription row dengan expiresAt 1 tahun ke depan.
//
//   pnpm tsx --env-file=.env.local scripts/grant-test-tier.ts grant
//   pnpm tsx --env-file=.env.local scripts/grant-test-tier.ts revoke
//
// REVOKE — set status='canceled' di row paling baru. Resolver akan degrade
// kembali ke starter default tanpa hapus history (audit log).

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const TEST_PRICE_RP = 0; // gratis untuk testing internal
const TEST_TIER: "guild_master" = "guild_master";
const TEST_BILLING: "yearly" = "yearly";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function pickUser(): Promise<{ userId: string }> {
  const [row] = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .limit(1);
  if (!row) throw new Error("no user_container row");
  return { userId: row.userId };
}

async function grant(userId: string) {
  // Check existing active row dulu — kalau sudah aktif dengan tier sama, skip.
  const [existing] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);

  const now = new Date();
  if (
    existing &&
    existing.status === "active" &&
    existing.tier === TEST_TIER &&
    existing.expiresAt > now
  ) {
    console.log(
      `user ${userId.slice(0, 8)} sudah ${TEST_TIER} (expires ${existing.expiresAt.toISOString()})`,
    );
    return;
  }

  const expiresAt = new Date(Date.now() + ONE_YEAR_MS);
  await db.insert(schema.subscriptions).values({
    userId,
    tier: TEST_TIER,
    billingCycle: TEST_BILLING,
    priceRp: TEST_PRICE_RP,
    status: "active",
    expiresAt,
    autoRenew: false, // testing — no real billing
  });
  console.log(
    `granted ${TEST_TIER} to ${userId.slice(0, 8)} (expires ${expiresAt.toISOString()})`,
  );
}

async function revoke(userId: string) {
  // Set semua row active untuk user ini ke status='canceled'.
  // Resolver akan degrade ke starter pada query berikutnya.
  const result = await db
    .update(schema.subscriptions)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        eq(schema.subscriptions.status, "active"),
      ),
    );
  console.log(`revoked active subscriptions for ${userId.slice(0, 8)}`);
  console.log("affected rows:", result);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "grant" && cmd !== "revoke") {
    console.error("usage: grant-test-tier.ts grant|revoke");
    process.exit(1);
  }
  const { userId } = await pickUser();
  console.log("user:", userId);
  if (cmd === "grant") await grant(userId);
  else await revoke(userId);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
