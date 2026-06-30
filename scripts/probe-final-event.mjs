#!/usr/bin/env node
// Probe the bridge to capture the FULL final chat event payload.
// Usage: node scripts/probe-final-event.mjs <port> <bridgeToken> "<msg>"
import WebSocket from "ws";
const [, , port, token, ...rest] = process.argv;
const msg = rest.join(" ") || "tts: halo probe final";
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
  headers: { Origin: `http://127.0.0.1:${port}` },
});
let nextId = 1;
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const id = String(nextId++);
    const onMsg = (raw) => {
      const x = JSON.parse(raw);
      if (x.type === "res" && x.id === id) {
        ws.off("message", onMsg);
        resolve(x.payload ?? null);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "req", id, method: m, params: p }));
  });

ws.on("open", async () => {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe-final", version: "1", platform: "node", mode: "backend" },
    role: "operator",
    scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"],
    auth: { token },
  });
  console.log("✅ connected");
  console.log(`🚀 sending: "${msg}"`);
  await send("chat.send", { sessionKey: "probe-final", message: msg });
  let done = false;
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") {
        console.log("\n=== FINAL CHAT EVENT (full payload) ===");
        console.log(JSON.stringify(m.payload, null, 2));
        done = true;
      }
    } catch {}
  });
  const deadline = Date.now() + 60000;
  while (!done && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 1500));
  ws.close(1000);
  process.exit(0);
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
