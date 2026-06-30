// Timed RPC probe — measures per-call latency of the RPCs /app fires on load.
// Run: node scripts/_probe-rpc-timing.mjs <port> <token>
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) { console.error("usage: _probe-rpc-timing.mjs <port> <token>"); process.exit(1); }

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });

let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (p) => resolve({ ms: Date.now() - t0, payload: p }), reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 60000);
  });
}
ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.type === "res") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.payload ?? null) : p.reject(new Error(msg.error?.message || "unk")); }
    }
  } catch {}
});

const size = (o) => JSON.stringify(o ?? {}).length;

ws.on("open", async () => {
  const tConn0 = Date.now();
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  console.log(`connect: ${Date.now() - tConn0}ms`);

  const list = await send("sessions.list", {});
  const sessions = list.payload?.sessions ?? (Array.isArray(list.payload) ? list.payload : []);
  console.log(`sessions.list: ${list.ms}ms (${size(list.payload)} bytes, ${sessions.length} sessions)`);

  const target = sessions[0]?.key || sessions[0]?.sessionKey || "agent:main:main";
  try {
    const hist = await send("sessions.get", { sessionKey: target, key: target });
    console.log(`sessions.get(${target}): ${hist.ms}ms (${size(hist.payload)} bytes, ${(hist.payload?.messages ?? []).length} messages)`);
  } catch (e) { console.log("sessions.get failed:", e.message); }

  for (const m of ["tools.catalog", "skills.status", "channels.status", "agents.list", "config.get"]) {
    try {
      const r = await send(m, {});
      console.log(`${m}: ${r.ms}ms (${size(r.payload)} bytes)`);
    } catch (e) { console.log(`${m} failed:`, e.message); }
  }
  ws.close();
  process.exit(0);
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 120000);
