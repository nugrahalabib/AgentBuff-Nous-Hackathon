/**
 * Inspect container_port_slot pool state.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

async function main() {
  const slotsResult = (await db.execute(
    sql`SELECT COUNT(*) AS total FROM container_port_slot`,
  )) as unknown as Array<{ total: string }>;
  console.log(`raw slotsResult:`, slotsResult);
  console.log(`Total port slots: ${slotsResult[0]?.total ?? "(empty)"}`);

  const freeResult = (await db.execute(
    sql`SELECT COUNT(*) AS free FROM container_port_slot WHERE user_id IS NULL`,
  )) as unknown as Array<{ free: string }>;
  console.log(`Free port slots: ${freeResult[0]?.free ?? "(empty)"}`);

  const takenResult = (await db.execute(sql`
    SELECT port, user_id FROM container_port_slot WHERE user_id IS NOT NULL LIMIT 10
  `)) as unknown as Array<{ port: number; user_id: string }>;
  console.log(`Taken slots (first 10):`);
  for (const r of takenResult) console.log(`  port=${r.port} userId=${r.user_id?.slice(0, 8)}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
