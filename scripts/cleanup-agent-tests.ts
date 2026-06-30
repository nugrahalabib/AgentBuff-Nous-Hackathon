// Cleanup after browser E2E tests: delete test agents, restore main
// as default, ensure healthcheck skill re-enabled, clear tool override.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("no container");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: "agent-cleanup",
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      // 1. Re-enable healthcheck
      try {
        await client.call("skills.update", {
          skillKey: "healthcheck",
          enabled: true,
        });
        console.log("[OK] healthcheck re-enabled");
      } catch (e) {
        console.log("[WARN] healthcheck:", (e as Error).message);
      }

      // 2. Restore main as default + clear buff-sales tool profile override
      try {
        const cur = (await client.call("config.get", {})) as { hash: string };
        const raw = JSON.stringify({
          agents: {
            list: [
              { id: "main", default: true },
              { id: "buff-sales", default: null, tools: null },
            ],
          },
        });
        await client.call("config.patch", { baseHash: cur.hash, raw });
        console.log("[OK] main set as default, buff-sales tools reset");
      } catch (e) {
        console.log("[WARN] config patch:", (e as Error).message);
      }

      // 3. Delete buff-sales
      try {
        const list = (await client.call("agents.list", {})) as {
          agents: Array<{ id: string }>;
        };
        if (list.agents.some((a) => a.id === "buff-sales")) {
          await client.call("agents.delete", {
            agentId: "buff-sales",
            deleteFiles: true,
          });
          console.log("[OK] buff-sales deleted");
        } else {
          console.log("[OK] buff-sales already gone");
        }
      } catch (e) {
        console.log("[WARN] delete:", (e as Error).message);
      }

      // Final verify
      const finalList = await client.call("agents.list", {});
      console.log("\n--- Final state ---");
      console.log(JSON.stringify(finalList, null, 2));
    },
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
