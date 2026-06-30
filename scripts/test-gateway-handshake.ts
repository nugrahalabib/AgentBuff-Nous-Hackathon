import WebSocket from "ws";

const url = "ws://127.0.0.1:18789/";
const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.argv[2];
if (!token) {
  console.error("usage: tsx test-gateway-handshake.ts <token>");
  process.exit(1);
}

const ws = new WebSocket(url, { perMessageDeflate: false });

ws.on("open", () => console.log("[open]"));
ws.on("error", (err) => {
  console.error("[error]", err.message);
  process.exit(1);
});

ws.on("message", (raw) => {
  const text = raw.toString("utf8");
  console.log("[msg]", text.slice(0, 600));
  try {
    const frame = JSON.parse(text);
    if (frame.type === "event" && frame.event === "connect.challenge") {
      const reqId = "test-" + Date.now();
      const connect = {
        type: "req",
        id: reqId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "gateway-client",
            version: "1",
            platform: "node",
            mode: "backend",
            instanceId: "handshake-test",
          },
          role: "operator",
          scopes: [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
          ],
          caps: ["tool-events"],
          auth: { token },
          userAgent: "agentbuff-portal/1.0",
          locale: "id-ID",
        },
      };
      console.log("[send] connect req", reqId);
      ws.send(JSON.stringify(connect));
    } else if (frame.type === "res") {
      console.log("[res] ok=", frame.ok, "error=", JSON.stringify(frame.error));
      setTimeout(() => { ws.close(); process.exit(frame.ok ? 0 : 2); }, 300);
    }
  } catch (e) {
    console.error("[parse-error]", (e as Error).message);
  }
});

setTimeout(() => {
  console.error("[timeout] no res after 8s");
  process.exit(3);
}, 8000);
