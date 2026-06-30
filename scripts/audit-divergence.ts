/**
 * Prove per-agent tools/skills are INDEPENDENT: toggle one tool OFF for kiwi,
 * confirm kiwi diverges from default, confirm default unaffected, then REVERT.
 * Also dumps the real skills.status shape (audit showed 0/0 — verify field).
 *   run: pnpm tsx --env-file=.env.local scripts/audit-divergence.ts
 */
import WebSocket from "ws";
const PORT = 18800;
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";
const SC = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
let _id = 0;
const pend = new Map<string, { res: (v: any) => void; rej: (e: Error) => void }>();
const rpc = (m: string, p: Record<string, unknown> = {}): Promise<any> => {
  const id = String(++_id);
  ws.send(JSON.stringify({ type: "req", id, method: m, params: p }));
  return new Promise((res, rej) => { pend.set(id, { res, rej }); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000); });
};
ws.on("message", (raw: Buffer) => {
  let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "res") { const pr = pend.get(m.id); if (pr) { pend.delete(m.id); (m.ok === false || m.error) ? pr.rej(new Error(m.error?.message || "err")) : pr.res(m.payload ?? m.result); } }
});

const enabledIds = (tc: any) => (tc?.groups ?? []).filter((g: any) => g.enabled).map((g: any) => g.id).sort();

ws.on("open", async () => {
  await rpc("connect", { minProtocol: 3, maxProtocol: 3, client: { id: "openclaw-control-ui", version: "1", platform: "node", mode: "operator" }, role: "operator", scopes: SC, auth: { token: TOKEN } });

  // --- skills.status real shape ---
  console.log("=== skills.status shape (kiwi) ===");
  const ss = await rpc("skills.status", { agentId: "kiwi" });
  console.log("  top-level keys:", Object.keys(ss || {}));
  const arr = ss?.skills ?? ss?.entries ?? ss?.items ?? [];
  console.log("  array len:", Array.isArray(arr) ? arr.length : "(not array)");
  if (Array.isArray(arr) && arr[0]) console.log("  sample entry keys:", Object.keys(arr[0]));

  // --- baseline tools ---
  const defBefore = enabledIds(await rpc("tools.catalog", { agentId: "default", includePlugins: true }));
  const kiwiBefore = enabledIds(await rpc("tools.catalog", { agentId: "kiwi", includePlugins: true }));
  console.log("\n=== BASELINE tools enabled ===");
  console.log("  default:", defBefore.length, "| kiwi:", kiwiBefore.length, "| identical:", JSON.stringify(defBefore) === JSON.stringify(kiwiBefore));

  // pick a tool that is currently ON for kiwi and is a safe non-essential to flip (homeassistant)
  const flip = kiwiBefore.find((id: string) => /homeassistant/.test(id)) || kiwiBefore.find((id: string) => /x_search|yuanbao/.test(id));
  console.log("\n=== DIVERGENCE TEST: turn OFF '" + flip + "' for KIWI only ===");
  if (!flip) { console.log("  no safe tool to flip; skip"); console.log("DIVERGENCE_DONE"); ws.close(1000); process.exit(0); }

  await rpc("tools.toggle", { agentId: "kiwi", toolset: flip, enable: false });
  await new Promise((r) => setTimeout(r, 16000)); // wait engine reload

  const defAfter = enabledIds(await rpc("tools.catalog", { agentId: "default", includePlugins: true }));
  const kiwiAfter = enabledIds(await rpc("tools.catalog", { agentId: "kiwi", includePlugins: true }));
  console.log("  after: default=", defAfter.length, "kiwi=", kiwiAfter.length);
  const kiwiDropped = kiwiBefore.length - kiwiAfter.length === 1 && !kiwiAfter.includes(flip);
  const defUnchanged = JSON.stringify(defAfter) === JSON.stringify(defBefore);
  console.log("  kiwi lost ONLY '" + flip + "' :", kiwiDropped ? "PASS" : "FAIL");
  console.log("  default UNAFFECTED            :", defUnchanged ? "PASS (independen!)" : "FAIL (bocor ke default!)");

  // --- REVERT ---
  console.log("\n=== REVERT (turn it back ON for kiwi) ===");
  await rpc("tools.toggle", { agentId: "kiwi", toolset: flip, enable: true });
  await new Promise((r) => setTimeout(r, 16000));
  const kiwiReverted = enabledIds(await rpc("tools.catalog", { agentId: "kiwi", includePlugins: true }));
  console.log("  kiwi restored:", kiwiReverted.length === kiwiBefore.length ? "PASS" : `CHECK (${kiwiReverted.length} vs ${kiwiBefore.length})`);

  console.log("\nDIVERGENCE_DONE");
  ws.close(1000); process.exit(0);
});
ws.on("error", (e) => { console.error("wserr", (e as Error).message); process.exit(1); });
