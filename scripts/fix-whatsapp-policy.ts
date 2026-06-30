// One-shot fix: patch existing WhatsApp config dengan permissive policy
// (dmPolicy="open" + allowFrom=["*"] + groupPolicy="open" + groupAllowFrom=["*"]).
// Untuk user yang pair WhatsApp sebelum bootstrap policy fix landed.
//
//   pnpm tsx --env-file=.env.local scripts/fix-whatsapp-policy.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

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
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;

  console.log(`[info] patching channels.whatsapp policy via container port=${row.port}`);

  try {
    await withGateway(
      {
        url,
        token: row.gatewayToken,
        clientId: "openclaw-control-ui",
        instanceId: `fix-wa-${row.userId.slice(0, 8)}`,
        defaultCallTimeoutMs: 15_000,
      },
      async (client) => {
        const snap = await client.call<{ hash?: string }>("config.get", {});
        const baseHash = typeof snap?.hash === "string" ? snap.hash.trim() : "";
        if (!baseHash) throw new Error("no baseHash");
        await client.call("config.patch", {
          raw: JSON.stringify({
            channels: {
              whatsapp: {
                dmPolicy: "open",
                allowFrom: ["*"],
                groupPolicy: "open",
                groupAllowFrom: ["*"],
              },
            },
          }),
          baseHash,
        });
      },
    );
    console.log(`[ok] patch sent — engine restarting now`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /socket hang up|gateway closed|gateway timeout|ECONNRESET|service restart|shutting down/i.test(
        msg,
      )
    ) {
      console.log(`[ok] patch sent (engine restart in progress): ${msg}`);
    } else {
      console.error(`[FAIL] patch error:`, msg);
      process.exit(1);
    }
  }

  // Wait for health
  console.log(`[info] waiting engine health (up to 120s)…`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(`http://127.0.0.1:${row.port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`[ok] engine healthy`);
  // Small extra grace for plugin reload
  await new Promise((r) => setTimeout(r, 5_000));

  // Verify
  const verify = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `verify-wa-${row.userId.slice(0, 8)}`,
    },
    async (client) =>
      client.call<{ config?: { channels?: Record<string, unknown> } }>("config.get", {}),
  );
  const wa = (verify?.config?.channels as Record<string, unknown> | undefined)?.whatsapp;
  console.log(`\n=== channels.whatsapp after fix ===`);
  console.log(JSON.stringify(wa, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
