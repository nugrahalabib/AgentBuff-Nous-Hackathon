// After 2026-06-09 fixes: a template agent must (1) start all-skills-on and
// (2) NOT be created on the broken google/gemini-2.5-flash model. With the
// template modelHint nulled, a template-instantiate WITHOUT a model override
// leaves the agent with no per-agent model -> it uses the working global
// default (config.yaml model.default = gpt-5.5), never the 404 gemini.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const ID = "zz-tpl-skill";

function pick(o: unknown, p: string): unknown {
  let c: unknown = o;
  for (const k of p.split(".")) { if (c && typeof c === "object" && k in (c as Record<string, unknown>)) c = (c as Record<string, unknown>)[k]; else return undefined; }
  return c;
}

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };

  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "tpl-skill" },
    async (c) => {
      for (const x of ["zz-skilltest", ID]) { try { await c.call("agents.delete", { agentId: x }); } catch {} }
      const tpls = (await c.call("agents.template.list", {})) as { templates?: Array<{ id: string; modelHint?: unknown }> };
      const tpl = tpls.templates?.[0];
      console.log("template modelHint now:", JSON.stringify(tpl?.modelHint));
      ok("template modelHint is no longer the broken gemini id", tpl?.modelHint !== "google/gemini-2.5-flash");

      // Instantiate WITHOUT a model override (worst case = relies on fallback).
      await c.call("agents.template.instantiate", { templateId: tpl!.id, newAgentId: ID, name: "ZZ Tpl Skill" });
      const got = (await c.call("agents.get", { agentId: ID })) as Record<string, unknown>;
      const m = JSON.stringify(pick(got, "model") ?? null);
      console.log("new template agent model:", m);
      ok("new agent NOT on broken gemini model", !m.includes("gemini-2.5-flash"), m);

      // skills still all-on
      const st = (await c.call("skills.status", { agentId: ID })) as { skills?: Array<{ disabled?: boolean }> };
      const dis = (st.skills ?? []).filter((s) => s.disabled).length;
      ok("template agent skills all-on (0 disabled)", dis === 0, `disabled=${dis}`);

      // global default sanity
      const cfg = (await c.call("config.get", {})) as Record<string, unknown>;
      console.log("global model.default:", JSON.stringify(pick(cfg, "model.default") ?? pick(cfg, "model")));

      for (const x of [ID]) { try { await c.call("agents.delete", { agentId: x }); } catch {} }
      console.log("cleaned up");
      return null;
    },
  );
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
