#!/usr/bin/env node
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const msg = process.argv[4] ?? "tts: halo iter3 test";

const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
  headers: { Origin: `http://127.0.0.1:${port}` },
});

let id = 1;
const pending = new Map();
function send(method, params = {}) {
  const idStr = String(id++);
  ws.send(JSON.stringify({ type: "req", id: idStr, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(idStr, { resolve, reject });
    setTimeout(() => {
      if (pending.has(idStr)) {
        pending.delete(idStr);
        reject(new Error("timeout " + method));
      }
    }, 60000);
  });
}

let sawFinal = false;
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw);
    if (m.type === "res") {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.ok) p.resolve(m.payload ?? null);
        else p.reject(new Error(m.error?.message || "unknown"));
      }
    } else if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") {
      sawFinal = true;
    }
  } catch {}
});

ws.on("open", async () => {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe-iter3", version: "1", platform: "node", mode: "backend" },
    role: "operator",
    scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"],
    auth: { token },
  });
  console.log("✅ connected");
  const ack = await send("chat.send", { sessionKey: "iter3-rewrite-test", message: msg });
  const sessionKey = ack.sessionKey;
  console.log("📤 chat sent, sessionKey:", sessionKey);

  // Wait for final
  const deadline = Date.now() + 60000;
  while (!sawFinal && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("✓ final received, waiting 2s for persistence");
  await new Promise(r => setTimeout(r, 2500));

  // Now query sessions.get
  const got = await send("sessions.get", { key: sessionKey });
  console.log("\n=== sessions.get assistant text content ===");
  let foundMedia = false;
  for (const msg of (got.messages || [])) {
    if (msg.role === "assistant") {
      const txt = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      if (txt) {
        console.log("---");
        console.log(JSON.stringify(txt));
        if (txt.includes("MEDIA:")) foundMedia = true;
      }
    }
  }
  console.log("");
  console.log("MEDIA: tag in result:", foundMedia);

  ws.close(1000);
  process.exit(0);
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
