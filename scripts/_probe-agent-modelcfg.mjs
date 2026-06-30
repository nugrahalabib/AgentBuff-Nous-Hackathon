// Live proof for per-agent model config (the bridge fix). Round-trips
// fallback + auxiliary + context window through agents.update on ONE agent,
// then verifies via agents.get that the row reflects them — agents.get reads
// _build_agent_row which now reads the REAL engine fields (fallback_providers,
// auxiliary.<task>, model_context_length). Then restores originals.
// Run: node scripts/_probe-agent-modelcfg.mjs <wsPort> <token>
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
const getRow = async (id) => {
  const r = await send("agents.get", { agentId: id });
  const v = r.payload ?? r.result ?? {};
  return v.agent ?? v.row ?? v;
};

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  const lr = await send("agents.list", {});
  const lv = lr.payload ?? lr.result ?? {};
  const agents = lv.agents ?? lv.rows ?? [];
  console.log("agents:", agents.map(a => a.id + (a.default ? "(default)" : "")).join(", "));
  // Prefer a NON-default agent to prove per-PROFILE scope; else default.
  const target = (agents.find(a => !a.default) ?? agents[0]);
  if (!target) { console.log("no agents"); ws.close(); setTimeout(()=>process.exit(1),200); return; }
  const id = target.id;
  console.log("TARGET agent:", id, target.default ? "(default→root config)" : "(named→profile config)");

  const before = await getRow(id);
  const mainModel = before?.model?.primary || "gpt-5.5";
  const origFb = Array.isArray(before?.model?.fallbacks) ? before.model.fallbacks : [];
  const origAuxTitle = before?.model?.auxiliary?.title_generation ?? { provider: "auto", model: "" };
  const origCtx = before?.model?.contextLength ?? 0;
  console.log("BEFORE: fallbacks=" + JSON.stringify(origFb) + " aux.title=" + JSON.stringify(origAuxTitle) + " ctx=" + origCtx);

  // WRITE test values — fallbacks as bare model-id strings (the UI shape).
  await send("agents.update", { agentId: id, patch: {
    model: { fallbacks: [mainModel] },
    auxiliary: { title_generation: { model: mainModel } },
    modelContextLength: 123456,
  }});
  const after = await getRow(id);
  const fbOk = Array.isArray(after?.model?.fallbacks)
    && after.model.fallbacks.includes(mainModel);
  const auxOk = after?.model?.auxiliary?.title_generation?.model === mainModel;
  const ctxOk = after?.model?.contextLength === 123456;
  console.log("AFTER : fallbacks=" + JSON.stringify(after?.model?.fallbacks)
    + " aux.title=" + JSON.stringify(after?.model?.auxiliary?.title_generation)
    + " ctx=" + after?.model?.contextLength);

  // RESTORE
  await send("agents.update", { agentId: id, patch: {
    model: { fallbacks: origFb },
    auxiliary: { title_generation: origAuxTitle },
    modelContextLength: origCtx,
  }});
  const restored = await getRow(id);
  const restoreOk = JSON.stringify(restored?.model?.fallbacks ?? []) === JSON.stringify(origFb)
    && (restored?.model?.contextLength ?? 0) === origCtx;
  console.log("RESTORED: fallbacks=" + JSON.stringify(restored?.model?.fallbacks) + " ctx=" + (restored?.model?.contextLength ?? 0));

  console.log("\n=== VERDICT ===");
  console.log("fallback→fallback_providers: " + (fbOk ? "PASS" : "FAIL"));
  console.log("auxiliary.title_generation : " + (auxOk ? "PASS" : "FAIL"));
  console.log("context window             : " + (ctxOk ? "PASS" : "FAIL"));
  console.log("restore                    : " + (restoreOk ? "PASS" : "FAIL"));
  console.log((fbOk && auxOk && ctxOk && restoreOk) ? "ALL PASS — per-agent model config writes the REAL engine fields + restores" : "SOME FAILED");
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) { console.error("probe error:", e?.message || e); ws.close(); setTimeout(()=>process.exit(1),300); }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
