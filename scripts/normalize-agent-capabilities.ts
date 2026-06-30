/**
 * One-time normalization of every agent's capability config to chief's rule:
 *   "everything ON except what is PROVABLY locked by an unmet requirement,
 *    and essential toolsets always ON."
 * Uses the REAL shipping resolver + tiers so there is ZERO divergence from the
 * UI. Writes via the per-agent tools.toggle RPC (now brand-prefix-safe after
 * the 2026-05-31 bridge fix in tools_handler._resolve_engine_name). Engine
 * source is NOT modified.
 *
 *   run: pnpm tsx --env-file=.env.local scripts/normalize-agent-capabilities.ts [--apply]
 * Without --apply = DRY RUN (prints the plan, writes nothing).
 */
import WebSocket from "ws";
import { translateToolset } from "../src/components/app/agents/vocab";
import { resolveReadiness } from "../src/components/app/agents/capability-requirements";
import { isEssentialToolset } from "../src/components/app/agents/capability-tiers";

const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
const APPLY = process.argv.includes("--apply");

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
  const agentChannels = (channels as { agentChannels?: Record<string, unknown> } | null)?.agentChannels ?? null;

  const list = await rpc("agents.list", {});
  const ids: string[] = ["default", ...((list?.agents ?? []).map((a: any) => a.id).filter((x: string) => x && x !== "default"))];
  console.log(`MODE=${APPLY ? "APPLY" : "DRY-RUN"}  agents=${JSON.stringify(ids)}`);

  for (const agentId of ids) {
    const tc = await rpc("tools.catalog", { agentId, includePlugins: true });
    const groups = tc?.groups ?? [];
    const reqData = { models, channels, mcp, env, agentChannels, agentId };
    const toolOn: string[] = [], toolOff: string[] = [];
    for (const g of groups) {
      const essential = isEssentialToolset(g.id);
      const st = resolveReadiness(translateToolset(g.id), reqData).status;
      const locked = !essential && (st === "setup-needed" || st === "blocked");
      const want = essential || !locked;
      if (want && !g.enabled) toolOn.push(g.id);
      else if (!want && g.enabled) toolOff.push(g.id);
    }
    console.log(`\n[${agentId}] +${toolOn.length} on / -${toolOff.length} off (of ${groups.length})`);
    if (toolOn.length) console.log(`   ON : ${toolOn.join(", ")}`);
    if (toolOff.length) console.log(`   OFF: ${toolOff.join(", ")}`);
    if (APPLY) {
      for (const id of toolOn) { const r = await rpc("tools.toggle", { agentId, toolset: id, enable: true }).catch((e) => ({ error: e.message })); if (r?.error) console.log(`   ! on ${id}: ${r.error}`); }
      for (const id of toolOff) { const r = await rpc("tools.toggle", { agentId, toolset: id, enable: false }).catch((e) => ({ error: e.message })); if (r?.error) console.log(`   ! off ${id}: ${r.error}`); }
    }
  }
  console.log(`\nDONE (${APPLY ? "applied" : "dry-run"})`);
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", (e as Error).message); process.exit(1); });
