// Backend E2E for the subscription renew/extend rules. Drives the REAL
// `applySettlement` settlement path against the dev DB (no mocks) and asserts
// the expiry math for every use-case the Chief named + the ones he didn't:
//
//   1. fresh subscribe (starter)          -> expiry = now + 1 period (RESET)
//   2. renew same cycle while active      -> expiry = prev_expiry + 1mo (EXTEND)
//   3. switch monthly -> yearly while active -> expiry = prev_expiry + 1yr (EXTEND)
//   4. lapsed (expiry in the past) re-sub -> expiry = now + 1 period (RESET)
//   5. canceled-not-expired renew         -> EXTEND from the future expiry + reactivate
//   6. idempotent settlement replay       -> no change (no double-extend)
//   7. NEVER more than one subscription row per user (no duplicate active rows)
//   8. amount-mismatch settlement         -> rejected, left pending, no effect
//
// Plus pure-function checks of the day-overflow clamp. Creates a throwaway test
// user and cascade-deletes it at the end; never touches a real account. Distinct
// from `_test-subscription-e2e.ts` (that one is a single fresh-subscribe demo
// with a real Snap token + receipt email — it does not exercise renewal).
//
// Run: pnpm tsx --env-file=.env.local scripts/test-subscription-renewal-e2e.ts

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { applySettlement } from "@/lib/billing/settle";
import { addCalendarPeriod, computeRenewalExpiry } from "@/lib/billing/period";

type Cycle = "monthly" | "yearly";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Equal to the millisecond — used for deterministic EXTEND assertions. */
function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

async function getSubRows(userId: string) {
  return db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId));
}

/** Insert a pending subscription tx then settle it through the real code path. */
async function settleSubscription(
  userId: string,
  amountRp: number,
  cycle: Cycle,
): Promise<void> {
  const orderId = `TEST-${userId.slice(-8)}-${cycle}-${process.hrtime.bigint()}`;
  await db.insert(schema.transactions).values({
    userId,
    type: "subscription",
    description: `TEST OP Buff (${cycle})`,
    amountRp,
    status: "pending",
    midtransOrderId: orderId,
    metadata: { tier: "op_buff", billingCycle: cycle },
  });
  await applySettlement(orderId, String(amountRp), `TESTREF-${orderId}`, null);
}

