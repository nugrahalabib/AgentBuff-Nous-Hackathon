import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

// Proves skills on/off is PER-AGENT (not global): toggle one skill for a
// non-default agent and confirm ONLY that agent's disabled set changes, while
// the default agent is untouched. Reverts at the end.
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
      instanceId: `skillprobe-${row.userId.slice(0, 8)}`,
    },
    async (c) => {
      const agents = (await c.call("agents.list", {})) as {
        agents?: { id: string }[];
        defaultId?: string;
      };
      const ids = (agents.agents ?? []).map((a) => a.id);
      const target = ids.find((id) => id !== (agents.defaultId ?? "default"));
      const def = agents.defaultId ?? "default";
      if (!target) {
        console.log("need a non-default agent to prove isolation; agents:", ids);
        return null;
      }

      const disabledOf = async (agentId: string): Promise<Set<string>> => {
        const s = (await c.call("skills.status", { agentId })) as {
          skills?: { name: string; disabled?: boolean; enabled?: boolean }[];
        };
        const out = new Set<string>();
        for (const sk of s.skills ?? []) {
          const off = sk.disabled === true || sk.enabled === false;
          if (off) out.add(sk.name);
        }
        return out;
      };
      // pick a skill currently ENABLED for the target agent
      const tStatus = (await c.call("skills.status", { agentId: target })) as {
        skills?: { name: string; disabled?: boolean; enabled?: boolean }[];
      };
      const pick = (tStatus.skills ?? []).find(
        (sk) => !(sk.disabled === true || sk.enabled === false),
      )?.name;
      if (!pick) {
        console.log("no enabled skill to toggle on target");
        return null;
      }

      const beforeT = await disabledOf(target);
      const beforeD = await disabledOf(def);
      console.log(`picked skill: "${pick}"`);
      console.log(`BEFORE  target(${target}).disabled has "${pick}": ${beforeT.has(pick)} (total ${beforeT.size})`);
      console.log(`BEFORE  default(${def}).disabled has "${pick}": ${beforeD.has(pick)} (total ${beforeD.size})`);

      console.log(`\n>> toggle DISABLE "${pick}" for ${target} ...`);
      await c.call("agents.skills.setDisabled", { agentId: target, name: pick, disabled: true });

      const afterT = await disabledOf(target);
      const afterD = await disabledOf(def);
      console.log(`AFTER   target(${target}).disabled has "${pick}": ${afterT.has(pick)} (total ${afterT.size})`);
      console.log(`AFTER   default(${def}).disabled has "${pick}": ${afterD.has(pick)} (total ${afterD.size})`);

      const isolated =
        afterT.has(pick) && !afterD.has(pick) && afterD.size === beforeD.size;
      console.log(`\n>> ISOLATED PER-AGENT (target changed, default untouched): ${isolated ? "YES ✓" : "NO ✗"}`);

      console.log(`\n>> revert (re-enable) ...`);
      await c.call("agents.skills.setDisabled", { agentId: target, name: pick, disabled: false });
      const revT = await disabledOf(target);
      console.log(`REVERTED target(${target}).disabled has "${pick}": ${revT.has(pick)} (should be false)`);
      return null;
    },
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
