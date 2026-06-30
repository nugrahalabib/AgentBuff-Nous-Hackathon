// Dump cron.list from engine to verify state matches UI expectations.
//   pnpm tsx --env-file=.env.local scripts/dump-cron.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("no running container");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  const result = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `cron-dump-${row.userId.slice(0, 8)}`,
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      const list = await client.call("cron.list", { enabled: "all", limit: 100 });
      const status = await client.call("cron.status", {});
      return { list, status };
    },
  );

  console.log("=".repeat(60));
  console.log("CRON.STATUS:", JSON.stringify(result.status, null, 2));
  console.log("=".repeat(60));
  console.log("CRON.LIST:");
  console.log(JSON.stringify(result.list, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
