/**
 * READ-ONLY diagnostic: for default + kiwi, print EXACTLY which toolsets the
 * normalize rule disagrees with the live catalog on, plus the why (essential /
 * readiness status / want vs actual). Pinpoints the residual non-convergence.
 *   run: pnpm tsx --env-file=.env.local scripts/diag-capability.ts
 */
import WebSocket from "ws";
import { translateToolset } from "../src/components/app/agents/vocab";
import { resolveReadiness } from "../src/components/app/agents/capability-requirements";
import { isEssentialToolset } from "../src/components/app/agents/capability-tiers";

const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
let _id = 0;
const pend = new Map<string, { res: (v: any) => void; rej: (e: Error) => void }>();
const rpc = (m: string, p: Record<string, unknown> = {}): Promise<any> => {
  const id = String(++_id);
  ws.send(JSON.stringify({ type: "req", id, method: m, params: p }));
  return new Promise((res, rej) => { pend.set(id, { res, rej }); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000); });
};
ws.on("message", (raw: Buffer) => {
  let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "res") { const pr = pend.get(m.id); if (pr) { pend.delete(m.id); (m.ok === false || m.error) ? pr.rej(new Error(m.error?.message || "err")) : pr.res(m.payload ?? m.result); } }
});

ws.on("open", async () => {
  await rpc("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "openclaw-control-ui", version: "1", platform: "node", mode: "operator" }, role: "operator", scopes: SC, auth: { token: TOKEN } });
  const models = await rpc("models.authStatus", {});
  const channels = await rpc("channels.status", {});
  const mcp = await rpc("mcp.list", {});
  const env = await rpc("env.list", {});
  const agentChannels = (channels as any)?.agentChannels ?? null;

  for (const agentId of ["default", "kiwi"]) {
    const tc = await rpc("tools.catalog", { agentId, includePlugins: true });
    const groups = tc?.groups ?? [];
    const reqData = { models, channels, mcp, env, agentChannels, agentId };
    const rows: string[] = [];
    for (const g of groups) {
      const essential = isEssentialToolset(g.id);
      const st = resolveReadiness(translateToolset(g.id), reqData).status;
      const locked = !essential && (st === "setup-needed" || st === "blocked");
      const want = essential || !locked;
      const actual = g.enabled === true;
      if (want !== actual) {
        rows.push(`  ${want ? "WANT_ON " : "WANT_OFF"} actual=${actual} | id=${g.id} | essential=${essential} | status=${st} | source=${g.source ?? "?"}`);
      }
    }
    console.log(`\n[${agentId}] groups=${groups.length} mismatches=${rows.length}`);
    rows.forEach((r) => console.log(r));
  }
  console.log("\nDIAG_DONE");
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", (e as Error).message); process.exit(1); });
