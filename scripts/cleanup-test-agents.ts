// Delete any throwaway test agents (id prefix "zz-") left by regression probes.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "cleanup" },
    async (c) => {
      const list = (await c.call("agents.list", {})) as { agents?: Array<{ id: string }> };
      const zz = (list.agents ?? []).filter((a) => a.id.startsWith("zz-"));
      for (const a of zz) {
        const r = await c.call("agents.delete", { agentId: a.id }).then(() => "ok", (e) => (e as Error).message);
        console.log(`delete ${a.id}: ${r}`);
      }
      if (zz.length === 0) console.log("no zz- test agents to clean");
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
