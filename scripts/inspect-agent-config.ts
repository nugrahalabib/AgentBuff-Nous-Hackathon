// Inspect agent config entry to check tools/skills/default state.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

(async () => {
  const [row] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("no container");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: "inspect-cfg",
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      const res = (await client.call("config.get", {})) as {
        config: { agents?: { list?: unknown[] } };
      };
      const list = res.config.agents?.list ?? [];
      console.log(JSON.stringify(list, null, 2));
    },
  );
  process.exit(0);
})();
