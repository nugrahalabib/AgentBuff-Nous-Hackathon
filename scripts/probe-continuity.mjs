#!/usr/bin/env node
// DEFINITIVE per-agent chat continuity test (post-restart = sessions evicted =
// the exact TIER-2 resume path). Proves the profile-aware resume fix:
//   - send to an EXISTING manager-pribadi session
//   - reply must arrive
//   - session COUNT must NOT grow (no fork -> no "tiap balas bikin sesi baru")
//   - the SAME session must gain the new turn (append, not a new thread)
// Usage: node scripts/probe-continuity.mjs <port> <token> [agentPrefix]
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const agentPrefix = process.argv[4] ?? "manager-pribadi";
if (!port || !token) { console.error("usage: <port> <token> [agentPrefix]"); process.exit(1); }

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
let finalText = null, errText = null, echoedKey = null;
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.ok ? p.res(m.payload ?? null) : p.rej(new Error(m.error?.message || JSON.stringify(m.error) || "unk")); }
  } else if (m.type === "event" && m.event === "chat") {
    const p = m.payload || {};
    if (p.state === "final") finalText = (p.message?.content?.[0]?.text || "").slice(0, 80);
    if (p.state === "error") errText = p.errorMessage || "error";
  }
});

const sessKeys = (r) => (r?.sessions ?? r?.result?.sessions ?? []).map((s) => s.key);
const msgCount = async (key) => {
  try { const g = await send("sessions.get", { key }); const msgs = g?.messages ?? g?.result?.messages ?? []; return Array.isArray(msgs) ? msgs.length : -1; }
  catch (e) { return `ERR:${e.message}`; }
};

ws.on("open", async () => {
  await send("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" }, role: "operator", scopes: SCOPES, auth: { token } });

  const before = await send("sessions.list", {});
  const beforeKeys = sessKeys(before);
  const target = beforeKeys.find((k) => k.startsWith(`agent:${agentPrefix}:`));
  if (!target) { console.log(`NO ${agentPrefix} session to test. keys=${beforeKeys.slice(0,5).join(", ")}`); ws.close(1000); process.exit(3); }
  const beforeCount = beforeKeys.length;
  const beforeMsgs = await msgCount(target);
  console.log(`BEFORE: ${beforeCount} sessions, target=${target}, msgs=${beforeMsgs}`);

  const ack = await send("chat.send", { sessionKey: target, message: "tes continuity profile-aware, bales singkat: mantap" });
  echoedKey = ack?.sessionKey ?? null;
  console.log(`chat.send ACK echoedKey=${echoedKey}`);

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && finalText === null && errText === null) await new Promise(r => setTimeout(r, 500));

  // settle: give the gateway a moment to persist the turn + list refresh
  await new Promise(r => setTimeout(r, 2500));
  const after = await send("sessions.list", {});
  const afterKeys = sessKeys(after);
  const afterCount = afterKeys.length;
  const afterMsgs = await msgCount(target);

  console.log(`AFTER:  ${afterCount} sessions, target msgs=${afterMsgs}`);
  console.log("");
  let pass = 0, fail = 0;
  const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };
  ok("reply arrived", finalText !== null && !errText, errText ? `ERR: ${errText}` : `"${finalText}"`);
  ok("session COUNT did not grow (no fork)", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
  ok("echoed key == target (no client pivot)", echoedKey === target, `echoed=${echoedKey}`);
  ok("turn APPENDED to same session (+2 msgs)", typeof afterMsgs === "number" && typeof beforeMsgs === "number" && afterMsgs >= beforeMsgs + 1, `before=${beforeMsgs} after=${afterMsgs}`);
  ok("target session still present in list", afterKeys.includes(target), "");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  ws.close(1000); process.exit(fail === 0 ? 0 : 2);
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
