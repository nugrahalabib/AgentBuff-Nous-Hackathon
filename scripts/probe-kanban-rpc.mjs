// Live smoke-probe for kanban.* bridge RPCs (read-only methods only).
// Connects like the portal does (connect frame + operator token), calls each
// read RPC, prints ok/error + top-level result keys. No mutations.
// Run: node scripts/probe-kanban-rpc.mjs <port> <token>
import WebSocket from "ws";

const PORT = process.argv[2] ?? "18800";
const TOKEN = process.argv[3] ?? "";
if (!TOKEN) {
  console.error("usage: node scripts/probe-kanban-rpc.mjs <port> <token>");
  process.exit(1);
}

const WS_URL = `ws://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let idCounter = 1;
const pending = new Map();
let connectedResolve;
const connected = new Promise((r) => {
  connectedResolve = r;
});
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
    // Bridge res frames carry the data in `payload` (see agentbuff_bridge.py
    // _send_response); `result` kept as fallback for older frames.
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
  // This bridge takes `connect` as a normal first req frame (no challenge —
  // see scripts/audit-agents-rpc.mjs). Await its res before any other req.
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

  const boards = await call("kanban.boards", {});
  const b = summarize("kanban.boards", boards);
  const boardName =
    b?.boards?.[0]?.name ?? b?.boards?.[0]?.id ?? b?.default ?? undefined;
  console.log("  boards:", JSON.stringify(b?.boards ?? b ?? null)?.slice(0, 200));

  const tasks = await call("kanban.tasks", { board: boardName });
  const t = summarize("kanban.tasks", tasks);
  const list = t?.tasks ?? [];
  console.log(`  tasks count: ${Array.isArray(list) ? list.length : "?"}`);
  if (Array.isArray(list) && list[0]) {
    console.log("  first task keys:", Object.keys(list[0]).join(","));
  }

  summarize("kanban.diagnostics", await call("kanban.diagnostics", { board: boardName }));
  summarize("kanban.assignees", await call("kanban.assignees", { board: boardName }));
  summarize("kanban.orchestration", await call("kanban.orchestration", {}));

  if (Array.isArray(list) && list[0]) {
    const tid = list[0].id ?? list[0].taskId;
    const det = await call("kanban.taskDetail", { board: boardName, taskId: tid });
    summarize(`kanban.taskDetail(${tid})`, det);
    summarize(`kanban.workerLog(${tid})`, await call("kanban.workerLog", { board: boardName, taskId: tid }));
    summarize(`kanban.context(${tid})`, await call("kanban.context", { board: boardName, taskId: tid }));
  } else {
    console.log("  (no tasks — skipping taskDetail/workerLog/context probes)");
  }

  ws.close();
  // Windows: process.exit() truncates pending async stdout writes — give the
  // pipe a beat to flush before exiting.
  setTimeout(() => process.exit(0), 400);
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
