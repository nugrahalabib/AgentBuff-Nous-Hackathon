#!/usr/bin/env node
// READ-ONLY audit of the requirement data the UI readiness resolver consumes.
// Dumps the RAW provider ids/statuses, channels, mcp, env so we can see exactly
// why a capability is (mis)classified. Writes JSON to a file.
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const AGENT = process.argv[2] || "kiwi";
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
let _id = 0; const pend = new Map();
const rpc = (m, p = {}) => { const id = String(++_id); ws.send(JSON.stringify({ type:"req", id, method:m, params:p }));
  return new Promise((res, rej) => { pend.set(id, { res, rej }); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000); }); };
ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "res") { const p = pend.get(m.id); if (p) { pend.delete(m.id); (m.ok === false || m.error) ? p.rej(new Error(m.error?.message || "err")) : p.res(m.payload ?? m.result); } } });
ws.on("open", async () => {
  await rpc("connect", { minProtocol:3, maxProtocol:3, client:{ id:"openclaw-control-ui", version:"1", platform:"node", mode:"operator" }, role:"operator", scopes:SC, auth:{ token: TOKEN } });
  const out = { agent: AGENT };
  // models.authStatus — the EXACT provider ids + statuses
  try {
    const ma = await rpc("models.authStatus", {});
    out.providers = (ma?.providers || []).map(p => ({ provider: p.provider, status: p.status, displayName: p.displayName }));
  } catch (e) { out.providers_err = e.message; }
  // channels.status — shape + which are "ready"
  try {
    const ch = await rpc("channels.status", {});
    let list = Array.isArray(ch?.channels) ? ch.channels
      : (ch?.channels && typeof ch.channels === "object")
        ? Object.entries(ch.channels).map(([channel, v]) => ({ channel, ...(v||{}) }))
        : [];
    out.channels = list.map(c => ({ channel: c.channel, connected: c.connected, running: c.running, configured: c.configured, lastError: c.lastError ? String(c.lastError).slice(0,40) : null }));
  } catch (e) { out.channels_err = e.message; }
  // mcp.list
  try { const mc = await rpc("mcp.list", {}); out.mcp = (mc?.servers || []).map(s => ({ name: s.name, enabled: s.enabled })); }
  catch (e) { out.mcp_err = e.message; }
  // env.list
  try { const en = await rpc("env.list", {}); out.envPresentKeys = en?.presentKeys || []; }
  catch (e) { out.env_err = e.message; }
  // tools.catalog — every toolset + enabled
  try { const tc = await rpc("tools.catalog", { agentId: AGENT, includePlugins: true });
    out.toolsets = (tc?.groups || []).map(g => ({ id: g.id, enabled: g.enabled, source: g.source })); }
  catch (e) { out.toolsets_err = e.message; }
  // plugins.list
  try { const pl = await rpc("plugins.list", {}); out.plugins = (pl?.plugins || []).map(p => ({ key: p.key, enabled: p.enabled, readOnly: p.readOnly })); }
  catch (e) { out.plugins_err = e.message; }
  writeFileSync("C:/Users/nugra/AppData/Local/Temp/audit-readiness.json", JSON.stringify(out, null, 1));
  console.log("WROTE audit-readiness.json");
  console.log("providers=" + JSON.stringify(out.providers));
  console.log("channels_ready=" + JSON.stringify((out.channels||[]).filter(c=>c.connected===true||(c.running===true&&!c.lastError)).map(c=>c.channel)));
  console.log("toolsets_total=" + (out.toolsets||[]).length + " enabled=" + (out.toolsets||[]).filter(t=>t.enabled).length);
  console.log("plugins=" + JSON.stringify(out.plugins));
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", e.message); process.exit(1); });
