/**
 * Print chief's Hermes container info as JSON (for shell pipelines).
 * Outputs one JSON line: {port, token}
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const CHIEF_EMAIL = "nugrahalabib@gmail.com";

async function main() {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, CHIEF_EMAIL))
    .limit(1);
  if (!u) throw new Error("NO_USER");
  const [c] = await db
    .select()
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, u.id))
    .limit(1);
  if (!c) throw new Error("NO_CONTAINER");
  console.log(JSON.stringify({ port: c.port, token: c.gatewayToken }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
