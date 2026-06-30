/**
 * Inspect current user_container columns so we can compare against the
 * new schema and decide whether the migration is safe.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/inspect-user-container-schema.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

async function main() {
  const result = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'user_container'
    ORDER BY ordinal_position
  `);
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  console.log("user_container columns:");
  for (const r of rows as Array<Record<string, string | null>>) {
    console.log(
      `  - ${r.column_name?.padEnd(28)} ${(r.data_type ?? "").padEnd(12)} nullable=${r.is_nullable} default=${r.column_default ?? "<none>"}`,
    );
  }

  const engineTypeRows = await db.execute(sql`
    SELECT COUNT(*) AS n FROM user_container
  `);
  const n = ((engineTypeRows as { rows?: Array<{ n: string }> }).rows ?? [])[0]?.n;
  console.log(`\nuser_container row count: ${n}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
