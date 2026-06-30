// Dump engine config.schema for a given channel id — verify exact path
// untuk patch (botToken, etc).
//
//  pnpm tsx --env-file=.env.local scripts/dump-channel-schema.ts telegram
//  pnpm tsx --env-file=.env.local scripts/dump-channel-schema.ts discord
//  pnpm tsx --env-file=.env.local scripts/dump-channel-schema.ts slack
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error("usage: dump-channel-schema.ts <channelId>");
    process.exit(1);
  }
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
      instanceId: `schema-${row.userId.slice(0, 8)}`,
    },
    async (client) => client.call("config.schema", {}),
  );
  // Walk the schema to extract just the "channels.<id>" subtree.
  const root = (out as { schema?: unknown })?.schema;
  console.log(JSON.stringify(root, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
