#!/usr/bin/env node
/**
 * Send a chat that should TRIGGER tool calls + thinking, then log every
 * event frame the bridge emits. Used to verify event translator coverage
 * against UI expectations.
 *
 * Usage: node scripts/probe-chat-events.mjs <port> <bridgeToken> "<message>"
 */
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const message = process.argv[4] ?? "Pakai execute_code tool buat hitung 2+2, lalu jawab dengan satu kata: nilainya.";
if (!port || !token) {
  console.error("usage: probe-chat-events.mjs <port> <bridgeToken> [message]");
  process.exit(1);
}

const OPERATOR_SCOPES = [
  "operator.admin", "operator.read", "operator.write",
  "operator.approvals", "operator.pairing",
];

const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
  headers: { Origin: `http://127.0.0.1:${port}` },
});

let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }
    }, 30000);
  });
}

const eventCounts = new Map();
const sampleByEvent = new Map();

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.type === "res") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload ?? null);
        else p.reject(new Error(msg.error?.message || "unk"));
      }
    } else if (msg.type === "event") {
      const ev = msg.event || "unknown";
      eventCounts.set(ev, (eventCounts.get(ev) ?? 0) + 1);
      if (!sampleByEvent.has(ev)) {
        // Save first sample payload for inspection
        sampleByEvent.set(ev, JSON.stringify(msg.payload || {}).slice(0, 400));
      }
      // Live log narrow agent + chat events
      if (ev === "agent" || ev === "chat") {
        const p = msg.payload || {};
        const lbl = ev === "chat"
          ? `chat[state=${p.state}, text=${(p.message?.content?.[0]?.text || "").slice(0, 30).replace(/\n/g, "↵")}]`
          : `agent[stream=${p.stream}, data.keys=${Object.keys(p.data || {}).join(",")}]`;
        console.log("  📡 " + lbl);
      } else if (ev.startsWith("tool.") || ev.startsWith("thinking.") || ev.startsWith("reasoning.")) {
        console.log("  🔧 " + ev + " " + JSON.stringify(msg.payload || {}).slice(0, 120));
      }
    }
  } catch {}
});

ws.on("open", async () => {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: OPERATOR_SCOPES, auth: { token },
  });
  console.log("✅ connected");
  console.log(`🚀 sending: "${message}"`);
  const ack = await send("chat.send", { sessionKey: "probe", message });
  console.log(`📨 chat.send ack — sessionKey echo: ${ack.sessionKey}`);

  // Wait until we see a state=final chat event, or 90s deadline
  let sawFinal = false;
  ws.on("message", raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") {
        sawFinal = true;
      }
    } catch {}
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !sawFinal) {
    await new Promise(r => setTimeout(r, 500));
  }
  // Give 2s extra for trailing events (reasoning.available, etc.)
  await new Promise(r => setTimeout(r, 2000));

  console.log("\n=== Event totals ===");
  for (const [ev, count] of [...eventCounts.entries()].sort()) {
    console.log(`  ${count.toString().padStart(3)}  ${ev}`);
  }
  console.log("\n=== First sample of each event ===");
  for (const [ev, sample] of [...sampleByEvent.entries()].sort()) {
    console.log(`  📝 ${ev}: ${sample}`);
  }
  ws.close(1000);
  process.exit(0);
});

ws.on("close", () => process.exit(0));
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
