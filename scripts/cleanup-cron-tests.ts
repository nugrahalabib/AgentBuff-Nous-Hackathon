// Cleanup after browser E2E tests: remove E2E Wizard Job, restore original
// "Test cron job" so user state matches pre-test.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

type CronJob = {
  id: string;
  name: string;
};

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("no running container");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `cron-cleanup-${row.userId.slice(0, 8)}`,
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      // Find E2E test jobs and remove them
      const list = (await client.call("cron.list", {
        enabled: "all",
        limit: 100,
      })) as { jobs: CronJob[] };
      for (const job of list.jobs) {
        if (job.name.startsWith("E2E ")) {
          await client.call("cron.remove", { id: job.id });
          console.log(`[OK] removed ${job.name} (${job.id})`);
        }
      }

      // Restore original "Test cron job" if not present
      const hasOriginal = list.jobs.some((j) => j.name === "Test cron job");
      if (!hasOriginal) {
        const created = (await client.call("cron.add", {
          name: "Test cron job",
          enabled: true,
          schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Jakarta" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Test cron job" },
          delivery: { mode: "announce", channel: "last" },
        })) as CronJob;
        console.log(`[OK] restored "Test cron job" (${created.id})`);
      } else {
        console.log("[OK] 'Test cron job' already present, no restore needed");
      }
    },
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
