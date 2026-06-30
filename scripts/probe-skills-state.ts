// Diagnose why most skills show "NONAKTIF GLOBAL" in the Kemampuan UI.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "skills-state" },
    async (c) => {
      // Root/global config skills.disabled
      const root = (await c.call("config.get", {})) as { skills?: { disabled?: string[] } };
      const gDisabled = root.skills?.disabled ?? [];
      console.log(`GLOBAL config skills.disabled: ${gDisabled.length} entries`);
      console.log("  sample:", JSON.stringify(gDisabled.slice(0, 12)));

      // skills.status for the DEFAULT agent
      for (const aid of ["default"]) {
        const st = (await c.call("skills.status", { agentId: aid })) as {
          skills?: Array<{ name: string; disabled?: boolean; enabled?: boolean; agentCreated?: boolean }>;
        };
        const all = st.skills ?? [];
        const disabled = all.filter((s) => s.disabled);
        const enabled = all.filter((s) => !s.disabled);
        console.log(`\nskills.status(${aid}): total=${all.length}  disabled(global-off)=${disabled.length}  available=${enabled.length}`);
        console.log("  available sample:", JSON.stringify(enabled.slice(0, 8).map((s) => s.name)));
        console.log("  disabled sample:", JSON.stringify(disabled.slice(0, 8).map((s) => s.name)));
        // raw shape of one disabled entry to understand the flags
        if (disabled[0]) console.log("  one disabled entry RAW:", JSON.stringify(disabled[0]));
        if (enabled[0]) console.log("  one available entry RAW:", JSON.stringify(enabled[0]));
      }
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
