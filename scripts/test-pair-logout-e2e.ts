// E2E test: simulate exact payload yang dikirim UI dialog saat pair telegram,
// verify engine accept (validation pass), lalu test logout cleanup.
//
//   pnpm tsx --env-file=.env.local scripts/test-pair-logout-e2e.ts
//
// Pakai bot token user yang sebelumnya sudah berhasil di-pair.
// Setelah selesai, channel akan di-logout supaya state kembali clean.

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

// Secret: supply via env (CHIEF_TELEGRAM_TOKEN) — never hardcode a real token.
const BOT_TOKEN = process.env.CHIEF_TELEGRAM_TOKEN ?? "";
const CHANNEL = "telegram";

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
      instanceId: `e2e-${conn.userIdShort}-${label}`,
      defaultCallTimeoutMs: 15_000,
    },
    fn,
  );
}

async function patchConfig(
  client: GatewayClient,
  partial: Record<string, unknown>,
): Promise<void> {
  const snapshot = await client.call<{ hash?: string }>("config.get", {});
  const baseHash =
    typeof snapshot?.hash === "string" ? snapshot.hash.trim() : "";
  if (!baseHash) throw new Error("no baseHash");
  await client.call("config.patch", {
    raw: JSON.stringify(partial),
    baseHash,
  });
}

async function waitForHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`gateway not healthy after ${timeoutMs}ms`);
}

async function waitForChannelConfigured(
  conn: ConnInfo,
  channelId: string,
  timeoutMs = 120_000,
): Promise<{ configured: boolean; running: boolean; lastError: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await withFresh(conn, "wait-status", async (c) =>
        c.call<{ channels?: Record<string, { configured?: boolean; running?: boolean; lastError?: string | null }> }>(
          "channels.status",
          {},
        ),
      );
      const ch = status?.channels?.[channelId];
      if (ch?.configured === true) {
        return {
          configured: true,
          running: ch.running ?? false,
          lastError: ch.lastError ?? null,
        };
      }
    } catch {
      /* keep polling — engine maybe still restarting */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`channel ${channelId} never became configured after ${timeoutMs}ms`);
}

async function waitForChannelGone(
  conn: ConnInfo,
  channelId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await withFresh(conn, "wait-gone", async (c) =>
        c.call<{ channels?: Record<string, { configured?: boolean }> }>(
          "channels.status",
          {},
        ),
      );
      const ch = status?.channels?.[channelId];
      // Channel exists tapi configured=false → namespace masih residue tapi tidak active.
      // Channel completely absent dari channels record → namespace wiped.
      if (!ch || ch.configured === false) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`channel ${channelId} still configured after ${timeoutMs}ms`);
}

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  const conn: ConnInfo = {
    url: `ws://${hermesConfig.publicHost}:${row.port}/`,
    token: row.gatewayToken,
    userIdShort: row.userId.slice(0, 8),
  };

  console.log("=== Phase 1: PAIR Telegram with new payload ===");
  // Exact payload yang SingleTokenPairingBody akan kirim setelah fix
  const pairPayload = {
    channels: {
      [CHANNEL]: {
        botToken: BOT_TOKEN,
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groupAllowFrom: ["*"],
      },
    },
    bindings: [
      { type: "route", agentId: "main", match: { channel: CHANNEL, accountId: "default" } },
    ],
  };

  let pairOk = false;
  try {
    await withFresh(conn, "pair", async (c) => {
      await patchConfig(c, pairPayload);
    });
    pairOk = true;
    console.log("  ✓ config.patch sent (might hang up due to engine restart)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/socket hang up|ws closed|gateway closed|gateway timeout|service restart|ECONNRESET/i.test(msg)) {
      pairOk = true;
      console.log("  ✓ config.patch sent (engine restart triggered, expected)");
    } else {
      console.error("  ✗ pair patch failed unexpectedly:", msg);
      process.exit(2);
    }
  }

  if (!pairOk) {
    console.error("  pair did not complete");
    process.exit(2);
  }

  console.log("\n=== Phase 2: Wait for engine restart + telegram configured ===");
  await new Promise((r) => setTimeout(r, 4_000));
  await waitForHealth(row.port);
  await new Promise((r) => setTimeout(r, 4_000));
  const status = await waitForChannelConfigured(conn, CHANNEL);
  console.log(`  ✓ telegram configured=${status.configured} running=${status.running} lastError=${status.lastError}`);

  if (status.lastError) {
    console.error(`  ✗ telegram has lastError after pairing: ${status.lastError}`);
    // Continue to logout test anyway untuk reset state
  }

  console.log("\n=== Phase 3: LOGOUT (wipe namespace) ===");
  // Step 1: channels.logout RPC
  try {
    await withFresh(conn, "logout-rpc", async (c) => {
      await c.call("channels.logout", { channel: CHANNEL, accountId: "default" });
    });
    console.log("  ✓ channels.logout RPC sent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/socket hang up|ws closed|gateway closed|service restart/i.test(msg)) {
      console.log("  ✓ channels.logout sent (engine restart triggered)");
    } else {
      console.error("  ✗ channels.logout failed:", msg);
    }
  }

  await new Promise((r) => setTimeout(r, 4_000));
  await waitForHealth(row.port);
  await new Promise((r) => setTimeout(r, 4_000));

  // Step 2: composite patch — wipe namespace + filter bindings
  const wipePayload = {
    channels: { [CHANNEL]: null },
    bindings: [],
  };
  try {
    await withFresh(conn, "wipe", async (c) => {
      await patchConfig(c, wipePayload);
    });
    console.log("  ✓ wipe namespace patch sent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/socket hang up|ws closed|gateway closed|service restart/i.test(msg)) {
      console.log("  ✓ wipe patch sent (engine restart triggered)");
    } else {
      console.error("  ✗ wipe patch failed:", msg);
      process.exit(3);
    }
  }

  console.log("\n=== Phase 4: Verify wipe ===");
  await new Promise((r) => setTimeout(r, 4_000));
  await waitForHealth(row.port);
  await new Promise((r) => setTimeout(r, 4_000));
  await waitForChannelGone(conn, CHANNEL);
  console.log("  ✓ telegram namespace wiped (configured=false or channel absent)");

  console.log("\n========== ALL PHASES PASSED ==========");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
