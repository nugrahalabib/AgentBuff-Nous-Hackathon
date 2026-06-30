#!/usr/bin/env node
// Bug 1 regression: create a throwaway per-agent session, delete it, and prove
// it VANISHES from sessions.list (was: per-agent delete only hit root db, so
// the profile-aware list kept re-surfacing it). Usage: <port> <token> [agent]
import WebSocket from "ws";
const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const agent = process.argv[4] ?? "kak-tutor";
if (!port || !token) { console.error("usage: <port> <token> [agent]"); process.exit(1); }
const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });
let nid = 1; const pending = new Map();
const send = (m, p = {}) => { const id = String(nid++); ws.send(JSON.stringify({ type: "req", id, method: m, params: p })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + m)); } }, 30000); }); };
let finalSeen = false;
ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.type === "res") { const x = pending.get(m.id); if (x) { pending.delete(m.id); m.ok ? x.res(m.payload ?? null) : x.rej(new Error(m.error?.message || JSON.stringify(m.error))); } } else if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") finalSeen = true; });
const keys = (r) => (r?.sessions ?? []).map((s) => s.key);
ws.on("open", async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };
  await send("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" }, role: "operator", scopes: SCOPES, auth: { token } });
  // 1. create throwaway per-agent session via TIER-3 auto-create
  const placeholder = `agent:${agent}:zzdel-${Date.now().toString(36)}`;
  finalSeen = false;
  const ack = await send("chat.send", { sessionKey: placeholder, message: "tes delete, bales: ok" });
  const realKey = ack?.sessionKey || placeholder;
  const dl = Date.now() + 60000; while (Date.now() < dl && !finalSeen) await new Promise(r => setTimeout(r, 400));
  await new Promise(r => setTimeout(r, 1500));
  ok("throwaway session created (reply seen)", finalSeen, `key=${realKey}`);
  const before = keys(await send("sessions.list", {}));
  ok("session present in list before delete", before.includes(realKey), `present=${before.includes(realKey)}`);
  // 2. delete it
  const del = await send("sessions.delete", { key: realKey });
  console.log("delete ack:", JSON.stringify(del));
  // 3. immediately list + list again after a beat (tombstone + disk)
  const after1 = keys(await send("sessions.list", {}));
  await new Promise(r => setTimeout(r, 2000));
  const after2 = keys(await send("sessions.list", {}));
  ok("GONE from list immediately after delete", !after1.includes(realKey), `still=${after1.includes(realKey)}`);
  ok("STILL gone on 2nd list (no resurrection)", !after2.includes(realKey), `still=${after2.includes(realKey)}`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  ws.close(1000); process.exit(fail === 0 ? 0 : 2);
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
