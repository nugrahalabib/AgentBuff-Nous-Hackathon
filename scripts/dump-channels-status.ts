// Dump full channels.status payload — pakai untuk debug WhatsApp state.
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
  const status = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `dump-${row.userId.slice(0, 8)}`,
    },
    async (client) => client.call("channels.status", {}),
  );
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
