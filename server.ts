import { createServer, type IncomingMessage } from "node:http";
import { parse } from "node:url";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const envFile of [".env.local", ".env"]) {
  try {
    const txt = readFileSync(resolve(process.cwd(), envFile), "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

import next from "next";
import { handleHermesUpgrade } from "@/lib/hermes/ws-proxy";
import { startHermesUsagePoller } from "@/lib/hermes/usage-poller";
import { startSkillRetryWorker } from "@/lib/billing/skill-retry-worker";
import { startTrialLifecycleWorker } from "@/lib/billing/trial-lifecycle-worker";
import { startReconcileWorker } from "@/lib/billing/reconcile-worker";
import { startRenewalReminderWorker } from "@/lib/billing/renewal-reminder-worker";
import { startDailyRollupWorker } from "@/lib/analytics/rollup-worker";
import { startAccountDeletionWorker } from "@/lib/billing/account-deletion-worker";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME ?? "localhost";
const port = parseInt(process.env.PORT ?? "617", 10);

const server = createServer((req, res) => {
  // Dev-only: bounce loopback IP hosts (127.0.0.1, ::1, 0.0.0.0) to the
  // canonical "localhost" so NextAuth cookies actually stick. Root cause:
  // Next 16's custom-server mode hardcodes the request URL to
  // `http://<hostname>:<port>/...` based on the `hostname` option passed to
  // `next({...})` (see node_modules/next/dist/server/next-server.js:1266),
  // ignoring the real Host header. NextAuth uses that URL to compute
  // `Set-Cookie` origin + the `authjs.callback-url` value. Cookies are
  // host-only (HttpOnly, no Domain) so a cookie set at `localhost` does NOT
  // travel with requests to `127.0.0.1` — CSRF check fails → login loops.
  //
  // Production is unaffected: `AUTH_URL=https://agentbuff.id` in the VPS env
  // makes next-auth's `reqWithEnvURL` (node_modules/next-auth/lib/env.js:5-12)
  // rewrite the origin to AUTH_URL regardless of the Host header, and this
  // `dev` branch never fires.
  if (dev && req.headers.host) {
    let hostname: string | null = null;
    try {
      hostname = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      // Malformed Host header — fall through to Next; Node would have
      // already 400'd anything truly weird at parse time.
    }
    if (
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      res.writeHead(307, {
        Location: `http://localhost:${port}${req.url ?? "/"}`,
      });
      res.end();
      return;
    }
  }
  // Stamp the real TCP peer IP so downstream rate-limit + audit logging can't
  // be spoofed via a client-supplied X-Forwarded-For. Direct-server deployment
  // (no reverse proxy yet): the socket address IS the client, so we overwrite
  // x-real-ip with it and strip the spoofable forwarded header. When a prod
  // reverse proxy is added, set TRUST_PROXY=true and configure the proxy to set
  // X-Real-IP from the real client ($remote_addr) — then this stamp is skipped
  // and the proxy's trusted header is used instead.
  if (process.env.TRUST_PROXY !== "true") {
    req.headers["x-real-ip"] = req.socket.remoteAddress ?? "";
    delete req.headers["x-forwarded-for"];
  }
  const parsedUrl = parse(req.url ?? "", true);
  handle(req, res, parsedUrl);
});

// Pass httpServer so Next's internal upgrade handler (Turbopack HMR in dev)
// registers on our server. Without it, HMR stays disconnected in dev and
// React never hydrates client components, freezing all animations.
const app = next({ dev, hostname, port, httpServer: server });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const { pathname } = parse(req.url ?? "", false);
      // Single WebSocket upgrade path: portal browser → Hermes bridge.
      // OpenClaw WS proxy removed during full decommission (2026-05-21).
      // Other upgrades (Turbopack HMR, Next dev overlay) fall through to
      // the upgrade listener Next registers via httpServer.
      if (pathname === "/api/ws/hermes") {
        handleHermesUpgrade(req, socket, head).catch((err) => {
          console.error("[ws-proxy/hermes] upgrade failed:", err);
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        });
        return;
      }
    },
  );

  const hermesUsagePoller = startHermesUsagePoller();
  const skillRetryWorker = startSkillRetryWorker();
  const trialWorker = startTrialLifecycleWorker();
  const reconcileWorker = startReconcileWorker();
  const renewalWorker = startRenewalReminderWorker();
  const rollupWorker = startDailyRollupWorker();
  const deletionWorker = startAccountDeletionWorker();

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received — draining workers...`);
    await Promise.allSettled([
      hermesUsagePoller.stop(),
      skillRetryWorker.stop(),
      trialWorker.stop(),
      reconcileWorker.stop(),
      renewalWorker.stop(),
      rollupWorker.stop(),
      deletionWorker.stop(),
    ]);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  server.listen(port, () => {
    console.log(
      `> Ready on http://${hostname}:${port} (${dev ? "dev" : "prod"})`,
    );
  });
});
