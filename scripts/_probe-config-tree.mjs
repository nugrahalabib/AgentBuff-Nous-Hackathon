// Truth probe for the Settings build: dump the LIVE 0.16.0 config tree via
// config.get and report, for every candidate mass-market setting, whether the
// engine field ACTUALLY exists + its current value. No guessing — the workflow's
// schema was 0.14; this confirms 0.16.0 reality before we wire a single control.
// Run: node scripts/_probe-config-tree.mjs <wsPort> <token>
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

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function show(v) {
  if (v === undefined) return "— ABSENT —";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 220);
  return JSON.stringify(v);
}

// Candidate fields the buildable mass-market settings would touch.
const FIELDS = [
  "model.default", "model.fallback_providers", "model.context_length", "model_context_length",
  "display.personality", "display.show_reasoning", "display.show_cost", "display.tool_progress",
  "timezone",
  "approvals.mode", "approvals.timeout", "approvals",
  "memory.memory_enabled", "memory.user_profile_enabled", "memory",
  "compression.enabled", "compression.threshold", "compression.target_ratio", "compression.protect_last_n", "compression",
  "tts.provider", "tts.enabled", "tts",
  "stt.enabled", "stt.provider", "stt",
  "voice.auto_tts", "voice",
  "agent.image_input_mode",
  "toolsets", "plugins.enabled",
];

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  const res = await send("config.get", {});
  if (!res.ok) { console.log("config.get FAILED:", JSON.stringify(res.error)); ws.close(); setTimeout(()=>process.exit(1),200); return; }
  console.log("=== RAW config.get FRAME KEYS ===");
  console.log("frame keys:", Object.keys(res).join(", "));
  console.log("res.result type:", typeof res.result, "keys:", res.result && typeof res.result === "object" ? Object.keys(res.result).slice(0,40).join(",") : String(res.result).slice(0,200));
  console.log("RAW (first 1200):", JSON.stringify(res).slice(0, 1200));
  const keyed = await send("config.get", { key: "model" });
  console.log("\n=== config.get {key:'model'} RAW (first 600) ===");
  console.log(JSON.stringify(keyed).slice(0, 600));
  // CONFIRMED shape: config tree lives at res.payload.value
  const cfg = res.payload?.value ?? res.result?.value ?? res.result ?? {};
  const fs = await import("node:fs");
  fs.writeFileSync("scripts/_config-dump.json", JSON.stringify(cfg, null, 2));
  console.log("\n[full config written to scripts/_config-dump.json]");
  console.log("=== config.get TOP-LEVEL KEYS ===");
  console.log(Object.keys(cfg).sort().join(", "));
  console.log("\n=== CANDIDATE FIELD EXISTENCE + LIVE VALUE (0.16.0) ===");
  for (const f of FIELDS) {
    console.log(`${f.padEnd(34)} : ${show(get(cfg, f))}`);
  }
  // Dump the full relevant subtrees verbatim so we see real field names.
  console.log("\n=== RAW SUBTREES ===");
  for (const blk of ["display","approvals","memory","compression","tts","stt","voice","model"]) {
    console.log(`\n--- ${blk} ---\n${JSON.stringify(cfg[blk], null, 1)}`);
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) { console.error("probe error:", e?.message || e); ws.close(); setTimeout(()=>process.exit(1),300); }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
