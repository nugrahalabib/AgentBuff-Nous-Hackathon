// Dump current channels.whatsapp config to diagnose policy state.
//   pnpm tsx --env-file=.env.local scripts/dump-whatsapp-config.ts
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
  const out = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `dump-wa-${row.userId.slice(0, 8)}`,
    },
    async (client) =>
      client.call<{ config?: { channels?: Record<string, unknown>; bindings?: unknown[] } }>(
        "config.get",
        {},
      ),
  );
  const cfg = out?.config ?? {};
  console.log("=== channels.whatsapp ===");
  console.log(JSON.stringify(cfg.channels?.whatsapp ?? null, null, 2));
  console.log("\n=== bindings ===");
  console.log(JSON.stringify(cfg.bindings ?? [], null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
