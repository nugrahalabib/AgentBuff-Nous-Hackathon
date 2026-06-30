// Diagnostic: EXHAUSTIVE clean-state check. Dynamically enumerates EVERY table
// in the public schema (so nothing is missed), counts each, and flags any
// user-data/credential table that still has rows. Config/seed tables (port
// pool, energy bundles) are expected to have rows and are reported separately.
// Run: pnpm tsx --env-file=.env.local scripts/_verify-clean.ts
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// Tables that legitimately keep rows even on a "clean" system (definitions /
// pools, not user data). Everything else must be 0.
const CONFIG_TABLES = new Set([
  "energy_bundle", // bundle catalog (seed)
  "container_port_slot", // port pool rows stay; only user_id must be NULL
  "__drizzle_migrations", // migration ledger
  "drizzle_migrations",
]);

async function rows<T extends Record<string, unknown> = Record<string, unknown>>(
  q: ReturnType<typeof sql.raw>,
): Promise<T[]> {
  const r = await db.execute<T>(q);
  const arr = Array.isArray(r) ? r : (r as { rows?: T[] }).rows;
  return (arr ?? []) as T[];
}

async function main() {
  const tbls = await rows<{ table_name: string }>(
    sql.raw(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    ),
  );

  console.log(`=== ALL ${tbls.length} PUBLIC TABLES (user-data must be 0) ===`);
  let dirty = 0;
  for (const { table_name } of tbls) {
    const c = await rows<{ n: number }>(sql.raw(`SELECT COUNT(*)::int AS n FROM "${table_name}"`));
    const n = c[0]?.n ?? 0;
    const isConfig = CONFIG_TABLES.has(table_name);
    let flag = "";
    if (n > 0 && !isConfig) {
      dirty++;
      flag = "  <-- NOT EMPTY (user data)";
    } else if (n > 0 && isConfig) {
      flag = "  (config/pool — OK)";
    }
    console.log(`  ${table_name.padEnd(24)} ${String(n).padStart(5)}${flag}`);
  }

  // Port pool: rows OK, but NONE may be claimed.
  const claimed = await rows<{ n: number }>(
    sql.raw(`SELECT COUNT(*)::int AS n FROM "container_port_slot" WHERE user_id IS NOT NULL`),
  );
  const claimedN = claimed[0]?.n ?? 0;
  if (claimedN > 0) dirty++;
  console.log(`\n  port_slot CLAIMED (must be 0): ${claimedN}${claimedN > 0 ? "  <-- STILL CLAIMED" : ""}`);

  // Synthetic baseline-test user must be gone.
  const synth = await rows<{ n: number }>(
    sql.raw(`SELECT COUNT(*)::int AS n FROM "user" WHERE id = '00000000-0000-4000-8000-baseline0001'`),
  );
  const synthN = synth[0]?.n ?? 0;
  if (synthN > 0) dirty++;
  console.log(`  synthetic test user present (must be 0): ${synthN}`);

  console.log(
    "\n" +
      (dirty === 0
        ? "VERDICT: TOTALLY CLEAN — every user-data/credential table empty, no claimed ports, no test residue."
        : `VERDICT: ${dirty} problem(s) — see flags above.`),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
