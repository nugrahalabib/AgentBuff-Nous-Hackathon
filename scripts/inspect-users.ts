/**
 * List all users + their container state so we can pick a safe target
 * for Hermes provisioning test (without destroying the chief's running
 * OpenClaw container).
 */
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  const result = await db.execute(sql`
    SELECT u.id, u.email, u.name, uc.engine_type, uc.status, uc.container_name, uc.port
    FROM "user" u
    LEFT JOIN user_container uc ON uc.user_id = u.id
    ORDER BY u.email NULLS LAST
  `);
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  console.log("Users + containers:");
  for (const r of rows as Array<Record<string, string | null>>) {
    console.log(
      `  - ${(r.email ?? "<no-email>").padEnd(38)} userId=${r.id?.slice(0, 8)} engine=${r.engine_type ?? "<none>"} status=${r.status ?? "<no-container>"} port=${r.port ?? "-"}`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
