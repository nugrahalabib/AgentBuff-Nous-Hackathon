import { readFileSync } from "node:fs";
import postgres from "postgres";
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const cols = await sql`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name='user_container' ORDER BY ordinal_position`;
  console.log(cols);
  await sql.end();
}
main();
