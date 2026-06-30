// Live smoke-probe for sessions.* bridge RPCs (read-only methods only).
// Same connect contract as probe-kanban-rpc.mjs. No mutations.
// Run: node scripts/probe-sessions-rpc.mjs <port> <token>
import WebSocket from "ws";

const PORT = process.argv[2] ?? "18800";
const TOKEN = process.argv[3] ?? "";
if (!TOKEN) {
  console.error("usage: node scripts/probe-sessions-rpc.mjs <port> <token>");
  process.exit(1);
}

const WS_URL = `ws://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let idCounter = 1;
const pending = new Map();
let connectedResolve;
const connected = new Promise((r) => (connectedResolve = r));
const ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = String(idCounter++);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: { message: "timeout 15s" } });
      }
    }, 15_000);
  });
}

ws.on("message", (buf) => {
  let f;
  try {
    f = JSON.parse(String(buf));
  } catch {
    return;
  }
  if (f.type === "res" && pending.has(f.id)) {
    const resolve = pending.get(f.id);
    pending.delete(f.id);
    resolve({ ok: f.ok, result: f.payload ?? f.result, error: f.error });
  }
});

function summarize(name, r) {
  if (!r.ok) {
    console.log(`x ${name}: ERROR ${r.error?.code ?? ""} ${r.error?.message ?? ""}`);
    return;
  }
  const res = r.result;
  const keys = res && typeof res === "object" ? Object.keys(res) : [typeof res];
  console.log(`ok ${name}: keys=[${keys.join(",")}]`);
  return res;
}

ws.on("open", async () => {
  const conn = await call("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.approvals", "operator.pairing", "operator.read", "operator.write"],
    auth: { token: TOKEN },
  });
  connectedResolve(conn);
  if (!conn?.ok) {
    console.error("connect failed:", JSON.stringify(conn?.error ?? conn));
    process.exit(1);
  }
  console.log("ok connect (auth accepted)");

  const list = await call("sessions.list", {});
  const l = summarize("sessions.list", list);
  const arr = l?.sessions ?? l?.items ?? [];
  console.log(`  sessions count: ${Array.isArray(arr) ? arr.length : "?"}`);
  if (Array.isArray(arr) && arr[0]) console.log("  first session keys:", Object.keys(arr[0]).join(","));

  summarize("sessions.usage", await call("sessions.usage", {}));
  summarize("sessions.search(q=halo)", await call("sessions.search", { query: "halo" }));

  if (Array.isArray(arr) && arr[0]) {
    const key = arr[0].key ?? arr[0].sessionKey ?? arr[0].id;
    summarize(`sessions.get(${String(key).slice(0, 24)})`, await call("sessions.get", { sessionKey: key, key }));
    summarize("sessions.preview", await call("sessions.preview", { sessionKey: key, key }));
    summarize("sessions.compaction.list", await call("sessions.compaction.list", { sessionKey: key, key }));
  } else {
    console.log("  (no sessions — skipping get/preview/compaction probes)");
  }

  ws.close();
  setTimeout(() => process.exit(0), 400);
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
