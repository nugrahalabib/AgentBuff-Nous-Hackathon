import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "agentbuff-probe",
      instanceId: `probe-${row.userId.slice(0, 8)}`,
    },
    async (c) => {
      const agents = (await c.call("agents.list", {})) as {
        agents?: { id: string }[];
        defaultId?: string;
      };
      const ids = (agents.agents ?? []).map((a) => a.id);
      for (const id of ids) {
        const cat = (await c.call("tools.catalog", { agentId: id })) as {
          totalToolsets: number;
          enabledCount: number;
          groups: { id: string; enabled: boolean; source: string }[];
        };
        const names = cat.groups.map((g) => g.id);
        const enabled = cat.groups.filter((g) => g.enabled).map((g) => g.id);
        const plugin = cat.groups.filter((g) => g.source === "plugin").map((g) => g.id);
        console.log(
          `\n=== agent "${id}"${id === agents.defaultId ? " (DEFAULT)" : ""} ===`,
        );
        console.log(`  TOTAL=${cat.totalToolsets}  ENABLED=${cat.enabledCount}`);
        console.log(`  plugin-contributed: [${plugin.join(", ")}]`);
        console.log(`  has google_meet: ${names.includes("google_meet")}`);
        console.log(`  disabled: [${names.filter((n) => !enabled.includes(n)).join(", ")}]`);
      }
      return null;
    },
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
