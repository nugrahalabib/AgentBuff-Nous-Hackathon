#!/usr/bin/env node
// Regression: send a chat to a specific per-agent sessionKey and confirm a
// final reply streams back. Proves profile-injected sessions still chat.
// Usage: node scripts/probe-chat-peragent.mjs <port> <token> <sessionKey> [message]
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const sessionKey = process.argv[4] ?? "agent:main:probe";
const message = process.argv[5] ?? "Bales satu kata aja: oke";
if (!port || !token) { console.error("usage: <port> <token> <sessionKey> [msg]"); process.exit(1); }

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });
let nextId = 1; const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
  });
}
let finalText = null, errText = null;
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.ok ? p.res(m.payload ?? null) : p.rej(new Error(m.error?.message || "unk")); }
  } else if (m.type === "event" && m.event === "chat") {
    const p = m.payload || {};
    if (p.state === "final") finalText = (p.message?.content?.[0]?.text || "").slice(0, 80);
    if (p.state === "error") errText = p.errorMessage || "error";
  }
});
ws.on("open", async () => {
  await send("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" }, role: "operator", scopes: SCOPES, auth: { token } });
  console.log(`[${sessionKey}] connected, sending...`);
  await send("chat.send", { sessionKey, message });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && finalText === null && errText === null) await new Promise(r => setTimeout(r, 500));
  if (errText) console.log(`[${sessionKey}] ❌ ERROR: ${errText}`);
  else if (finalText !== null) console.log(`[${sessionKey}] ✅ REPLY: "${finalText}"`);
  else console.log(`[${sessionKey}] ⏱️ NO FINAL within 90s`);
  ws.close(1000); process.exit(errText ? 2 : (finalText !== null ? 0 : 3));
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
