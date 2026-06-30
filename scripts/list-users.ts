import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

async function main() {
  const users = await db.select({
    id: schema.users.id,
    email: schema.users.email,
    name: schema.users.name,
  }).from(schema.users);
  console.table(users);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
