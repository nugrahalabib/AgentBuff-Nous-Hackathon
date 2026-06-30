// Regression: prove that setting TOOLS + SKILLS on a freshly-created agent
// (the new wizard Step 5 / Kemampuan) is PROFILE-SCOPED — it lands in the new
// agent's config only, never the root/global config, never an existing agent.
// Non-destructive: creates a throwaway agent, toggles its capabilities, asserts
// isolation, then deletes it.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const NEW_ID = "zz-cap-regtest";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };

  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "cap-iso" },
    async (c) => {
      // BEFORE: full snapshots of root config + an existing agent.
      const rootBefore = JSON.stringify(await c.call("config.get", {}));
      const ktBefore = JSON.stringify(await c.call("agents.get", { agentId: "kak-tutor" }).catch(() => null));

      // Create throwaway agent.
      try { await c.call("agents.delete", { agentId: NEW_ID }); } catch { /* fresh */ }
      const created = await c.call("agents.create", {
        id: NEW_ID,
        profile: { name: "ZZ Cap Regtest", identity: { name: "ZZ Cap Regtest", emoji: "🧰", theme: "amber" } },
        soulContent: "# ZZ Cap Regtest\nThrowaway. Reply 'ok'.",
      }).catch((e) => ({ __err: (e as Error).message }));
      ok("agents.create succeeded", !(created as Record<string, unknown>).__err, JSON.stringify(created).slice(0, 120));

      // ── TOOLS: pick an enabled toolset on the new agent, toggle it OFF ──
      const cat = (await c.call("tools.catalog", { agentId: NEW_ID })) as { enabledToolsets?: string[] };
      const toolset = cat.enabledToolsets?.[0];
      if (toolset) {
        const tg = await c.call("tools.toggle", { agentId: NEW_ID, toolset, enable: false }).catch((e) => ({ __err: (e as Error).message }));
        ok(`tools.toggle('${toolset}' off) on new agent succeeded`, !(tg as Record<string, unknown>).__err, JSON.stringify(tg).slice(0, 120));
        const catAfter = (await c.call("tools.catalog", { agentId: NEW_ID })) as { enabledToolsets?: string[] };
        ok("toolset now disabled ON THE NEW AGENT", !(catAfter.enabledToolsets ?? []).includes(toolset));
      } else {
        ok("found an enabled toolset to toggle", false, "no enabledToolsets");
      }

      // ── SKILLS: set a single-skill allowlist on the new agent ──
      const ss = (await c.call("skills.status", { agentId: NEW_ID })) as { skills?: Array<{ name: string }> };
      const skillName = ss.skills?.find((s) => /hermes-agent$/.test(s.name))?.name ?? ss.skills?.[0]?.name;
      if (skillName) {
        const sset = await c.call("agents.skills.set", { agentId: NEW_ID, skills: [skillName] }).catch((e) => ({ __err: (e as Error).message }));
        ok(`agents.skills.set([${skillName}]) on new agent succeeded`, !(sset as Record<string, unknown>).__err, JSON.stringify(sset).slice(0, 120));
      } else {
        ok("found a skill to set", false, "no skills");
      }

      // ── THE CORE SAFETY ASSERTIONS ──
      const rootAfter = JSON.stringify(await c.call("config.get", {}));
      ok("ROOT config UNCHANGED after capability writes", rootAfter === rootBefore);
      const ktAfter = JSON.stringify(await c.call("agents.get", { agentId: "kak-tutor" }).catch(() => null));
      ok("existing 'kak-tutor' UNCHANGED after capability writes", ktAfter === ktBefore);

      // Cleanup.
      const del = await c.call("agents.delete", { agentId: NEW_ID }).catch((e) => ({ __err: (e as Error).message }));
      ok("cleanup deleted throwaway", !(del as Record<string, unknown>).__err);

      // ── BONUS: tools.toggle with EMPTY agentId must be REJECTED (the bridge
      //    hardening — only passes once the new rpc_router.py is deployed). ──
      const leak = await c.call("tools.toggle", { toolset: toolset ?? "web", enable: false }).then(
        () => ({ rejected: false }),
        (e) => ({ rejected: true, msg: (e as Error).message }),
      );
      ok("tools.toggle with EMPTY agentId is REJECTED (bridge guard)", leak.rejected === true, JSON.stringify(leak).slice(0, 140));

      return null;
    },
  );
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
