// Why does a NEWLY-created agent show most skills as NONAKTIF GLOBAL when the
// default agent shows all 73 available? Create a fresh agent, inspect.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const ID = "zz-skilltest";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "new-skills" },
    async (c) => {
      try { await c.call("agents.delete", { agentId: ID }); } catch {}
      await c.call("agents.create", { id: ID, profile: { name: "ZZ Skill Test", identity: { name: "ZZ Skill Test" } }, soulContent: "# zz\nok" });
      console.log("created", ID);

      const st = (await c.call("skills.status", { agentId: ID })) as {
        skills?: Array<{ name: string; disabled?: boolean; blockedByAllowlist?: boolean; eligible?: boolean }>;
      };
      const all = st.skills ?? [];
      const disabled = all.filter((s) => s.disabled);
      const blocked = all.filter((s) => s.blockedByAllowlist);
      console.log(`skills.status(${ID}): total=${all.length} disabled=${disabled.length} blockedByAllowlist=${blocked.length}`);
      if (disabled[0]) console.log("one disabled RAW:", JSON.stringify(disabled[0]));
      if (blocked[0]) console.log("one blocked RAW:", JSON.stringify(blocked[0]));

      // agents.get for the new agent (shows its allowlist 'skills')
      const got = (await c.call("agents.get", { agentId: ID })) as { skills?: string[]; skillCount?: number };
      console.log("agents.get skills (allowlist):", JSON.stringify(got.skills), "skillCount:", got.skillCount);

      console.log("LEAVING", ID, "for config file inspection");
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
