// Regression: prove the TEMPLATE create path now persists role (description)
// AND model fallbacks (both were silently dropped before 2026-06-08), while
// staying profile-scoped (root + existing agents untouched). Non-destructive.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const NEW_ID = "zz-tpl-regtest";
const ROLE = "regtest-role-tagline-unique";
const FALLBACK = "zz-fallback/model-x";

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };

  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "tpl-fields" },
    async (c) => {
      const tpls = (await c.call("agents.template.list", {})) as { templates?: Array<{ id: string; label?: string }> };
      const tpl = tpls.templates?.[0];
      if (!tpl) { ok("a template exists", false); return null; }
      console.log(`using template: ${tpl.id} (${tpl.label ?? ""})`);

      const rootBefore = JSON.stringify(pick(await c.call("config.get", {}), "model") ?? null);
      const ktBefore = JSON.stringify(await c.call("agents.get", { agentId: "kak-tutor" }).catch(() => null));

      try { await c.call("agents.delete", { agentId: NEW_ID }); } catch { /* fresh */ }
      const created = await c.call("agents.template.instantiate", {
        templateId: tpl.id,
        newAgentId: NEW_ID,
        name: "ZZ Tpl Regtest",
        emoji: "🧬",
        theme: "indigo",
        description: ROLE,
        fallbacks: [FALLBACK],
      }).catch((e) => ({ __err: (e as Error).message }));
      ok("template.instantiate succeeded", !(created as Record<string, unknown>).__err, JSON.stringify(created).slice(0, 140));

      const got = (await c.call("agents.get", { agentId: NEW_ID })) as Record<string, unknown>;
      ok("ROLE/description persisted (was dropped before)", String(pick(got, "description") ?? "").includes(ROLE), JSON.stringify(pick(got, "description")));
      const fb = JSON.stringify(pick(got, "model.fallbacks") ?? []);
      ok("model.fallbacks persisted (was dropped before)", fb.includes(FALLBACK), fb);
      ok("name/emoji/theme also set", pick(got, "identity.emoji") === "🧬" && pick(got, "identity.theme") === "indigo");

      const rootAfter = JSON.stringify(pick(await c.call("config.get", {}), "model") ?? null);
      ok("root model UNCHANGED", rootAfter === rootBefore);
      const ktAfter = JSON.stringify(await c.call("agents.get", { agentId: "kak-tutor" }).catch(() => null));
      ok("existing 'kak-tutor' UNCHANGED", ktAfter === ktBefore);

      const del = await c.call("agents.delete", { agentId: NEW_ID }).catch((e) => ({ __err: (e as Error).message }));
      ok("cleanup deleted throwaway", !(del as Record<string, unknown>).__err);
      return null;
    },
  );
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
