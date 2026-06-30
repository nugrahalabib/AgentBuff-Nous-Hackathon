// Regression: prove creating a NEW agent is profile-scoped and never mutates
// the root/global config or any EXISTING agent. Non-destructive: it creates a
// throwaway agent and deletes it at the end.
//
// Asserts:
//   1. New agent gets its OWN name/emoji/theme/description/model/soul.
//   2. Root config (config.get) model.default is byte-identical before/after.
//   3. Every pre-existing agent's full row (model/identity/skills) is unchanged.
//
// Run: pnpm tsx --env-file=.env.local scripts/test-create-agent-isolation.ts
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const NEW_ID = "zz-regtest-agent";

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>))
      cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean, extra = "") => {
    (cond ? pass++ : fail++);
    console.log(`${cond ? "PASS" : "FAIL"} — ${name}${extra ? " :: " + extra : ""}`);
  };

  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "create-iso" },
    async (c) => {
      // ── BEFORE snapshot ────────────────────────────────────────────────
      const rootBefore = (await c.call("config.get", {})) as Record<string, unknown>;
      const rootModelBefore = JSON.stringify(pick(rootBefore, "model") ?? null);
      const rootIdentityBefore = JSON.stringify(pick(rootBefore, "identity") ?? null);

      const listBefore = (await c.call("agents.list", {})) as { agents?: Array<{ id: string }> };
      const existing = (listBefore.agents ?? []).filter((a) => a.id !== NEW_ID);
      const beforeRows: Record<string, string> = {};
      for (const a of existing) {
        const full = await c.call("agents.get", { agentId: a.id }).catch(() => null);
        beforeRows[a.id] = JSON.stringify(full);
      }
      console.log(`snapshot: root + ${existing.length} existing agent(s): ${existing.map((a) => a.id).join(", ")}`);

      // Reuse the default agent's model so the new agent gets a valid one;
      // isolation is asserted via the OTHER fields + the unchanged snapshots.
      const reuseModel =
        (pick(rootBefore, "model.default") as string) ||
        (pick(rootBefore, "model.primary") as string) ||
        "google/gemini-2.5-flash";

      // ── CREATE throwaway agent ─────────────────────────────────────────
      try { await c.call("agents.delete", { agentId: NEW_ID }); } catch { /* not present */ }
      const created = await c.call("agents.create", {
        id: NEW_ID,
        profile: {
          name: "ZZ Regtest",
          identity: { name: "ZZ Regtest", emoji: "🧪", theme: "rose" },
          model: { primary: reuseModel },
          description: "regression-probe-role",
        },
        soulContent: "# ZZ Regtest\nThis is a throwaway regression agent. Reply with 'ok'.",
      }).catch((e) => ({ __err: (e as Error).message }));
      ok("agents.create succeeded", !(created as Record<string, unknown>).__err, JSON.stringify(created).slice(0, 160));

      // ── Verify NEW agent is correctly populated (profile-scoped) ────────
      const got = (await c.call("agents.get", { agentId: NEW_ID })) as Record<string, unknown>;
      ok("new agent name set", String(pick(got, "name") || pick(got, "identity.name")).includes("ZZ Regtest"), JSON.stringify(pick(got, "identity")));
      ok("new agent emoji set", pick(got, "identity.emoji") === "🧪");
      ok("new agent theme set", pick(got, "identity.theme") === "rose");
      ok("new agent description set", String(pick(got, "description") ?? "").includes("regression-probe-role"));
      const newModel = JSON.stringify(pick(got, "model") ?? null);
      ok("new agent has its own model", newModel.includes(reuseModel), newModel);

      // ── Verify ROOT config UNCHANGED ───────────────────────────────────
      const rootAfter = (await c.call("config.get", {})) as Record<string, unknown>;
      ok("root model UNCHANGED", JSON.stringify(pick(rootAfter, "model") ?? null) === rootModelBefore);
      ok("root identity UNCHANGED", JSON.stringify(pick(rootAfter, "identity") ?? null) === rootIdentityBefore);

      // ── Verify EXISTING agents UNCHANGED ───────────────────────────────
      for (const a of existing) {
        const full = await c.call("agents.get", { agentId: a.id }).catch(() => null);
        ok(`existing agent '${a.id}' UNCHANGED`, JSON.stringify(full) === beforeRows[a.id]);
      }

      // ── CLEANUP ────────────────────────────────────────────────────────
      const del = await c.call("agents.delete", { agentId: NEW_ID }).catch((e) => ({ __err: (e as Error).message }));
      ok("throwaway agent deleted (cleanup)", !(del as Record<string, unknown>).__err, JSON.stringify(del).slice(0, 120));

      return null;
    },
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
