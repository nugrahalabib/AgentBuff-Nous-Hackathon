import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const ID = "zz-inspect-agent";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "ts-persist" },
    async (c) => {
      try { await c.call("agents.delete", { agentId: ID }); } catch {}
      await c.call("agents.create", { id: ID, profile: { name: "ZZ Inspect", identity: { name: "ZZ Inspect" } }, soulContent: "# zz\nok" });
      const before = (await c.call("tools.catalog", { agentId: ID })) as { enabledToolsets?: string[] };
      console.log("enabled BEFORE toggle:", JSON.stringify(before.enabledToolsets));
      const ts = before.enabledToolsets?.find((t) => t === "browser") ?? before.enabledToolsets?.[0];
      console.log("toggling OFF:", ts);
      const r = await c.call("tools.toggle", { agentId: ID, toolset: ts, enable: false });
      console.log("toggle result:", JSON.stringify(r));
      const immediate = (await c.call("tools.catalog", { agentId: ID })) as { enabledToolsets?: string[] };
      console.log("enabled IMMEDIATELY after:", JSON.stringify(immediate.enabledToolsets), "still has?", (immediate.enabledToolsets ?? []).includes(ts!));
      await sleep(2500);
      const delayed = (await c.call("tools.catalog", { agentId: ID })) as { enabledToolsets?: string[] };
      console.log("enabled AFTER 2.5s:", JSON.stringify(delayed.enabledToolsets), "still has?", (delayed.enabledToolsets ?? []).includes(ts!));
      // leave the agent for file inspection; print its id
      console.log("LEAVING agent", ID, "for file inspection");
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
