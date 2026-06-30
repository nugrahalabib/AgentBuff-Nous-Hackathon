// Diagnostic: dump models.authStatus + model.options for every container so we
// can build the correct provider-slug map for the Agent-tab model-picker filter
// (audit wevhwile6 #2). Run:
//   pnpm tsx --env-file=.env.local scripts/_probe-model-authstatus.ts
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const rows = await db.select().from(schema.userContainers);
  if (rows.length === 0) {
    console.error("no user_container rows");
    process.exit(1);
  }
  for (const row of rows) {
    console.log(
      `\n=== container userId=${row.userId.slice(0, 12)} port=${row.port} status=${row.status} ===`,
    );
    if (row.status !== "running") {
      console.log("  (skip — not running)");
      continue;
    }
    const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
    try {
      await withGateway(
        {
          url,
          token: row.gatewayToken,
          clientId: "agentbuff-model-probe",
          instanceId: `probe-${row.userId.slice(0, 8)}`,
        },
        async (c) => {
          try {
            const auth = (await c.call("models.authStatus", {})) as {
              providers?: Array<{ provider?: string; status?: string; [k: string]: unknown }>;
            };
            console.log("  -- models.authStatus.providers --");
            for (const p of auth.providers ?? []) {
              console.log(`     ${String(p.provider).padEnd(20)} status=${p.status}`);
            }
          } catch (e) {
            console.log(`  authStatus ERR: ${e instanceof Error ? e.message : String(e)}`);
          }
          try {
            const opts = (await c.call("models.list", {})) as {
              providers?: Array<{ slug?: string; name?: string; models?: string[] }>;
            };
            console.log("  -- models.list.providers (slug -> modelCount, sample) --");
            for (const p of opts.providers ?? []) {
              const models = p.models ?? [];
              const sample = models.slice(0, 3).join(", ");
              console.log(
                `     ${String(p.slug).padEnd(20)} ${String(models.length).padStart(3)} models  [${sample}${models.length > 3 ? ", ..." : ""}]`,
              );
            }
          } catch (e) {
            console.log(`  models.list ERR: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    } catch (err) {
      console.log(`  ERR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
