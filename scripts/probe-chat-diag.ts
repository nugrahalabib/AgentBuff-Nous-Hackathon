// Diagnose chat regression: global model + per-agent models + session persistence.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

function pick(o: unknown, p: string): unknown {
  let c: unknown = o;
  for (const k of p.split(".")) { if (c && typeof c === "object" && k in (c as Record<string, unknown>)) c = (c as Record<string, unknown>)[k]; else return undefined; }
  return c;
}

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "chat-diag" },
    async (c) => {
      const cfg = (await c.call("config.get", {})) as Record<string, unknown>;
      console.log("=== GLOBAL MODEL ===");
      console.log("model.default:", JSON.stringify(pick(cfg, "model.default")));
      console.log("model.primary:", JSON.stringify(pick(cfg, "model.primary")));
      const providers = pick(cfg, "model.providers") as Record<string, unknown> | undefined;
      if (providers) {
        for (const [k, v] of Object.entries(providers)) {
          const vv = v as Record<string, unknown>;
          console.log(`provider ${k}: base_url=${vv.base_url ?? vv.baseUrl ?? "?"} models=${JSON.stringify(vv.models ?? vv.model ?? "?").slice(0,120)}`);
        }
      }

      console.log("\n=== PER-AGENT MODELS ===");
      const agents = (await c.call("agents.list", {})) as { agents?: Array<{ id: string }> };
      for (const a of agents.agents ?? []) {
        const full = (await c.call("agents.get", { agentId: a.id }).catch(() => null)) as Record<string, unknown> | null;
        console.log(`  ${a.id}: model=${JSON.stringify(pick(full, "model"))}`);
      }

      console.log("\n=== VALID MODELS (model.options) ===");
      try {
        const opts = (await c.call("model.options", {})) as { providers?: Array<{ slug: string; models?: string[] }> };
        for (const p of opts.providers ?? []) {
          if ((p.models ?? []).length > 0) console.log(`  ${p.slug}: ${JSON.stringify((p.models ?? []).slice(0, 6))}`);
        }
      } catch (e) { console.log("  model.options ERR:", (e as Error).message); }

      console.log("\n=== SESSIONS (persistence check) ===");
      try {
        const sess = (await c.call("sessions.list", {})) as { sessions?: Array<{ key?: string; sessionKey?: string; title?: string; updatedAt?: unknown; agentId?: string }> };
        const list = sess.sessions ?? [];
        console.log(`sessions.list returned ${list.length} session(s)`);
        for (const s of list.slice(0, 10)) console.log("  -", JSON.stringify({ key: s.key ?? s.sessionKey, title: s.title, agentId: s.agentId, updatedAt: s.updatedAt }).slice(0, 160));
      } catch (e) { console.log("sessions.list ERR:", (e as Error).message); }
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