async function main() {
  // ── Pure date-math checks (clamp correctness) ──────────────────────────────
  console.log("\n[A] Pure period math");
  check(
    "Jan 31 + 1mo clamps to Feb 28 (non-leap 2026)",
    sameInstant(
      addCalendarPeriod(new Date("2026-01-31T08:00:00Z"), "monthly"),
      new Date("2026-02-28T08:00:00Z"),
    ),
  );
  check(
    "Feb 29 (leap) + 1yr clamps to Feb 28",
    sameInstant(
      addCalendarPeriod(new Date("2028-02-29T08:00:00Z"), "yearly"),
      new Date("2029-02-28T08:00:00Z"),
    ),
  );
  check(
    "Aug 31 + 1mo clamps to Sep 30",
    sameInstant(
      addCalendarPeriod(new Date("2026-08-31T08:00:00Z"), "monthly"),
      new Date("2026-09-30T08:00:00Z"),
    ),
  );
  const now = new Date();
  const future = new Date(now.getTime() + 10 * 24 * 3600_000);
  check(
    "computeRenewalExpiry EXTENDS from a future expiry",
    computeRenewalExpiry(future, "monthly", now).isExtension &&
      sameInstant(
        computeRenewalExpiry(future, "monthly", now).expiresAt,
        addCalendarPeriod(future, "monthly"),
      ),
  );
  const past = new Date(now.getTime() - 10 * 24 * 3600_000);
  check(
    "computeRenewalExpiry RESETS from now when expiry is past",
    !computeRenewalExpiry(past, "monthly", now).isExtension,
  );
  check(
    "computeRenewalExpiry RESETS from now when no current expiry",
    !computeRenewalExpiry(null, "yearly", now).isExtension,
  );

  // ── DB integration through the real applySettlement ────────────────────────
  const userId = `test-renew-${Date.now()}`;
  await db.insert(schema.users).values({
    id: userId,
    name: "Renewal Test",
    email: `${userId}@example.invalid`,
  });

  try {
    // 1) Fresh subscribe (no prior sub) -> RESET from now.
    console.log("\n[B] Fresh subscribe (starter -> active)");
    let before = new Date();
    await settleSubscription(userId, 99_000, "monthly");
    let after = new Date();
    let rows = await getSubRows(userId);
    check("exactly one sub row after fresh subscribe", rows.length === 1, `got ${rows.length}`);
    check("status active", rows[0]?.status === "active");
    check("billingCycle monthly", rows[0]?.billingCycle === "monthly");
    check(
      "expiry ~ now + 1 month (reset)",
      rows[0] != null &&
        rows[0].expiresAt.getTime() >= addCalendarPeriod(before, "monthly").getTime() - 60_000 &&
        rows[0].expiresAt.getTime() <= addCalendarPeriod(after, "monthly").getTime() + 60_000,
      rows[0] ? rows[0].expiresAt.toISOString() : "no row",
    );
    const freshExpiry = rows[0]!.expiresAt;

    // 2) Renew same cycle while active -> EXTEND from the current expiry.
    console.log("\n[C] Renew monthly while active (EXTEND)");
    await settleSubscription(userId, 99_000, "monthly");
    rows = await getSubRows(userId);
    check("still exactly one sub row (no duplicate)", rows.length === 1, `got ${rows.length}`);
    check(
      "expiry = previous expiry + 1 month (stacked, NOT reset)",
      rows[0] != null && sameInstant(rows[0].expiresAt, addCalendarPeriod(freshExpiry, "monthly")),
      rows[0]
        ? `${rows[0].expiresAt.toISOString()} vs expected ${addCalendarPeriod(freshExpiry, "monthly").toISOString()}`
        : "no row",
    );
    const monthlyRenewExpiry = rows[0]!.expiresAt;

    // 3) Switch to yearly while active -> EXTEND by 1 year from current expiry.
    console.log("\n[D] Switch to yearly while active (EXTEND 1yr)");
    await settleSubscription(userId, 990_000, "yearly");
    rows = await getSubRows(userId);
    check("still exactly one sub row", rows.length === 1, `got ${rows.length}`);
    check("billingCycle switched to yearly", rows[0]?.billingCycle === "yearly");
    check("priceRp updated to yearly", rows[0]?.priceRp === 990_000, String(rows[0]?.priceRp));
    check(
      "expiry = previous expiry + 1 year (stacked)",
      rows[0] != null && sameInstant(rows[0].expiresAt, addCalendarPeriod(monthlyRenewExpiry, "yearly")),
      rows[0] ? rows[0].expiresAt.toISOString() : "no row",
    );

    // 4) Lapsed (expiry in the past) re-subscribe -> RESET from now.
    console.log("\n[E] Lapsed re-subscribe (RESET from now)");
    const pastDate = new Date(Date.now() - 5 * 24 * 3600_000);
    await db
      .update(schema.subscriptions)
      .set({ expiresAt: pastDate })
      .where(eq(schema.subscriptions.userId, userId));
    before = new Date();
    await settleSubscription(userId, 99_000, "monthly");
    after = new Date();
    rows = await getSubRows(userId);
    check("still exactly one sub row", rows.length === 1, `got ${rows.length}`);
    check("reactivated to active", rows[0]?.status === "active");
    check(
      "expiry ~ now + 1 month (reset, NOT past + 1mo)",
      rows[0] != null &&
        rows[0].expiresAt.getTime() >= addCalendarPeriod(before, "monthly").getTime() - 60_000 &&
        rows[0].expiresAt.getTime() <= addCalendarPeriod(after, "monthly").getTime() + 60_000,
      rows[0] ? rows[0].expiresAt.toISOString() : "no row",
    );

    // 5) Canceled-not-expired renew -> EXTEND from the future expiry + reactivate.
    console.log("\n[F] Canceled-not-expired renew (EXTEND + reactivate)");
    const futureExpiry = new Date(Date.now() + 8 * 24 * 3600_000);
    await db
      .update(schema.subscriptions)
      .set({ status: "canceled", expiresAt: futureExpiry })
      .where(eq(schema.subscriptions.userId, userId));
    await settleSubscription(userId, 99_000, "monthly");
    rows = await getSubRows(userId);
    check("still exactly one sub row", rows.length === 1, `got ${rows.length}`);
    check("reactivated active (from canceled)", rows[0]?.status === "active");
    check(
      "expiry = future canceled expiry + 1 month (extended)",
      rows[0] != null && sameInstant(rows[0].expiresAt, addCalendarPeriod(futureExpiry, "monthly")),
      rows[0] ? rows[0].expiresAt.toISOString() : "no row",
    );

    // 6) Idempotent replay -> re-settling a completed order must NOT extend again.
    console.log("\n[G] Idempotent settlement replay");
    const replayOrder = `TEST-${userId.slice(-8)}-replay-${process.hrtime.bigint()}`;
    await db.insert(schema.transactions).values({
      userId,
      type: "subscription",
      description: "TEST OP Buff (monthly) replay",
      amountRp: 99_000,
      status: "pending",
      midtransOrderId: replayOrder,
      metadata: { tier: "op_buff", billingCycle: "monthly" },
    });
    await applySettlement(replayOrder, "99000", "ref1", null);
    rows = await getSubRows(userId);
    const afterFirstSettle = rows[0]!.expiresAt;
    await applySettlement(replayOrder, "99000", "ref1", null); // replay
    rows = await getSubRows(userId);
    check(
      "replay did not extend a second time",
      rows[0] != null && sameInstant(rows[0].expiresAt, afterFirstSettle),
      rows[0] ? rows[0].expiresAt.toISOString() : "no row",
    );
    check("replay kept exactly one sub row", rows.length === 1, `got ${rows.length}`);

    // 7) Amount-mismatch settlement must be rejected (no effect).
    console.log("\n[H] Amount-mismatch rejection");
    const badOrder = `TEST-${userId.slice(-8)}-bad-${process.hrtime.bigint()}`;
    await db.insert(schema.transactions).values({
      userId,
      type: "subscription",
      description: "TEST OP Buff bad amount",
      amountRp: 99_000,
      status: "pending",
      midtransOrderId: badOrder,
      metadata: { tier: "op_buff", billingCycle: "monthly" },
    });
    const beforeBad = rows[0]!.expiresAt;
    await applySettlement(badOrder, "1000", null, null); // gross != recorded
    rows = await getSubRows(userId);
    const [badTx] = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.midtransOrderId, badOrder),
          eq(schema.transactions.userId, userId),
        ),
      );
    check("mismatched-amount tx left pending", badTx?.status === "pending", badTx?.status);
    check(
      "mismatched-amount settlement did not change expiry",
      rows[0] != null && sameInstant(rows[0].expiresAt, beforeBad),
    );

    // 9) An op_buff settlement must NOT downgrade an active guild_master sub.
    console.log("\n[I] guild_master no-downgrade guard");
    const gmExpiry = new Date(Date.now() + 30 * 24 * 3600_000);
    await db
      .update(schema.subscriptions)
      .set({ tier: "guild_master", status: "active", expiresAt: gmExpiry })
      .where(eq(schema.subscriptions.userId, userId));
    const gmOrder = `TEST-${userId.slice(-8)}-gm-${process.hrtime.bigint()}`;
    await db.insert(schema.transactions).values({
      userId,
      type: "subscription",
      description: "TEST op_buff vs guild_master",
      amountRp: 99_000,
      status: "pending",
      midtransOrderId: gmOrder,
      metadata: { tier: "op_buff", billingCycle: "monthly" },
    });
    await applySettlement(gmOrder, "99000", null, null);
    rows = await getSubRows(userId);
    const [gmTx] = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.midtransOrderId, gmOrder),
          eq(schema.transactions.userId, userId),
        ),
      );
    check("guild_master tier preserved (not downgraded)", rows[0]?.tier === "guild_master", rows[0]?.tier);
    check("guild_master expiry unchanged", rows[0] != null && sameInstant(rows[0].expiresAt, gmExpiry));
    check("op_buff tx still completed (paid -> manual credit, not stranded)", gmTx?.status === "completed", gmTx?.status);
  } finally {
    // Cascade cleanup (sub, tx, energy, notifications all FK -> user).
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    console.log(`\n[cleanup] removed test user ${userId}`);
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
