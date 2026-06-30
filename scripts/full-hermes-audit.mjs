#!/usr/bin/env node
/**
 * Full Hermes dashboard audit. For each tab, exercise the FULL surface
 * (list + get-detail + mutation + cleanup) not just the index endpoint.
 * Designed to catch issues that show up in normal operator workflows.
 *
 * Output: per-tab PASS/FAIL summary. Any FAIL line points at the specific
 * endpoint that broke + status code + body excerpt.
 */
import WebSocket from "ws";

const DASHBOARD = "http://127.0.0.1:28800";
const BRIDGE_WS = "ws://127.0.0.1:18800";

let token = "";
const fails = [];
const passes = [];

async function sessionToken() {
  if (token) return token;
  const r = await fetch(`${DASHBOARD}/`);
  const html = await r.text();
  token = html.match(/HERMES_SESSION_TOKEN__="([^"]+)"/)?.[1] ?? "";
  return token;
}

async function api(path, opts = {}) {
  const t = await sessionToken();
  const r = await fetch(`${DASHBOARD}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, ok: r.ok };
}

function check(label, result, assertion) {
  const passed = result.ok && (assertion ? assertion(result.body) : true);
  if (passed) {
    passes.push(label);
    console.log(`  ✅ ${label}`);
  } else {
    let bodyPrev = "";
    try {
      bodyPrev = typeof result.body === "string"
        ? result.body.slice(0, 100)
        : JSON.stringify(result.body).slice(0, 100);
    } catch { bodyPrev = "(unrenderable)"; }
    fails.push(`${label}: [${result.status}] ${bodyPrev}`);
    console.log(`  ❌ ${label} [${result.status}] ${bodyPrev}`);
  }
}

async function tabStatus() {
  console.log("\n### TAB: STATUS ###");
  const r = await api("/api/status");
  check("status returns version", r, b => b.version && typeof b.version === "string");
  check("status returns gateway state", r, b => b.gateway_state);
  check("status shows configured platforms", r, b => b.gateway_platforms && Object.keys(b.gateway_platforms).length > 0);
}

async function tabSessions() {
  console.log("\n### TAB: SESSIONS ###");
  const list = await api("/api/sessions");
  check("list sessions", list, b => Array.isArray(b.sessions));
  if (list.body?.sessions?.length) {
    const sid = list.body.sessions[0].session_id || list.body.sessions[0].id;
    check("get session detail", await api(`/api/sessions/${sid}`), b => b.id || b.session_id);
    check("get session messages", await api(`/api/sessions/${sid}/messages`), b => Array.isArray(b.messages));
    check("search sessions", await api("/api/sessions/search?q=tes"), b => Array.isArray(b.results));
  }
}

async function tabModels() {
  console.log("\n### TAB: MODELS ###");
  check("model info", await api("/api/model/info"), b => b.model);
  check("model info has provider", await api("/api/model/info"), b => typeof b.provider === "string" && b.provider.length > 0);
  check("model options", await api("/api/model/options"), b => Array.isArray(b.providers) && b.providers.length > 0);
  check("model aux", await api("/api/model/auxiliary"), b => b.tasks);
}

async function tabConfig() {
  console.log("\n### TAB: CONFIG ###");
  check("config get", await api("/api/config"), b => b.model && b.agent);
  // `model: ""` is a valid default (no model preset). Just check agent block exists.
  check("config defaults", await api("/api/config/defaults"), b => b.agent);
  // `fields` is a dict {fieldName -> schema}, not an array.
  check("config schema", await api("/api/config/schema"), b => b.fields && typeof b.fields === "object" && Object.keys(b.fields).length > 0);
  check("config raw yaml", await api("/api/config/raw"), b => typeof b.yaml === "string");
}

async function tabEnv() {
  console.log("\n### TAB: KEYS / ENV ###");
  check("env listing", await api("/api/env"), b => b && typeof b === "object" && "GEMINI_API_KEY" in b);
  // Mutation roundtrip — note /api/env listing only surfaces the
  // curated registry of well-known keys (providers + features). Custom
  // keys are stored fine; verified via the /api/env/reveal endpoint.
  const setRes = await api("/api/env", { method: "PUT", body: { key: "HERMES_AUDIT_TMP", value: "audit-value-123" } });
  check("env set", setRes, b => b.ok === true);
  const revealRes = await api("/api/env/reveal", { method: "POST", body: { key: "HERMES_AUDIT_TMP" } });
  check("env set persists (via reveal)", revealRes, b => b.value === "audit-value-123");
  const delRes = await api("/api/env", { method: "DELETE", body: { key: "HERMES_AUDIT_TMP" } });
  check("env delete", delRes, b => b.ok === true);
  // After delete, reveal returns 404 with `{detail: "...not found in .env"}`.
  // That's the correct "key doesn't exist" signal.
  const revealAfter = await api("/api/env/reveal", { method: "POST", body: { key: "HERMES_AUDIT_TMP" } });
  check("env delete persists (reveal 404)", { ok: revealAfter.status === 404, status: revealAfter.status, body: revealAfter.body });
}

async function tabSkills() {
  console.log("\n### TAB: SKILLS ###");
  check("skills list", await api("/api/skills"), b => Array.isArray(b));
  check("toolsets list", await api("/api/tools/toolsets"), b => Array.isArray(b) && b.length > 0);
}

async function tabProfiles() {
  console.log("\n### TAB: PROFILES ###");
  const list = await api("/api/profiles");
  check("profiles list", list, b => Array.isArray(b.profiles));
  check("default profile SOUL", await api("/api/profiles/default/soul"), b => "content" in b);
  // Create + delete cycle
  const create = await api("/api/profiles", { method: "POST", body: { name: "hermes-audit-tmp", copy_from: "default" } });
  check("profile create", create, b => b.ok === true);
  if (create.ok) {
    const soulPut = await api("/api/profiles/hermes-audit-tmp/soul", {
      method: "PUT", body: { content: "# Audit test profile\n\nDelete me." },
    });
    check("profile SOUL.md write", soulPut, b => b.ok === true || b.content !== undefined);
    const del = await api("/api/profiles/hermes-audit-tmp", { method: "DELETE" });
    check("profile delete", del, b => b.ok === true);
  }
}

async function tabCron() {
  console.log("\n### TAB: CRON ###");
  const list = await api("/api/cron/jobs");
  check("cron list", list, b => Array.isArray(b));
  // Create + trigger + delete cycle
  const create = await api("/api/cron/jobs", {
    method: "POST",
    body: { name: "hermes-audit-tmp", prompt: "hi", schedule: "0 0 * * *", enabled: false },
  });
  check("cron create", create, b => b.id);
  if (create.body?.id) {
    const id = create.body.id;
    check("cron get", await api(`/api/cron/jobs/${id}`), b => b.id === id);
    // Pause/resume return the full updated job object (REST convention),
    // not {ok:true}. Verify the enabled flag flipped instead.
    check("cron pause", await api(`/api/cron/jobs/${id}/pause`, { method: "POST" }), b => b.id === id && b.enabled === false);
    check("cron resume", await api(`/api/cron/jobs/${id}/resume`, { method: "POST" }), b => b.id === id);
    check("cron delete", await api(`/api/cron/jobs/${id}`, { method: "DELETE" }), b => b.ok === true);
  }
}

async function tabLogs() {
  console.log("\n### TAB: LOGS ###");
  check("logs default", await api("/api/logs?lines=1"), b => b.file && Array.isArray(b.lines));
  check("logs agent", await api("/api/logs?file=agent&lines=1"), b => Array.isArray(b.lines));
  check("logs gateway", await api("/api/logs?file=gateway&lines=1"), b => Array.isArray(b.lines));
  check("logs errors", await api("/api/logs?file=errors&lines=1"), b => Array.isArray(b.lines));
}

async function tabAnalytics() {
  console.log("\n### TAB: ANALYTICS ###");
  check("analytics usage", await api("/api/analytics/usage"), b => b.daily !== undefined);
  check("analytics models", await api("/api/analytics/models"), b => Array.isArray(b.models));
}

async function tabPlugins() {
  console.log("\n### TAB: PLUGINS ###");
  check("dashboard plugins list", await api("/api/dashboard/plugins"), b => Array.isArray(b));
  check("plugin hub", await api("/api/dashboard/plugins/hub"), b => Array.isArray(b.plugins));
  check("themes", await api("/api/dashboard/themes"), b => Array.isArray(b.themes));
}

async function tabOAuthProviders() {
  console.log("\n### TAB: OAUTH PROVIDERS (for Models picker) ###");
  check("oauth providers", await api("/api/providers/oauth"), b => Array.isArray(b.providers));
}

async function chatWS() {
  console.log("\n### TAB: CHAT (PTY WS) ###");
  // Just verify WS endpoint accepts connection — full TUI tested elsewhere.
  const t = await sessionToken();
  await new Promise((resolve) => {
    const ws = new WebSocket(`${DASHBOARD.replace("http", "ws")}/api/pty?token=${t}&channel=audit-${Date.now()}`);
    let opened = false;
    ws.on("open", () => { opened = true; });
    ws.on("message", () => {
      // PTY emits bytes; arrival = working
      if (!opened) return;
      check("PTY WS opens + streams bytes", { ok: true, status: 200, body: "stream-ok" });
      ws.close(1000);
      resolve(null);
    });
    ws.on("error", () => {
      check("PTY WS opens + streams bytes", { ok: false, status: 500, body: "ws-error" });
      resolve(null);
    });
    setTimeout(() => {
      if (!opened) {
        check("PTY WS opens + streams bytes", { ok: false, status: 408, body: "timeout" });
      }
      ws.close();
      resolve(null);
    }, 8000);
  });
}

async function bridgeChatRoundtrip() {
  console.log("\n### BRIDGE: chat.send roundtrip via /app path ###");
  // Get bridge token from DB
  const { execSync } = await import("node:child_process");
  // Fetch the bridge token directly from postgres via psql-style request
  // through the user_container row. Pass as env var to avoid spawning
  // a separate tsx subprocess (which fails in this WSL/Windows context).
  const bridgeToken = process.env.HERMES_AUDIT_BRIDGE_TOKEN;
  if (!bridgeToken) {
    console.log("  ⏭  bridge chat roundtrip skipped (set HERMES_AUDIT_BRIDGE_TOKEN to enable)");
    return;
  }

  await new Promise((resolve) => {
    const ws = new WebSocket(`${BRIDGE_WS}/`, { headers: { Origin: BRIDGE_WS.replace("ws", "http") } });
    let nid = 1;
    const pending = new Map();
    const send = (method, params = {}) => {
      const id = String(nid++);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return new Promise((r, j) => {
        pending.set(id, { r, j });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            j(new Error("timeout " + method));
          }
        }, 30000);
      });
    };
    ws.on("open", async () => {
      try {
        await send("connect", {
          minProtocol: 3, maxProtocol: 3,
          client: { id: "agentbuff-audit", version: "1", platform: "node", mode: "backend" },
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
          auth: { token: bridgeToken },
        });
        check("bridge connect", { ok: true, status: 200, body: "ok" });
        const ack = await send("chat.send", { sessionKey: "audit", message: "jawab satu kata: tes" });
        check("bridge chat.send ack with sessionKey echo", { ok: true, status: 200, body: ack.sessionKey || "no-echo" }, () => Boolean(ack.sessionKey));
        // Wait up to 60s for state=final — first chat in a fresh agent
        // triggers ~5s of lazy dep install (edge-tts, elevenlabs) + ~5s
        // of agent build + 2-3s of Gemini call. Subsequent chats are
        // sub-5s but the first turn after container provision needs
        // the longer window.
        let sawFinal = false;
        ws.on("message", raw => {
          const m = JSON.parse(raw);
          if (m.type === "event" && m.event === "chat" && m.payload?.state === "final") sawFinal = true;
        });
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && !sawFinal) {
          await new Promise(r => setTimeout(r, 500));
        }
        check("bridge streaming -> chat state=final received", { ok: sawFinal, status: sawFinal ? 200 : 408, body: sawFinal ? "ok" : "no-final-event" });
        ws.close(1000);
        resolve(null);
      } catch (e) {
        check("bridge chat roundtrip", { ok: false, status: 500, body: e.message });
        resolve(null);
      }
    });
    ws.on("message", raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === "res") {
          const p = pending.get(m.id);
          if (p) {
            pending.delete(m.id);
            m.ok ? p.r(m.payload) : p.j(new Error(m.error?.message || "unk"));
          }
        }
      } catch {}
    });
  });
}

async function main() {
  console.log(`=== Hermes Full Audit ${new Date().toISOString()} ===`);

  await tabStatus();
  await tabSessions();
  await tabModels();
  await tabConfig();
  await tabEnv();
  await tabSkills();
  await tabProfiles();
  await tabCron();
  await tabLogs();
  await tabAnalytics();
  await tabPlugins();
  await tabOAuthProviders();
  await chatWS();
  await bridgeChatRoundtrip();

  console.log(`\n=== Summary ===`);
  console.log(`PASS: ${passes.length}`);
  console.log(`FAIL: ${fails.length}`);
  if (fails.length > 0) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("audit crashed:", e);
  process.exit(1);
});
