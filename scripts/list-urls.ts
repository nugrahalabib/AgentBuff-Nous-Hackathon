import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

async function main() {
  const rows = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      token: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
      email: schema.users.email,
    })
    .from(schema.userContainers)
    .leftJoin(schema.users, (({ userId }: any) => ({})) as never);

  const users = await db.select().from(schema.users);
  const uByid = new Map(users.map((u) => [u.id, u.email]));
  const cs = await db.select().from(schema.userContainers);
  for (const r of cs) {
    console.log(`${uByid.get(r.userId)} [${r.status}]`);
    console.log(`  http://127.0.0.1:${r.port}/#token=${r.gatewayToken}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
