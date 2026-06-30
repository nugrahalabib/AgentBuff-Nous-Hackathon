// Live proof for the Settings save path: prove config.patch persists a value
// AND that the new {restart:true} flag schedules an engine restart.
//   1. read approvals.timeout (before)
//   2. config.patch {patch:{approvals:{timeout:90}}, restart:true} -> expect ok + restarted:true
//   3. read approvals.timeout -> expect 90 (persisted)
//   4. restore: config.patch {patch:{approvals:{timeout:60}}, restart:true}
//   5. read approvals.timeout -> expect 60 (restored)
// config.get/patch hit the BRIDGE (reads/writes config.yaml directly); the
// engine subprocess restart is backgrounded, so readback is immediate.
// Run: node scripts/_probe-config-save.mjs <wsPort> <token>
import WebSocket from "ws";

const wsPort = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!wsPort || !token) { console.error("usage: <wsPort> <token>"); process.exit(1); }

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { Origin: `http://127.0.0.1:${wsPort}` } });
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: { message: "timeout " + method } }); } }, 30000);
  });
}
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } }
});
const readTimeout = async () => {
  const r = await send("config.get", { key: "approvals.timeout" });
  return r.payload?.value;
};

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  const before = await readTimeout();
  console.log("1) approvals.timeout BEFORE:", before);

  const p1 = await send("config.patch", { patch: { approvals: { timeout: 90 } }, restart: true });
  console.log("2) patch->90 {restart:true}: ok=" + p1.ok + " restarted=" + p1.payload?.restarted);

  const after = await readTimeout();
  console.log("3) approvals.timeout AFTER patch:", after);

  const p2 = await send("config.patch", { patch: { approvals: { timeout: 60 } }, restart: true });
  const restored = await readTimeout();
  console.log("4) restore->60: ok=" + p2.ok + " restarted=" + p2.payload?.restarted + " readback=" + restored);

  console.log("\n=== VERDICT ===");
  const persistOk = after === 90 && restored === 60;
  const restartOk = p1.payload?.restarted === true && p2.payload?.restarted === true;
  if (persistOk && restartOk) console.log("PASS — config.patch PERSISTS (60->90->60) AND restart:true schedules an engine restart.");
  else console.log("FAIL — persist=" + persistOk + " restart=" + restartOk);
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) { console.error("probe error:", e?.message || e); ws.close(); setTimeout(()=>process.exit(1),300); }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
