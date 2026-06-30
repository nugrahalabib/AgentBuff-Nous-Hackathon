// READ-ONLY check of the trial lock logic against real data.
//   pnpm tsx --env-file=.env.local scripts/test-trial-access.ts
//
// No side effects — only SELECTs (resolveAccessState + resolveSubscription).
// Confirms: locked computation is sane, an active paid sub keeps locked=false,
// and the trial countdown reads correctly.

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveAccessState } from "@/lib/billing/trial-resolver";

async function main() {
  const users = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .limit(10);

  if (users.length === 0) {
    console.log("no user_container rows to check");
    return;
  }

  for (const u of users) {
    const a = await resolveAccessState(u.userId);
    const trial = a.trial
      ? `${a.trial.status}/${a.trial.daysLeft}d (ends ${a.trial.endsAt.slice(0, 10)})`
      : "none";
    console.log(
      `${u.userId.slice(0, 8)}  locked=${a.locked}  activeSub=${a.hasActiveSub}  trial=${trial}`,
    );
  }
  console.log("\n(read-only — no rows modified, no container touched)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
