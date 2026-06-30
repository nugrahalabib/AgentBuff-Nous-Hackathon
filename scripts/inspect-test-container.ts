/**
 * Inspect the test user's container row to see provisioning state.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

async function main() {
  const result = (await db.execute(sql`
    SELECT id, user_id, engine_type, status, port, container_name, error_message, provision_attempts, created_at
    FROM user_container
    ORDER BY created_at DESC
  `)) as unknown as Array<Record<string, unknown>>;

  for (const r of result) {
    console.log("---");
    for (const [k, v] of Object.entries(r)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
