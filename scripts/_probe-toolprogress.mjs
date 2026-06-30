// Live proof for the CHANNEL tool-progress toggle's write path: config.patch
// (exactly what the Settings toggle sends) persists display.tool_progress as
// "off"/"all" and reads back. Combined with the resolve_display_setting test
// (gateway acts on != "off"), this is end-to-end for channels.
// Run: node scripts/_probe-toolprogress.mjs <wsPort> <token>
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
const read = async () => (await send("config.get", { key: "display.tool_progress" })).payload?.value;
const patch = (v) => send("config.patch", { patch: { display: { tool_progress: v } }, restart: false });

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  const before = await read();
  console.log("BEFORE display.tool_progress =", JSON.stringify(before));

  await patch("off");
  const off = await read();
  console.log("after toggle OFF (patch 'off')  =", JSON.stringify(off));

  await patch("all");
  const all = await read();
  console.log("after toggle ON  (patch 'all')  =", JSON.stringify(all));

  await patch(before);
  const restored = await read();
  console.log("RESTORED                        =", JSON.stringify(restored));

  const pass = off === "off" && all === "all" && JSON.stringify(restored) === JSON.stringify(before);
  console.log("\n=== VERDICT:", pass ? "PASS — toggle writes persist (off/all) + restore" : "FAIL", "===");
  ws.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
 } catch (e) { console.error("probe error:", e?.message || e); ws.close(); setTimeout(()=>process.exit(1),300); }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
