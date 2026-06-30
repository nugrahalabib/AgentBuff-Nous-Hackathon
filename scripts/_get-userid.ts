import { db } from "../src/lib/db";
import { userContainers } from "../src/lib/db/schema";

async function main() {
  const rows = await db.select().from(userContainers);
  for (const r of rows) {
    console.log(JSON.stringify({ userId: r.userId, status: r.status, port: r.port, name: r.containerName }));
  }
  process.exit(0);
}
void main();
