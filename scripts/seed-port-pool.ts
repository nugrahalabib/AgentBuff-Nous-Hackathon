import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { hermesConfig } from "@/lib/hermes/config";

async function main() {
  const portMin = hermesConfig.portMin;
  const portMax = hermesConfig.portMax;

  console.log(`Seeding container_port_slot [${portMin}..${portMax}]…`);

  await db.execute(sql`
    INSERT INTO container_port_slot (port)
    SELECT generate_series(${portMin}::int, ${portMax}::int)
    ON CONFLICT (port) DO NOTHING
  `);

  const [{ count }] = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM container_port_slot`,
  );
  const [{ count: free }] = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM container_port_slot WHERE user_id IS NULL`,
  );
  console.log(`Pool: ${count} total, ${free} free`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
