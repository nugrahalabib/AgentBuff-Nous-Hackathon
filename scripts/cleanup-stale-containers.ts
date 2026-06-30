import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db.select().from(schema.userContainers);
  console.log(`Found ${rows.length} user_container rows. Deleting all (LOCAL-mode leftovers)…`);
  await db.delete(schema.userContainers);
  await db.execute(sql`UPDATE container_port_slot SET user_id = NULL, claimed_at = NULL`);
  console.log("Cleared. Users will re-provision on next login.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
