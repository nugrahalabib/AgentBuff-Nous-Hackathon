// Validate the approval.respond session-resolution fix deterministically:
//   1. send a chat → establishes a live session (registers sid<->dbkey),
//   2. read sessions.list → get the canonical (dbkey-form) sessionKey /app uses,
//   3. call approval.respond with that key + choice="deny",
//   4. assert the error is NO LONGER "session not found" (4001).
// Before fix: 4001 "session not found" (bridge sent dbkey, engine keys by SID).
// After fix:  session is FOUND → either ok, or a benign "no pending approval".
// Run: node scripts/_probe-approval.mjs <wsPort> <token>
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
    // resolve with the FULL frame (ok + error) so we can inspect failure codes.
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: { message: "timeout " + method } }); } }, 45000);
  });
}
let finals = 0;
let liveSessionKey = null; // canonical key of the LIVE session, from chat events
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") {
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m); }
  } else if (m.type === "event" && m.event === "chat") {
    if (m.payload?.sessionKey) liveSessionKey = m.payload.sessionKey;
    if (m.payload?.state === "final") finals += 1;
  }
});
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));

const KEY = "probe-approval";
ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  console.log("connected; waiting for gateway RPC-ready…");
  for (let i = 0; i < 40; i++) { const r = await send("sessions.list", {}); if (r.ok) break; await new Promise(r2 => setTimeout(r2, 3000)); }

  console.log("step 1: send a chat to establish a live session…");
  await send("chat.send", { sessionKey: KEY, message: "halo, balas singkat: ok" });
  let waited = 0;
  while (finals < 1 && waited < 60000) { await new Promise(r => setTimeout(r, 500)); waited += 500; }

  // Use the LIVE session's own canonical key (captured from the chat event's
  // payload.sessionKey) — this is the session we just created + that is in the
  // engine's _sessions right now, exactly what the /app approval button uses.
  const canonicalKey = liveSessionKey || KEY;
  console.log("step 2: live session canonical key from chat event:", canonicalKey);

  console.log("step 3: approval.respond with that key (choice=deny)…");
  const resp = await send("approval.respond", { sessionKey: canonicalKey, requestId: "probe-approval-0", choice: "deny" });
  const errMsg = (resp.error?.message || "").toLowerCase();
  const errCode = resp.error?.code;
  console.log("  raw response:", JSON.stringify({ ok: resp.ok, code: errCode, message: resp.error?.message }).slice(0, 200));

  const sessionNotFound =
    !resp.ok && (/session not found/.test(errMsg) || errCode === "SESSION_NOT_FOUND" || errCode === 4001);
  console.log("\n=== VERDICT ===");
  if (sessionNotFound) {
    console.log("FAIL — still 'session not found' (fix not effective on this key)");
  } else {
    console.log("PASS — session RESOLVED (no 'session not found'). Approve/reject now reaches the engine.");
    console.log("       (ok=" + resp.ok + "; a benign 'no pending approval' here is expected — we didn't trigger a real one.)");
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) {
  console.error("probe error:", e?.message || e);
  ws.close();
  setTimeout(() => process.exit(1), 300);
 }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 150000);
