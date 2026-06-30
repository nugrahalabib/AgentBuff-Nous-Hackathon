// Validate the USER-upload media path is durable end-to-end:
//  send a chat with an image attachment → read the session back →
//  confirm the stored attachment URL is a durable /media/d/ URL.
// Run: node scripts/_probe-durable-upload.mjs <port> <token>
import WebSocket from "ws";

const port = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
if (!port || !token) { console.error("usage: <port> <token>"); process.exit(1); }

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: `http://127.0.0.1:${port}` } });
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 45000);
  });
}
let sawFinal = false;
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.ok ? p.resolve(m.payload ?? null) : p.reject(new Error(m.error?.message || "unk")); }
  } else if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") {
    sawFinal = true;
  }
});

process.on("unhandledRejection", (e) => { console.error("unhandledRejection:", e?.message || e); });

const KEY = "probe-durable-upload";
ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  console.log("connected; waiting for gateway RPC-ready…");
  // After reprovision the gateway scans skills before serving RPC — poll until
  // sessions.list works, then proceed.
  for (let i = 0; i < 40; i++) {
    try { await send("sessions.list", {}); break; }
    catch { await new Promise(r => setTimeout(r, 3000)); }
  }
  console.log("gateway ready; sending image attachment…");
  await send("chat.send", {
    sessionKey: KEY,
    message: "Validasi penyimpanan media. Balas singkat: ok.",
    attachments: [
      { type: "image", mimeType: "image/png", fileName: "durable-test.png", content: PNG_B64 },
    ],
  });
  const deadline = Date.now() + 60000;
  while (!sawFinal && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));

  // Read history back and inspect the stored attachment URLs.
  const hist = await send("sessions.get", { sessionKey: KEY, key: KEY });
  const msgs = hist?.messages ?? [];
  const raw = JSON.stringify(hist);
  const durableUrls = [...raw.matchAll(/http:\/\/[^"\\]*\/media\/d\/[^"\\]*/g)].map(m => m[0]);
  const tokenUrls = [...raw.matchAll(/http:\/\/[^"\\]*\/media\/(?!d\/)[^"\\]*/g)].map(m => m[0]);
  console.log("\n=== RESULT ===");
  console.log("messages in session:", msgs.length);
  console.log("DURABLE /media/d/ urls found:", durableUrls.length, durableUrls[0] ? `e.g. ${durableUrls[0].slice(0, 90)}` : "");
  console.log("legacy token urls found:", tokenUrls.length);
  console.log(durableUrls.length > 0 ? "PASS — user upload stored DURABLY" : "FAIL — no durable url in stored transcript");
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) {
  console.error("\nprobe error:", e?.message || e);
  ws.close();
  setTimeout(() => process.exit(1), 300);
 }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 90000);
