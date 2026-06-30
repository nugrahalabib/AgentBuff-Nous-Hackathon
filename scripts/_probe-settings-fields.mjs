// Prove the /app/pengaturan Settings page works for REAL: round-trip every
// field the page writes via the SAME RPC shape it uses
// (config.patch {patch, restart:false} -> config.get). For each field:
//   read original -> patch to a test value -> readback (must change) ->
//   patch back to original -> readback (must restore).
// restart:false here (engine-restart already proven by _probe-config-save.mjs);
// this isolates "does the value persist + read back via the page's dotpath".
// Run: node scripts/_probe-settings-fields.mjs <wsPort> <token>
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
const read = async (key) => (await send("config.get", { key })).payload?.value;
const setNested = (path, value) => {
  const keys = path.split(".");
  const out = {};
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = value;
  return out;
};
const patch = (path, value) => send("config.patch", { patch: setNested(path, value), restart: false });

// [dotpath, testValue] — testValue chosen to differ from the seeded default.
const FIELDS = [
  ["display.personality", "concise"],
  ["display.show_reasoning", "hide"],   // the value I was unsure about
  ["voice.auto_tts", true],
  ["tts.provider", "openai"],
  ["stt.enabled", false],
  ["memory.memory_enabled", false],
  ["memory.user_profile_enabled", false],
  ["compression.enabled", false],
  ["approvals.mode", "smart"],
  ["approvals.timeout", 120],
  ["timezone", "Asia/Makassar"],
];

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  let allPass = true;
  for (const [path, testVal] of FIELDS) {
    const orig = await read(path);
    const p1 = await patch(path, testVal);
    const afterSet = await read(path);
    await patch(path, orig);                 // restore
    const afterRestore = await read(path);
    const ok = p1.ok && eq(afterSet, testVal) && eq(afterRestore, orig);
    if (!ok) allPass = false;
    console.log(
      (ok ? "PASS " : "FAIL ") + path.padEnd(34) +
      " orig=" + JSON.stringify(orig) +
      " set=" + JSON.stringify(afterSet) +
      " restored=" + JSON.stringify(afterRestore) +
      (p1.ok ? "" : " patchErr=" + JSON.stringify(p1.error)),
    );
  }
  console.log("\n=== VERDICT: " + (allPass ? "ALL FIELDS PASS — page saves are real + persist + restore" : "SOME FAILED — see above") + " ===");
  ws.close();
  setTimeout(() => process.exit(allPass ? 0 : 1), 300);
 } catch (e) { console.error("probe error:", e?.message || e); ws.close(); setTimeout(()=>process.exit(1),300); }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
