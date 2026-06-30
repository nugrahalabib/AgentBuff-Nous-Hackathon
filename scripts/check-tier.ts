import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";

async function main() {
  const [row] = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  const sub = await resolveSubscription(row.userId);
  console.log(JSON.stringify(sub, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
