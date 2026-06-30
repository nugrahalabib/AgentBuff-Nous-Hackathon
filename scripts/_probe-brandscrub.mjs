// Live brand-scrub verification probe (correct wire shapes per probe-chat-events.mjs).
//   Test A: chat reply prose containing "hermes" is PRESERVED verbatim.
//   Test B: a tool/system (non-chat) frame echoing "hermes-agent" is SCRUBBED.
// Run: node scripts/_probe-brandscrub.mjs <port> <token>
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) { console.error("usage: _probe-brandscrub.mjs <port> <token>"); process.exit(1); }

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });

let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 30000);
  });
}

let chatText = "";
const nonChatFrames = [];          // {ev, raw} for any non-chat frame mentioning a brand token
let sawFinal = false;

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (msg.type === "res") {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.payload ?? null) : p.reject(new Error(msg.error?.message || "unk")); }
    return;
  }
  if (msg.type !== "event") return;
  const ev = msg.event || "unknown";
  const s = JSON.stringify(msg.payload || {});
  if (ev === "chat") {
    const t = msg.payload?.message?.content?.filter(b => b?.type === "text").map(b => b.text).join("") || "";
    if (t) chatText = t;
    if (msg.payload?.state === "final") sawFinal = true;
  } else if (/hermes|teknium|openclaw/i.test(s)) {
    // A NON-chat frame still carrying a raw brand token = leak.
    nonChatFrames.push({ ev, raw: s.slice(0, 240) });
  }
});

ws.on("open", async () => {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  console.log("connected");
  // Greek-god context (chief's exact example): the agent will naturally write
  // "Hermes" the mythological figure. Test A: this MUST survive verbatim in the
  // chat bubble (NOT rewritten to AgentBuff) so conversation context isn't
  // corrupted. This is the precise behaviour chief mandated.
  const msg = "Dalam mitologi Yunani, siapa nama dewa utusan / pembawa pesan para dewa "
    + "yang memakai sandal bersayap? Jawab dengan satu kata saja (nama dewa itu).";
  await send("chat.send", { sessionKey: "probe-brand", message: msg });
  console.log("chat sent, waiting for final...");
  const deadline = Date.now() + 75000;
  while (!sawFinal && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
  finalize();
});

function finalize() {
  const preserved = /hermes/i.test(chatText);
  const toolLeak = nonChatFrames.filter(f => /hermes/i.test(f.raw));
  console.log("\n=== RESULT ===");
  console.log("chat reply text:", JSON.stringify(chatText.slice(0, 160)));
  console.log("TEST A — chat 'hermes' PRESERVED verbatim:", preserved ? "PASS" : "FAIL (no hermes in reply / scrubbed)");
  console.log("non-chat frames mentioning brand:", nonChatFrames.length);
  if (toolLeak.length) { console.log("TEST B — LEAK in non-chat frame:"); toolLeak.slice(0,3).forEach(f => console.log("   ["+f.ev+"]", f.raw)); }
  else console.log("TEST B — non-chat frames brand-clean: PASS");
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.log("[hard timeout]"); finalize(); }, 90000);
