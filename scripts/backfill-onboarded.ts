// One-shot backfill: grandfather existing accounts past the new onboarding gate.
//   pnpm tsx --env-file=.env.local scripts/backfill-onboarded.ts
//
// The Phase-4 gate flip means /app redirects any user with onboarded=false into
// the 6-step wizard. Accounts provisioned BEFORE onboarding existed already have
// a working container — they must not be dragged back through onboarding. This
// sets onboarded=true for every user who currently has a real container.
//
// Safe + idempotent: only flips the flag, touches nothing else. Re-runnable.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const LIVE_STATUSES = ["running", "stopped", "awaiting-health", "starting"] as const;

async function main() {
  const rows = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .where(inArray(schema.userContainers.status, [...LIVE_STATUSES]));

  if (rows.length === 0) {
    console.log("no live containers — nothing to backfill");
    return;
  }

  let updated = 0;
  for (const r of rows) {
    const res = await db
      .update(schema.userProfiles)
      .set({ onboarded: true, onboardingStep: 6, updatedAt: new Date() })
      .where(eq(schema.userProfiles.userId, r.userId))
      .returning({ userId: schema.userProfiles.userId });
    if (res.length > 0) {
      updated += 1;
      console.log(`  grandfathered ${r.userId.slice(0, 8)} -> onboarded=true`);
    }
  }
  console.log(`\nbackfilled ${updated}/${rows.length} existing container user(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
