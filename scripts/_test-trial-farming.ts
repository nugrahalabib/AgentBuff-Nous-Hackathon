// Throwaway: prove the one-time-trial ledger — a deleted-then-re-registered
// email cannot farm a fresh 14-day trial. Mirrors the gate logic in
// complete/route.ts against the REAL DB (trial_grant must survive user delete).
//   pnpm tsx --env-file=.env.local scripts/_test-trial-farming.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hashEmail } from "@/lib/crypto";

const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log("  PASS ", msg); }
  else { fail++; console.log("  FAIL ", msg); }
};

// Identical decision to complete/route.ts.
async function grantTrial(userId: string, email: string): Promise<string> {
  return db.transaction(async (tx) => {
    const emailHash = hashEmail(email);
    const now = new Date();
    const trialEnds = new Date(now.getTime() + TRIAL_MS);
    const [existingTrial] = await tx
      .select({ status: schema.userTrials.status })
      .from(schema.userTrials)
      .where(eq(schema.userTrials.userId, userId))
      .limit(1);
    const [priorGrant] = await tx
      .select({ emailHash: schema.trialGrants.emailHash })
      .from(schema.trialGrants)
      .where(eq(schema.trialGrants.emailHash, emailHash))
      .limit(1);
    const trialUsedBefore =
      Boolean(priorGrant) && existingTrial?.status !== "active";
    const status = trialUsedBefore ? "expired" : "active";
    const endsAt = trialUsedBefore ? now : trialEnds;
    await tx
      .insert(schema.userTrials)
      .values({ userId, startedAt: now, endsAt, status })
      .onConflictDoUpdate({
        target: schema.userTrials.userId,
        set: { startedAt: now, endsAt, status },
      });
    if (!priorGrant) {
      await tx.insert(schema.trialGrants).values({ emailHash }).onConflictDoNothing();
    }
    return status;
  });
}

async function main() {
  const stamp = Date.now();
  const email = `farmtest-${stamp}@example.com`;
  const eh = hashEmail(email);
  const u1 = `farm-u1-${stamp}`;
  const u2 = `farm-u2-${stamp}`;
  try {
    await db.delete(schema.trialGrants).where(eq(schema.trialGrants.emailHash, eh));

    console.log("[1] First-timer");
    await db.insert(schema.users).values({ id: u1, email });
    ok((await grantTrial(u1, email)) === "active", "first-timer gets ACTIVE trial");
    const [g] = await db.select().from(schema.trialGrants).where(eq(schema.trialGrants.emailHash, eh));
    ok(Boolean(g), "ledger row created on first grant");
    ok((await grantTrial(u1, email)) === "active", "first-timer re-complete STAYS active (idempotent)");

    console.log("[2] Delete account");
    await db.delete(schema.users).where(eq(schema.users.id, u1));
    const [t1] = await db.select().from(schema.userTrials).where(eq(schema.userTrials.userId, u1));
    ok(!t1, "trial row cascade-deleted with account");
    const [gAfter] = await db.select().from(schema.trialGrants).where(eq(schema.trialGrants.emailHash, eh));
    ok(Boolean(gAfter), "ledger SURVIVES account deletion (anti-farm core)");

    console.log("[3] Re-register same email");
    await db.insert(schema.users).values({ id: u2, email });
    ok((await grantTrial(u2, email)) === "expired", "re-registrant gets EXPIRED trial (no fresh 14 days)");
    ok((await grantTrial(u2, email)) === "expired", "re-registrant re-complete STAYS expired");

    console.log("[4] Different email is unaffected");
    const email3 = `fresh-${stamp}@example.com`;
    const u3 = `farm-u3-${stamp}`;
    await db.insert(schema.users).values({ id: u3, email: email3 });
    ok((await grantTrial(u3, email3)) === "active", "a brand-new email still gets ACTIVE trial");
    await db.delete(schema.users).where(eq(schema.users.id, u3));
    await db.delete(schema.trialGrants).where(eq(schema.trialGrants.emailHash, hashEmail(email3)));

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  } finally {
    await db.delete(schema.users).where(eq(schema.users.id, u2));
    await db.delete(schema.trialGrants).where(eq(schema.trialGrants.emailHash, eh));
    console.log("[cleanup] throwaway users + ledger rows removed");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
