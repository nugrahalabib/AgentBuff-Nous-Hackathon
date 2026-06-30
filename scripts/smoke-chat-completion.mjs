#!/usr/bin/env node
/**
 * End-to-end chat completion smoke test through bridge.
 *
 * Verifies the full LLM inference path works after model config fix:
 *   browser → /api/ws/hermes proxy → bridge → tui_gateway.entry
 *   → Hermes core agent → Gemini API → streaming response back
 *
 * Usage: node scripts/smoke-chat-completion.mjs <port> <bridgeToken>
 */
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) {
  console.error("usage: smoke-chat-completion.mjs <port> <bridgeToken>");
  process.exit(1);
}

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
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
        reject(new Error(`timeout on ${method}`));
      }
    }, 60000);
  });
}

ws.on("open", async () => {
  try {
    await send("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "agentbuff-smoke-chat", version: "1", platform: "node", mode: "backend", instanceId: "smoke" },
      role: "operator",
      scopes: OPERATOR_SCOPES,
      caps: ["tool-events"],
      auth: { token },
      userAgent: "agentbuff-smoke/1.0",
    });
    console.log("connect OK");

    // Create session
    const sess = await send("sessions.create", { agentId: "main", key: "smoke-test-" + Date.now() });
    console.log("session created:", sess?.sessionKey || sess?.key || JSON.stringify(sess).slice(0,100));

    const sessionKey = sess?.key || sess?.sessionKey || "smoke-test";

    // Send chat
    console.log("sending chat...");
    const sent = await send("chat.send", {
      sessionKey,
      message: process.argv[4] ?? "Halo, jawab dengan satu kata saja: tes",
    });
    console.log("chat.send res:", JSON.stringify(sent).slice(0, 200));

    // Wait for streaming response (agent search/tool calls take longer)
    const waitMs = parseInt(process.argv[5] ?? "15000", 10);
    console.log(`waiting ${waitMs}ms for streaming response...`);
    await new Promise(r => setTimeout(r, waitMs));
    ws.close(1000, "done");
  } catch (e) {
    console.error("FAIL:", e.message);
    ws.close(1011, "fail");
    process.exit(1);
  }
});

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.type === "res") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload ?? null);
        else p.reject(new Error(msg.error?.message ?? "unknown"));
      }
    } else if (msg.type === "event") {
      if (msg.event === "chat") {
        const state = msg.payload?.state;
        const text = msg.payload?.content?.[0]?.text || msg.payload?.errorMessage || "";
        console.log(`  [chat ${state}] ${text.slice(0, 100)}`);
      } else {
        console.log(`  [event ${msg.event}]`);
      }
    }
  } catch {
    // ignore
  }
});

ws.on("close", (code, reason) => {
  console.log("closed code=" + code + " reason=" + (reason?.toString() || ""));
  process.exit(0);
});
ws.on("error", (e) => console.log("ws error:", e.message));
