// Dump engine plugins config from running container.
//   pnpm tsx --env-file=.env.local scripts/dump-plugins.ts
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
    })
    .from(schema.userContainers)
    .limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  const out = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `plugins-${row.userId.slice(0, 8)}`,
    },
    async (client) => client.call<{ config?: Record<string, unknown> }>("config.get", {}),
  );
  const cfg = out?.config ?? {};
  const plugins = (cfg as Record<string, unknown>).plugins;
  console.log("plugins config:", JSON.stringify(plugins, null, 2));
  const channels = (cfg as Record<string, unknown>).channels;
  console.log("\nchannels keys:", Object.keys(channels ?? {}));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
