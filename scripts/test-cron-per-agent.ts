/**
 * E2E: prove cron jobs are genuinely per-agent.
 * Creates a job for kiwi + one for default, lists, verifies each carries the
 * right agentId, then cleans up. Read-only-ish (creates 2 temp jobs, removes them).
 *   run: pnpm tsx --env-file=.env.local scripts/test-cron-per-agent.ts
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

function mkJob(agentId: string, tag: string) {
  return {
    name: `__e2e_${tag}`,
    description: `e2e per-agent test (${agentId})`,
    agentId,
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    payload: { kind: "agentTurn", message: `test prompt for ${agentId}` },
    sessionTarget: { kind: "isolated" },
    wakeMode: "gateway",
  };
}

ws.on("open", async () => {
  await rpc("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "openclaw-control-ui", version: "1", platform: "node", mode: "operator" }, role: "operator", scopes: SC, auth: { token: TOKEN } });

  console.log("=== STEP 1: create cron for kiwi ===");
  let kiwiId = "", defId = "";
  try {
    const r = await rpc("cron.add", mkJob("kiwi", "kiwi"));
    kiwiId = r?.id || r?.job?.id || "";
    console.log("  created kiwi job id=", kiwiId, "agentId in resp=", r?.agentId ?? r?.job?.agentId);
  } catch (e) { console.log("  ERR add kiwi:", (e as Error).message); }

  console.log("=== STEP 2: create cron for default ===");
  try {
    const r = await rpc("cron.add", mkJob("default", "default"));
    defId = r?.id || r?.job?.id || "";
    console.log("  created default job id=", defId, "agentId in resp=", r?.agentId ?? r?.job?.agentId);
  } catch (e) { console.log("  ERR add default:", (e as Error).message); }

  // give the bridge a moment to persist + reschedule
  await new Promise((r) => setTimeout(r, 2500));

  console.log("=== STEP 3: cron.list — verify agentId per job ===");
  const list = await rpc("cron.list", { enabled: "all", limit: 200 });
  const jobs = (list?.jobs ?? []) as any[];
  const e2e = jobs.filter((j) => (j.name || "").startsWith("__e2e_"));
  for (const j of e2e) {
    console.log(`  job name=${j.name} | id=${j.id} | agentId=${JSON.stringify(j.agentId)}`);
  }
  const kiwiJob = e2e.find((j) => j.name === "__e2e_kiwi");
  const defJob = e2e.find((j) => j.name === "__e2e_default");

  console.log("=== STEP 4: VERDICT ===");
  const kiwiOk = kiwiJob && kiwiJob.agentId === "kiwi";
  // default may be stored as "default" OR null (both = default agent)
  const defOk = defJob && (defJob.agentId === "default" || defJob.agentId == null);
  console.log("  kiwi job carries agentId=kiwi  :", kiwiOk ? "PASS" : `FAIL (${kiwiJob?.agentId})`);
  console.log("  default job = default/null     :", defOk ? "PASS" : `FAIL (${defJob?.agentId})`);
  console.log("  per-agent SEPARATION           :", kiwiJob && defJob && kiwiJob.agentId !== defJob.agentId ? "PASS (distinct)" : "CHECK");

  console.log("=== STEP 5: simulate panel filter (what kiwi tab vs default tab shows) ===");
  const kiwiTab = e2e.filter((j) => (j.agentId ? j.agentId === "kiwi" : false));
  const defTab = e2e.filter((j) => (j.agentId ? j.agentId === "default" : true));
  console.log("  kiwi panel sees:", kiwiTab.map((j) => j.name));
  console.log("  default panel sees:", defTab.map((j) => j.name));

  console.log("=== STEP 6: cleanup (remove both test jobs) ===");
  for (const j of e2e) {
    try { await rpc("cron.remove", { id: j.id }); console.log("  removed", j.name); }
    catch (e) { console.log("  ERR remove", j.name, (e as Error).message); }
  }

  console.log("TEST_DONE");
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", (e as Error).message); process.exit(1); });
