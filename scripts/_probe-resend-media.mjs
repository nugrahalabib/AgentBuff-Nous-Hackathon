// Reproduce Chief's exact scenario end-to-end against the LIVE container:
//   1. upload an image,
//   2. ask the agent to RE-SEND it,
//   3. read history back, pull the assistant's emitted media URL,
//   4. curl it -> assert 200 + nonzero bytes + image content-type.
// Run: node scripts/_probe-resend-media.mjs <wsPort> <token> <mediaBase>
//   e.g. node scripts/_probe-resend-media.mjs 18800 <token> http://127.0.0.1:38800
import WebSocket from "ws";

const wsPort = parseInt(process.argv[2] ?? "", 10);
const token = process.argv[3] ?? "";
const mediaBase = process.argv[4] ?? "http://127.0.0.1:38800";
if (!wsPort || !token) { console.error("usage: <wsPort> <token> [mediaBase]"); process.exit(1); }

// A real 5x5 red PNG (valid, decodable — not a degenerate 1x1) so the agent has
// genuine bytes to re-send.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4" +
  "//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";

const SCOPES = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { Origin: `http://127.0.0.1:${wsPort}` } });
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 90000);
  });
}
let finals = 0;
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (m.type === "res") {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.ok ? p.resolve(m.payload ?? null) : p.reject(new Error(m.error?.message || "unk")); }
  } else if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") {
    finals += 1;
  }
});
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));

const KEY = "probe-resend-media";
async function waitFinal(targetCount, ms) {
  let waited = 0;
  while (finals < targetCount && waited < ms) { await new Promise(r => setTimeout(r, 500)); waited += 500; }
}

ws.on("open", async () => {
 try {
  await send("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "agentbuff-probe", version: "1", platform: "node", mode: "backend" },
    role: "operator", scopes: SCOPES, auth: { token },
  });
  console.log("connected; waiting for gateway RPC-ready…");
  for (let i = 0; i < 40; i++) { try { await send("sessions.list", {}); break; } catch { await new Promise(r => setTimeout(r, 3000)); } }

  console.log("step 1: upload image…");
  await send("chat.send", {
    sessionKey: KEY,
    message: "Ini gambar kotak merah. Simpan ya, nanti aku minta kirim ulang.",
    attachments: [{ type: "image", mimeType: "image/png", fileName: "kotak-merah.png", content: PNG_B64 }],
  });
  await waitFinal(1, 70000);

  console.log("step 2: ask the agent to RE-SEND the image…");
  await send("chat.send", { sessionKey: KEY, message: "tolong kirim ulang gambar yang barusan persis." });
  await waitFinal(2, 80000);

  console.log("step 3: read history, extract media URLs…");
  const hist = await send("sessions.get", { sessionKey: KEY, key: KEY }).catch(() => null);
  const raw = JSON.stringify(hist ?? {});
  const durable = [...raw.matchAll(/http:\/\/[^"\\\s]*\/media\/d\/[^"\\\s]*/g)].map(m => m[0]);
  const token_urls = [...raw.matchAll(/http:\/\/[^"\\\s]*\/media\/(?!d\/)[^"\\\s]*/g)].map(m => m[0]);
  const mediaTags = [...raw.matchAll(/MEDIA:[^"\\\s]+/g)].map(m => m[0]);
  console.log("  durable /media/d/ urls:", durable.length, durable[0] ? "e.g. " + durable[0].slice(0, 100) : "");
  console.log("  legacy token urls:", token_urls.length);
  console.log("  MEDIA: tags:", mediaTags.length, mediaTags.slice(0,3));
  const leaks = (raw.match(/\/home\/hermes|image_cache|vision_analyze|NousResearch|nousresearch|hermes-agent|Teknium/gi) || []);
  console.log("  brand/path leak tokens in raw transcript JSON:", leaks.length, [...new Set(leaks)].slice(0,8));

  console.log("\nstep 4: curl the durable url(s) for real bytes…");
  const { execSync } = await import("node:child_process");
  let pass = false;
  for (const u of durable.slice(0, 4)) {
    try {
      const out = execSync(`curl -s -o /dev/null -w "%{http_code} %{size_download} %{content_type}" "${u}"`, { encoding: "utf8" });
      console.log("  ", out, "<-", u.slice(0, 90));
      const [code, size] = out.split(" ");
      if (code === "200" && parseInt(size, 10) > 0) pass = true;
    } catch (e) { console.log("  curl err:", e.message); }
  }
  console.log("\n=== VERDICT ===");
  console.log(pass ? "PASS — resent media serves real bytes (200 + nonzero)" : "INCONCLUSIVE — agent may not have re-emitted a media tag this run");
  ws.close();
  setTimeout(() => process.exit(0), 300);
 } catch (e) {
  console.error("probe error:", e?.message || e);
  ws.close();
  setTimeout(() => process.exit(1), 300);
 }
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.error("[hard timeout]"); process.exit(1); }, 200000);
