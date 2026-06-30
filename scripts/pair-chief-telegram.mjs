#!/usr/bin/env node
/**
 * Pair chief's Telegram bot directly via the Hermes bridge WS.
 *
 * Uses the bridge's connect protocol (no connect.challenge dance like
 * OpenClaw — bridge expects an immediate connect REQ frame from the
 * client).
 */
import WebSocket from "ws";

// Secret: supply via env (CHIEF_TELEGRAM_TOKEN) — never hardcode a real token.
const CHIEF_TELEGRAM_TOKEN = process.env.CHIEF_TELEGRAM_TOKEN ?? "";

// Usage: node scripts/pair-chief-telegram.mjs <port> <bridgeToken>
const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) {
  console.error("usage: pair-chief-telegram.mjs <port> <bridgeToken>");
  console.error("Get values from: pnpm tsx --env-file=.env.local scripts/print-chief-container-info.ts");
  process.exit(1);
}
const info = { port, token };

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

console.log(`port=${info.port} token=${info.token.slice(0, 8)}...`);

const url = `ws://127.0.0.1:${info.port}/`;
const ws = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${info.port}` } });

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
    }, 30000);
  });
}

ws.on("open", async () => {
  try {
    const connectRes = await send("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "agentbuff-pair-script",
        version: "1.0",
        platform: "node",
        mode: "backend",
        instanceId: "pair-chief",
      },
      role: "operator",
      scopes: OPERATOR_SCOPES,
      caps: ["tool-events"],
      auth: { token: info.token },
      userAgent: "agentbuff-pair-script/1.0",
      locale: "id-ID",
    });
    console.log("connect ok:", JSON.stringify(connectRes).slice(0, 150));

    const pairRes = await send("channels.pair", {
      channel: "telegram",
      accountId: "default",
      credentials: { botToken: CHIEF_TELEGRAM_TOKEN },
    });
    console.log("channels.pair result:", JSON.stringify(pairRes, null, 2));

    ws.close(1000, "pair-done");
    process.exit(0);
  } catch (err) {
    console.error("FAIL:", err.message);
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
      console.log(`[event ${msg.event}]:`, JSON.stringify(msg.payload || {}).slice(0, 120));
    }
  } catch {
    // ignore non-JSON
  }
});

ws.on("error", (err) => console.error("ws error:", err.message));
ws.on("close", (code, reason) => console.log(`closed code=${code} reason=${reason?.toString() || ""}`));
