// Throwaway smoke test for the OpenClaw WS RPC chat flow.
// Run:  node scripts/test-ws-rpc.mjs
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const TOKEN = process.env.OPENCLAW_LOCAL_TOKEN ?? "agentbuff-dev-local-token-7b3c9f2e1a4d6859";
const PORT = Number(process.env.OPENCLAW_LOCAL_PORT ?? 18789);
const PROMPT = process.argv[2] ?? "Balas satu kata: warna langit?";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const pending = new Map();
const sessionKey = "agentbuff:smoketest";
let timer = setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(2);
}, 60_000);

function send(frame) {
  ws.send(JSON.stringify(frame));
}

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(3);
});
ws.on("close", (code, reason) => {
  console.error("ws closed", code, reason.toString());
});
ws.on("message", (raw) => {
  let f;
  try { f = JSON.parse(raw.toString()); } catch { return; }
  console.error("<-", f.type, f.event || f.method || f.id, f.ok ?? "");

  if (f.type === "event" && f.event === "connect.challenge") {
    const id = randomUUID();
    pending.set(id, "connect");
    send({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          version: "1.0.0",
          platform: "node",
          mode: "cli",
          instanceId: randomUUID(),
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
        caps: ["tool-events"],
        // auth omitted — gateway.auth.mode="none"
        userAgent: "agentbuff-smoke/1.0",
        locale: "id-ID",
      },
    });
    return;
  }

  if (f.type === "res") {
    const m = pending.get(f.id);
    pending.delete(f.id);
    if (f.ok === false) {
      console.error("RPC error:", JSON.stringify(f.error));
      process.exit(4);
    }
    if (m === "connect") {
      console.error("connect OK, policy:", JSON.stringify(f.payload?.policy));
      console.error("features.methods contains chat.send?", (f.payload?.features?.methods || []).includes("chat.send"));
      console.error("methods containing 'chat':", (f.payload?.features?.methods || []).filter(m => m.includes("chat")).join(", "));
      console.error("methods containing 'session':", (f.payload?.features?.methods || []).filter(m => m.includes("session")).join(", "));
      const id2 = randomUUID();
      pending.set(id2, "chat.send");
      send({
        type: "req",
        id: id2,
        method: "chat.send",
        params: {
          sessionKey,
          message: PROMPT,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      });
      return;
    }
    if (m === "chat.send") {
      console.error("chat.send ack");
      return;
    }
  }

  if (f.type === "event" && f.event === "chat") {
    const p = f.payload || {};
    if (p.sessionKey && p.sessionKey !== sessionKey) return;
    if (p.state === "delta") {
      process.stderr.write(".");
    } else if (p.state === "final") {
      console.error("\n--- FINAL ---");
      console.log(JSON.stringify(p.message, null, 2));
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    } else if (p.state === "error") {
      console.error("chat error:", p.errorMessage);
      process.exit(5);
    }
  }
});
