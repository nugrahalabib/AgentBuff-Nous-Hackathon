#!/usr/bin/env node
// Probe skills.status (the exact RPC the wizard reads) to confirm the seed worked.
import WebSocket from "ws";
const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
let _id = 0; const pend = new Map();
const rpc = (m, p = {}) => { const id = String(++_id); ws.send(JSON.stringify({ type:"req", id, method:m, params:p }));
  return new Promise((res, rej) => { pend.set(id, { res, rej }); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000); }); };
ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "res") { const p = pend.get(m.id); if (p) { pend.delete(m.id); (m.ok === false || m.error) ? p.rej(new Error(m.error?.message || "err")) : p.res(m.payload ?? m.result); } } });
ws.on("open", async () => {
  await rpc("connect", { minProtocol:3, maxProtocol:3, client:{ id:"openclaw-control-ui", version:"1", platform:"node", mode:"operator" }, role:"operator", scopes:SC, auth:{ token: TOKEN } });
  for (const aid of ["", "default"]) {
    try {
      const r = await rpc("skills.status", { agentId: aid });
      const arr = r?.skills || [];
      const cats = {};
      for (const s of arr) { const c = (s.category || s.path || "?").split("/")[0] || "?"; cats[c] = (cats[c]||0)+1; }
      console.log(`skills.status agentId="${aid}" → count=${arr.length}`);
      console.log("  categories=" + JSON.stringify(cats));
      console.log("  sample=" + JSON.stringify(arr.slice(0,8).map(s => s.name)));
    } catch (e) { console.log(`skills.status agentId="${aid}" ERR ${e.message}`); }
  }
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", e.message); process.exit(1); });
