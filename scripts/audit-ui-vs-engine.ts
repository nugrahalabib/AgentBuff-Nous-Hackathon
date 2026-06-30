/**
 * AUDIT: does what the /app/agents UI shows == real engine config, per-agent?
 * For each agent (default + kiwi) reads the EXACT RPCs the UI hooks call:
 *   tools.catalog (tools), skills.status (skills), channels.status (channels),
 *   cron.list (rutinitas). Prints a per-agent summary so we can eyeball-match
 *   against the UI AND against the raw container config dump (separate step).
 *   run: pnpm tsx --env-file=.env.local scripts/audit-ui-vs-engine.ts
 */
import WebSocket from "ws";
const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
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

  const agentsList = await rpc("agents.list", {});
  const defaultId = agentsList?.defaultId ?? "default";
  const agentIds: string[] = (agentsList?.agents ?? []).map((a: any) => a.id);
  console.log("AGENTS:", agentIds.join(", "), "| default:", defaultId);

  const channels = await rpc("channels.status", {});
  const agentChannels = (channels as any)?.agentChannels ?? {};
  const cronAll = await rpc("cron.list", { enabled: "all", limit: 200 });
  const cronJobs = (cronAll?.jobs ?? []) as any[];

  for (const agentId of agentIds) {
    console.log(`\n######## AGENT: ${agentId}${agentId === defaultId ? " (default)" : ""} ########`);

    // TOOLS — tools.catalog enabled count
    const tc = await rpc("tools.catalog", { agentId, includePlugins: true });
    const groups = (tc?.groups ?? []) as any[];
    const toolsOn = groups.filter((g) => g.enabled).map((g) => g.id);
    console.log(`TOOLS   : ${toolsOn.length}/${groups.length} aktif`);
    console.log(`          on: ${toolsOn.slice(0, 12).join(", ")}${toolsOn.length > 12 ? " …" : ""}`);

    // SKILLS — skills.status enabled (allowlist) count
    const ss = await rpc("skills.status", { agentId });
    const skills = (ss?.skills ?? ss?.entries ?? []) as any[];
    const skillsOn = skills.filter((s) => s.enabled || s.assigned).map((s) => s.name);
    console.log(`SKILLS  : ${skillsOn.length}/${skills.length} aktif buat agen ini`);

    // CHANNELS — synthetic per-agent accounts + native routed
    const synth = (agentChannels?.[agentId]?.channels ?? {}) as Record<string, any>;
    const synthList: string[] = [];
    for (const [base, data] of Object.entries(synth)) {
      const accts = (data as any)?.accounts ?? [];
      for (const a of accts) synthList.push(`${base}:${a.account_id ?? a.accountId ?? "?"}`);
    }
    console.log(`CHANNELS: ${synthList.length} akun per-agen (synthetic)`);
    if (synthList.length) console.log(`          ${synthList.join(", ")}`);

    // CRON — jobs whose agentId == this agent (UI filter logic)
    const isDef = agentId === defaultId;
    const mine = cronJobs.filter((j) => (j.agentId ? j.agentId === agentId : isDef));
    console.log(`CRON    : ${mine.length} rutinitas`);
    if (mine.length) console.log(`          ${mine.map((j) => `${j.name}[${j.agentId ?? "null"}]`).join(", ")}`);
  }

  console.log("\nAUDIT_DONE");
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", (e as Error).message); process.exit(1); });
