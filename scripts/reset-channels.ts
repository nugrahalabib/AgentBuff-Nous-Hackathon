// Reset channel config ke clean state — patch enabled=false + clear tokens
// supaya user dapat baseline bersih untuk real testing.
//
// Run:  pnpm tsx --env-file=.env.local scripts/reset-channels.ts

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

const RESET_PATCHES: Record<string, Record<string, unknown>> = {
  telegram: { botToken: "", enabled: false },
  discord: { token: "", enabled: false },
  slack: { botToken: "", appToken: "", signingSecret: "", enabled: false },
};

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
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;

  // Get current state to see what needs cleaning.
  console.log("checking current state…");
  await waitForHealth(row.port);
  let toReset: string[] = [];
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `reset-${row.userId.slice(0, 8)}`,
      defaultCallTimeoutMs: 15_000,
    },
    async (client) => {
      const status = await client.call<{
        channels: Record<string, { configured?: boolean }>;
      }>("channels.status", {});
      for (const id of Object.keys(RESET_PATCHES)) {
        if (status.channels?.[id]?.configured === true) {
          toReset.push(id);
        }
      }
    },
  );

  if (toReset.length === 0) {
    console.log("clean state already — nothing to reset.");
    process.exit(0);
  }

  console.log("channels to reset:", toReset);

  // Reset each one. Engine restarts after each patch — wait between iterations.
  for (const channelId of toReset) {
    console.log(`\n→ resetting ${channelId}…`);
    try {
      await withGateway(
        {
          url,
          token: row.gatewayToken,
          clientId: "openclaw-control-ui",
          instanceId: `reset-${row.userId.slice(0, 8)}-${channelId}`,
          defaultCallTimeoutMs: 15_000,
        },
        async (client) => {
          await patchConfig(client, {
            channels: { [channelId]: RESET_PATCHES[channelId] },
          });
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Expected: socket hang up because of restart.
      if (
        !/socket hang up|service restart|gateway closed|gateway timeout|gateway connect timeout|ws closed|econnreset/i.test(
          msg,
        )
      ) {
        console.error(`  ${channelId} patch error:`, msg);
        continue;
      }
    }
    console.log(`  waiting for engine restart…`);
    // Initial sleep so engine has chance to die before we poll for it
    // coming back. Without this we'd likely see a phantom "still healthy"
    // before restart kicks in.
    await new Promise((r) => setTimeout(r, 6_000));
    await waitForHealth(row.port);
    // Plugin warmup grace — engine may serve healthz before plugins finish
    // loading + WS connect endpoint accepts new sessions.
    await new Promise((r) => setTimeout(r, 8_000));
    console.log(`  ${channelId} reset OK`);
  }

  // Verify clean.
  console.log("\nverifying clean state…");
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `reset-verify-${row.userId.slice(0, 8)}`,
    },
    async (client) => {
      const status = await client.call<{
        channels: Record<string, { configured?: boolean }>;
      }>("channels.status", {});
      for (const id of Object.keys(RESET_PATCHES)) {
        const c = status.channels?.[id];
        console.log(`  ${id}.configured = ${c?.configured}`);
      }
    },
  );

  console.log("\ndone");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
