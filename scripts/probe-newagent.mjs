#!/usr/bin/env node
// Prove a BRAND-NEW agent created THE WAY THE WIZARD CREATES IT (model +
// providerSlug forwarded) is fully chatable + per-agent isolated:
//   - instantiate({model, providerSlug}) -> agent gets a WORKING model
//   - chat.send -> reply, echoed key = agent:<id>:<sid> (NOT agent:main = not Buff)
//   - 2nd send APPENDS (continuity, no fork)
// Usage: node scripts/probe-newagent.mjs <port> <token> [model] [providerSlug]
import WebSocket from "ws";
const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const MODEL = process.argv[4] ?? "gpt-5.5";
const PROVIDER = process.argv[5] ?? "openai-codex";
const AID = "zz-parity-test";
if (!port || !token) { console.error("usage: <port> <token> [model] [providerSlug]"); process.exit(1); }
const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });
let nid = 1; const pending = new Map();
const send = (method, params = {}) => { const id = String(nid++); ws.send(JSON.stringify({ type: "req", id, method, params })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 30000); }); };
const events = [];
ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.type === "res") { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.res(m.payload ?? null) : p.rej(new Error(m.error?.message || JSON.stringify(m.error))); } } else if (m.type === "event" && m.event === "chat") events.push(m.payload || {}); });
async function waitFinal() { const dl = Date.now() + 60000; while (Date.now() < dl) { const f = events.find(e => e.state === "final"); const er = events.find(e => e.state === "error"); if (f) return { ok: true, text: (f.message?.content?.[0]?.text || "").slice(0,60) }; if (er) return { ok: false, text: er.errorMessage }; await new Promise(r => setTimeout(r, 400)); } return { ok: false, text: "no final" }; }
const msgCount = async (key) => { try { const g = await send("sessions.get", { key }); const ms = g?.messages ?? []; return Array.isArray(ms) ? ms.length : -1; } catch (e) { return `ERR:${e.message}`; } };

ws.on("open", async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };
  await send("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" }, role: "operator", scopes: SCOPES, auth: { token } });
  try { await send("agents.delete", { agentId: AID }); } catch {}
  const tpls = await send("agents.template.list", {});
  const tpl = (tpls?.templates ?? [])[0];
  // Replicate the wizard's finish call exactly (model + providerSlug + fallbacks)
  await send("agents.template.instantiate", { templateId: tpl.id, newAgentId: AID, name: "ZZ Parity Test", model: MODEL, providerSlug: PROVIDER, fallbacks: [] });
  const got = await send("agents.get", { agentId: AID });
  const gm = (got?.model ?? got?.agent?.model) ?? {};
  ok("new agent has a non-empty model (wizard-seeded)", !!(gm.primary && gm.primary.trim()), `model=${JSON.stringify(gm)}`);

  const created = await send("sessions.create", { agentId: AID });
  const sid = created?.session_id || created?.id || created?.sessionId;
  const key0 = sid ? `agent:${AID}:${sid}` : `agent:${AID}:bootstrap`;

  events.length = 0;
  const ack1 = await send("chat.send", { sessionKey: key0, message: "halo, bales satu kata: hai" });
  const r1 = await waitFinal();
  ok("1st reply arrived (model WORKS, no 'tidak tersedia')", r1.ok, r1.text);
  ok("echoed key carries the new agent (NOT agent:main)", (ack1?.sessionKey || "").startsWith(`agent:${AID}:`), `echoed=${ack1?.sessionKey}`);
  const key = ack1?.sessionKey || key0;
  const after1 = await msgCount(key);

  const listBefore = (await send("sessions.list", {}))?.sessions?.length ?? -1;
  events.length = 0;
  const ack2 = await send("chat.send", { sessionKey: key, message: "lagi, bales satu kata: oke" });
  const r2 = await waitFinal();
  await new Promise(r => setTimeout(r, 2000));
  const listAfter = (await send("sessions.list", {}))?.sessions?.length ?? -1;
  const after2 = await msgCount(key);
  ok("2nd reply arrived", r2.ok, r2.text);
  ok("echoed key stable (no pivot)", ack2?.sessionKey === key, `echoed=${ack2?.sessionKey}`);
  ok("no new session forked on 2nd send", listAfter === listBefore, `before=${listBefore} after=${listAfter}`);
  ok("turns appended (msgs grew)", typeof after2 === "number" && typeof after1 === "number" && after2 > after1, `after1=${after1} after2=${after2}`);

  try { await send("agents.delete", { agentId: AID }); console.log("(cleaned up agent)"); } catch {}
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  ws.close(1000); process.exit(fail === 0 ? 0 : 2);
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
