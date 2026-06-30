// Test bootstrap WhatsApp plugin loading by patching channels.whatsapp.enabled=true.
// Verify engine restarts + plugin becomes loaded + web.login.start works.
//
//   pnpm tsx --env-file=.env.local scripts/test-whatsapp-bootstrap.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

type ConnInfo = { url: string; token: string; userIdShort: string };

async function withFresh<T>(
  conn: ConnInfo,
  label: string,
  fn: (c: GatewayClient) => Promise<T>,
): Promise<T> {
  return withGateway(
    {
      url: conn.url,
      token: conn.token,
      clientId: "openclaw-control-ui",
      instanceId: `bs-${conn.userIdShort}-${label}`,
      defaultCallTimeoutMs: 15_000,
    },
    fn,
  );
}

async function waitHealth(port: number, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`gateway not healthy after ${ms}ms`);
}

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);

  if (!row) {
    console.error("no running container");
    process.exit(1);
  }
  const conn: ConnInfo = {
    url: `ws://${hermesConfig.publicHost}:${row.port}/`,
    token: row.gatewayToken,
    userIdShort: row.userId.slice(0, 8),
  };
  console.log(`[info] target port=${row.port}`);

  // Phase 1: verify web.login.start fails initially.
  console.log(`\n[Phase 1] Check web.login.start status BEFORE bootstrap`);
  try {
    const result = await withFresh(conn, "pre-test", (c) =>
      c.call("web.login.start", { force: false, timeoutMs: 5_000 }),
    );
    console.log(`[Phase 1] web.login.start success (unexpected):`, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Phase 1] web.login.start failed (expected):`, msg);
  }

  // Phase 2: bootstrap channels.whatsapp.enabled
  console.log(`\n[Phase 2] Patch channels.whatsapp = { enabled: true }`);
  try {
    await withFresh(conn, "bootstrap", async (c) => {
      const snapshot = await c.call<{ hash?: string }>("config.get", {});
      const baseHash =
        typeof snapshot?.hash === "string" ? snapshot.hash.trim() : "";
      if (!baseHash) throw new Error("no baseHash");
      await c.call("config.patch", {
        raw: JSON.stringify({ channels: { whatsapp: { enabled: true } } }),
        baseHash,
      });
    });
    console.log(`[Phase 2] patch ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /socket hang up|gateway closed|gateway timeout|ECONNRESET|service restart|shutting down/i.test(
        msg,
      )
    ) {
      console.log(`[Phase 2] patch ok (engine restarting):`, msg);
    } else {
      console.error(`[Phase 2] patch FAILED:`, msg);
      process.exit(1);
    }
  }

  // Phase 3: wait health
  console.log(`\n[Phase 3] Wait engine health (up to 120s)...`);
  await waitHealth(row.port);
  console.log(`[Phase 3] engine healthy`);

  // Phase 4: verify channel registered
  console.log(`\n[Phase 4] Check channels.status — WhatsApp should now appear`);
  // give plugin loader extra second
  await new Promise((r) => setTimeout(r, 3_000));
  const status = await withFresh(conn, "post-status", (c) =>
    c.call<{ channelOrder?: string[] }>("channels.status", {}),
  );
  const order = status?.channelOrder ?? [];
  console.log(`[Phase 4] channelOrder:`, order);
  if (!order.includes("whatsapp")) {
    console.error(`[FAIL] Phase 4: whatsapp not in channelOrder!`);
    process.exit(1);
  }
  console.log(`[ok] Phase 4 — WhatsApp plugin loaded`);

  // Phase 5: now web.login.start should succeed
  console.log(`\n[Phase 5] Retry web.login.start — should return QR now`);
  try {
    const qr = await withFresh(conn, "qr", (c) =>
      c.call<{ qrDataUrl?: string; message?: string }>("web.login.start", {
        force: false,
        timeoutMs: 30_000,
      }),
    );
    if (qr?.qrDataUrl) {
      console.log(
        `[ok] Phase 5 — QR received! length=${qr.qrDataUrl.length} bytes`,
      );
    } else {
      console.error(`[FAIL] Phase 5 — no qrDataUrl:`, qr);
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FAIL] Phase 5 — web.login.start error:`, msg);
    process.exit(1);
  }

  console.log(`\n=== BOOTSTRAP WORKS — WhatsApp plugin activates via config patch ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
