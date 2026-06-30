// Dump the EXACT data the "Tim Aktif" rail consumes: agents.list ids vs
// channels.status account routing — to find why per-agent channel labels miss.
// Run: node scripts/_probe-team-data.mjs <port> <token>
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) { console.error("usage: _probe-team-data.mjs <port> <token>"); process.exit(1); }

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });

let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 30000);
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

ws.on("open", async () => {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });

  const agents = await send("agents.list", {});
  console.log("=== agents.list ===");
  for (const a of agents?.agents ?? []) {
    console.log(`  id=${JSON.stringify(a.id)} name=${JSON.stringify(a.identity?.name ?? a.name)} skillCount=${a.skillCount}`);
  }
  console.log("  defaultId =", JSON.stringify(agents?.defaultId));

  const ch = await send("channels.status", {});
  console.log("\n=== channels.status RAW (full JSON) ===");
  console.log(JSON.stringify(ch, null, 1));
  ws.close();
  process.exit(0);
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 60000);
