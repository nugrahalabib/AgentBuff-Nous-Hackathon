import { readFileSync } from "node:fs";
import postgres from "postgres";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const before = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM user_container`;
  await sql`DELETE FROM user_container`;
  const after = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM user_container`;
  console.log(`user_container: ${before[0].c} -> ${after[0].c}`);
  await sql.end({ timeout: 2 });
}
main().catch((e) => { console.error(e); process.exit(1); });
