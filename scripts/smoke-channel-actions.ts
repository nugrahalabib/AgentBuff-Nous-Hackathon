// Smoke-test the per-account channel actions are wired + respond (non-destructive).
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "smoke" },
    async (c) => {
      // Akses (read) — telegram synthetic account default-1
      try {
        const acc = await c.call("channels.getAccess", { channel: "telegram", accountId: "default-1", agentId: "default" });
        console.log("Akses getAccess(telegram/default-1):", JSON.stringify(acc)?.slice(0, 220));
      } catch (e) { console.log("getAccess ERR:", (e as Error).message); }
      // mcp presets / channels.status as a generic liveness for the action surface
      try {
        const st = (await c.call("channels.status", {})) as { channels?: Record<string, unknown> };
        console.log("channels.status OK — channel keys:", Object.keys(st.channels ?? {}).length);
      } catch (e) { console.log("status ERR:", (e as Error).message); }
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
