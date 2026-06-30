// Resilience verification for /app/providers post-save flow (2026-06-11).
// (1) testKey across the whole base-URL map; (2) reproduce the ENGINE-RESTART
// race live (save a dummy key → restart) capturing the EXACT error strings
// agents.list/models.list/testKey return, and assert the client's
// isEngineWarmingUp() classifier matches each one + the calls recover; (3) clean
// up the dummy key. Run: node scripts/probe-providers-rpc.mjs <port> <token>
import WebSocket from "ws";

const PORT = process.argv[2] ?? "18800";
const TOKEN = process.argv[3] ?? "";
if (!TOKEN) { console.error("usage: node scripts/probe-providers-rpc.mjs <port> <token>"); process.exit(1); }

// EXACT copy of the client classifier (providers-tab.tsx isEngineWarmingUp).
function isEngineWarmingUp(raw) {
  const m = (raw || "").toLowerCase();
  return (
    m.includes("crashed") || m.includes("exit ") || m.includes("subprocess") ||
    m.includes("not connected") || m.includes("belum terhubung") || m.includes("restart") ||
    m.includes("not ready") || m.includes("unavailable") || m.includes("timeout") ||
    m.includes("econnreset") || m.includes("engine_down") || m.includes("disconnect")
  );
}

const ALL_KEYS = [
  "OPENAI_API_KEY","GOOGLE_API_KEY","GEMINI_API_KEY","ANTHROPIC_API_KEY","DEEPSEEK_API_KEY",
  "XAI_API_KEY","GROQ_API_KEY","MISTRAL_API_KEY","CEREBRAS_API_KEY","FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY","DASHSCOPE_API_KEY","GLM_API_KEY","KIMI_API_KEY","MINIMAX_API_KEY",
  "NVIDIA_API_KEY","HF_TOKEN","NOVITA_API_KEY","OLLAMA_API_KEY","ARCEEAI_API_KEY",
  "GMI_API_KEY","OPENCODE_ZEN_API_KEY","KILOCODE_API_KEY","XIAOMI_API_KEY",
];

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
let idc = 1; const pending = new Map();
function call(method, params = {}, timeoutMs = 14000) {
  return new Promise((res) => {
    const id = String(idc++); pending.set(id, res);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ ok: false, error: { message: "timeout (client)" } }); } }, timeoutMs);
  });
}
ws.on("message", (buf) => { let f; try { f = JSON.parse(String(buf)); } catch { return; }
  if (f.type === "res" && pending.has(f.id)) { const r = pending.get(f.id); pending.delete(f.id); r({ ok: f.ok, result: f.payload ?? f.result, error: f.error }); } });
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on("open", async () => {
  const conn = await call("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" }, role: "operator", scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"], auth: { token: TOKEN } });
  if (!conn?.ok) { console.error("connect fail:", JSON.stringify(conn?.error ?? conn)); process.exit(1); }
  console.log("ok connect\n");

  // ── (1) testKey across the whole map ─────────────────────────────────────
  console.log("=== (1) testKey for ALL mapped providers (most = no-key, that's expected) ===");
  for (const k of ALL_KEYS) {
    const r = await call("providers.testKey", { key: k });
    const st = r.ok ? r.result?.status : `RPC-ERR:${r.error?.message}`;
    const extra = r.result?.modelCount != null ? ` (${r.result.modelCount} models)` : "";
    console.log(`  ${k.padEnd(22)} → ${st}${extra}`);
  }
  const uns = await call("providers.testKey", { key: "STEPFUN_API_KEY" });
  console.log(`  STEPFUN_API_KEY (no base in map) → ${uns.result?.status}`);

  // ── (2) reproduce the ENGINE-RESTART race ────────────────────────────────
  console.log("\n=== (2) Reproducing engine-restart race (save dummy GROQ key → restart) ===");
  const set = await call("providers.setEnv", { key: "GROQ_API_KEY", value: "gsk_dummy_resilience_probe" });
  console.log("  setEnv GROQ ok=" + set.ok + " restarted=" + JSON.stringify(set.result?.restarted));
  console.log("  polling agents.list / models.list during the restart window…\n");
  let sawWarming = false, allClassified = true, recovered = false;
  for (let i = 0; i < 45; i++) {
    const [a, m] = await Promise.all([call("agents.list", {}, 6000), call("models.list", {}, 6000)]);
    if (a.ok && m.ok) {
      const ac = Array.isArray(a.result) ? a.result.length : (a.result?.agents?.length ?? 0);
      const mc = m.result?.providers?.length ?? 0;
      console.log(`  t+${i}s: agents.list OK (${ac}) · models.list OK (${mc})  → ENGINE BACK`);
      recovered = true; break;
    }
    const errs = [a, m].filter((x) => !x.ok).map((x) => x.error?.message ?? "?");
    for (const e of errs) {
      const warm = isEngineWarmingUp(e);
      if (warm) sawWarming = true; else allClassified = false;
      console.log(`  t+${i}s: ERR "${e}"  → isEngineWarmingUp=${warm}`);
    }
    await sleep(1000);
  }

  // ── (3) cleanup ──────────────────────────────────────────────────────────
  console.log("\n=== (3) cleanup: delete dummy GROQ key ===");
  const del = await call("providers.deleteEnv", { key: "GROQ_API_KEY" });
  console.log("  deleteEnv GROQ ok=" + del.ok + " restarted=" + JSON.stringify(del.result?.restarted));

  console.log("\n=== VERDICT ===");
  console.log("  saw transient restart errors : " + sawWarming);
  console.log("  ALL restart errors classified as warming (no raw-string leak to user): " + allClassified);
  console.log("  engine recovered (agents+models load again): " + recovered);
  console.log(sawWarming && allClassified && recovered
    ? "  PASS — popup shows 'menyiapkan…' + polls + recovers, never the raw crash / infinite spinner."
    : "  REVIEW — inspect the error strings above.");

  ws.close(); setTimeout(() => process.exit(0), 400);
});
