#!/usr/bin/env node
/**
 * Smoke test: connect to local Hermes bridge, send `connect` handshake,
 * verify it returns ok:true, then issue a benign `sessions.list` RPC.
 *
 * Usage:
 *   node scripts/smoke-test-hermes-ws.mjs [host:port] [token]
 *
 * Defaults: 127.0.0.1:18999 / test-token-32-chars-aaaaaaaaaaaaaa
 */
import WebSocket from "ws";

const target = process.argv[2] || "127.0.0.1:18999";
const token = process.argv[3] || "test-token-32-chars-aaaaaaaaaaaaaa";

const url = `ws://${target}/`;
console.log(`[smoke] connecting ${url}`);

const ws = new WebSocket(url, {
  headers: { Origin: `http://${target}` },
});

let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = String(nextId++);
  const frame = { type: "req", id, method, params };
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }
    }, 8000);
  });
}

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

ws.on("open", async () => {
  console.log("[smoke] connected, sending connect frame");
  try {
    const connectRes = await send("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "agentbuff-smoke-test",
        version: "0.0.1",
        platform: "node",
        mode: "backend",
        instanceId: "smoke",
      },
      role: "operator",
      scopes: OPERATOR_SCOPES,
      caps: ["tool-events"],
      auth: { token },
      userAgent: "agentbuff-smoke-test/0.0.1",
      locale: "id-ID",
    });
    console.log("[smoke] connect ok:", JSON.stringify(connectRes).slice(0, 200));

    const sessionsRes = await send("sessions.list", {});
    console.log("[smoke] sessions.list ok:", JSON.stringify(sessionsRes).slice(0, 200));

    const usageRes = await send("sessions.usage", {});
    console.log("[smoke] sessions.usage ok:", JSON.stringify(usageRes).slice(0, 200));

    const engineRes = await send("system.engine.status", {});
    console.log("[smoke] system.engine.status:", JSON.stringify(engineRes).slice(0, 200));

    console.log("[smoke] ALL PASS");
    ws.close(1000, "smoke done");
    process.exit(0);
  } catch (err) {
    console.error("[smoke] FAIL:", err.message);
    ws.close(1011, "smoke failed");
    process.exit(1);
  }
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    console.log("[smoke] non-JSON frame:", raw.toString("utf8").slice(0, 200));
    return;
  }
  if (msg.type === "res") {
    const slot = pending.get(msg.id);
    if (slot) {
      pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.payload ?? null);
      else slot.reject(new Error(msg.error?.message || "unknown"));
    } else {
      console.log("[smoke] res for unknown id:", msg.id);
    }
  } else if (msg.type === "event") {
    console.log(`[smoke] event ${msg.event}:`, JSON.stringify(msg.payload || {}).slice(0, 120));
  } else {
    console.log("[smoke] unhandled frame:", JSON.stringify(msg).slice(0, 200));
  }
});

ws.on("error", (err) => {
  console.error("[smoke] ws error:", err.message);
});

ws.on("close", (code, reason) => {
  console.log(`[smoke] closed code=${code} reason=${reason?.toString("utf8") || ""}`);
});
