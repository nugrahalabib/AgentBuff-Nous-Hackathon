// Comprehensive E2E test of cron.* RPCs against the running container.
// Verifies UI's action paths (add/update/run/remove/runs) hit engine correctly.
//   pnpm tsx --env-file=.env.local scripts/test-cron-e2e.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

type CronJob = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string; expr?: string; tz?: string; everyMs?: number; at?: string };
  payload: { kind: string; message?: string; text?: string };
  delivery?: { mode: string; channel?: string };
  sessionTarget?: string;
  wakeMode?: string;
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    runningAtMs?: number;
  };
};

const PASS = "[OK]";
const FAIL = "[FAIL]";
const INFO = "[..]";

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
      instanceId: `cron-e2e-${row.userId.slice(0, 8)}`,
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      let pass = 0;
      let fail = 0;
      const log = (ok: boolean, label: string, extra?: string) => {
        if (ok) pass++;
        else fail++;
        console.log(
          `${ok ? PASS : FAIL} ${label}${extra ? "  " + extra : ""}`,
        );
      };

      // ── 1. cron.list initial ──────────────────────────────────
      console.log(`${INFO} 1. cron.list (initial)`);
      const initial = (await client.call("cron.list", {
        enabled: "all",
        limit: 100,
      })) as { jobs: CronJob[] };
      log(Array.isArray(initial.jobs), "list returns jobs[]");

      // ── 2. cron.add: create a fresh test job ────────────────────
      console.log(`\n${INFO} 2. cron.add (create E2E test job)`);
      const addRes = (await client.call("cron.add", {
        name: "E2E Test Job",
        description: "Auto-created by test-cron-e2e.ts",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Jakarta" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Test prompt e2e" },
        delivery: { mode: "none" },
      })) as CronJob;
      log(!!addRes.id, "cron.add returns job with id", `id=${addRes.id}`);
      const jobId = addRes.id;
      log(addRes.name === "E2E Test Job", "name persisted");
      log(addRes.enabled === true, "enabled=true persisted");
      log(
        addRes.schedule.kind === "cron" && addRes.schedule.expr === "0 9 * * *",
        "schedule cron expr persisted",
      );
      log(addRes.schedule.tz === "Asia/Jakarta", "schedule tz persisted");

      // ── 3. cron.update: change schedule (Hari kerja preset → "0 9 * * 1-5") ──
      console.log(`\n${INFO} 3. cron.update (change schedule daily → weekdays)`);
      const updateRes = (await client.call("cron.update", {
        id: jobId,
        patch: {
          schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Jakarta" },
        },
      })) as CronJob;
      log(
        updateRes.schedule.expr === "0 9 * * 1-5",
        "schedule updated to weekdays expr",
      );
      log(
        updateRes.schedule.tz === "Asia/Jakarta",
        "tz still Asia/Jakarta after update",
      );

      // ── 4. cron.update: pause (enabled: false) ───────────────────
      console.log(`\n${INFO} 4. cron.update (toggle pause)`);
      const pauseRes = (await client.call("cron.update", {
        id: jobId,
        patch: { enabled: false },
      })) as CronJob;
      log(pauseRes.enabled === false, "enabled toggled to false");
      log(
        pauseRes.schedule.expr === "0 9 * * 1-5",
        "schedule preserved after toggle",
      );

      // ── 5. cron.update: resume (enabled: true) ───────────────────
      console.log(`\n${INFO} 5. cron.update (toggle resume)`);
      const resumeRes = (await client.call("cron.update", {
        id: jobId,
        patch: { enabled: true },
      })) as CronJob;
      log(resumeRes.enabled === true, "enabled toggled to true");

      // ── 6. cron.update: change payload + delivery ────────────────
      console.log(`\n${INFO} 6. cron.update (change payload + delivery)`);
      const compositeRes = (await client.call("cron.update", {
        id: jobId,
        patch: {
          payload: { kind: "agentTurn", message: "Updated prompt e2e" },
          delivery: { mode: "announce", channel: "last" },
        },
      })) as CronJob;
      log(
        compositeRes.payload.message === "Updated prompt e2e",
        "payload message updated",
      );
      log(
        compositeRes.delivery?.mode === "announce",
        "delivery mode changed to announce",
      );
      log(compositeRes.delivery?.channel === "last", "delivery channel set");

      // ── 7. cron.run with mode=force ──────────────────────────────
      console.log(`\n${INFO} 7. cron.run (force trigger)`);
      const runRes = (await client.call("cron.run", {
        id: jobId,
        mode: "force",
      })) as { ok: boolean; ran: boolean; reason?: string };
      log(runRes.ok === true, "cron.run returned ok=true", JSON.stringify(runRes));

      // Wait briefly for run to register, then check lastRunAtMs
      await new Promise((r) => setTimeout(r, 1500));
      const afterRun = (await client.call("cron.list", {
        enabled: "all",
        limit: 100,
      })) as { jobs: CronJob[] };
      const updatedJob = afterRun.jobs.find((j) => j.id === jobId);
      log(
        !!updatedJob?.state?.lastRunAtMs || !!updatedJob?.state?.runningAtMs,
        "lastRunAtMs OR runningAtMs is set after run",
      );

      // ── 8. cron.runs (history) ───────────────────────────────────
      console.log(`\n${INFO} 8. cron.runs (history list)`);
      const runs = (await client.call("cron.runs", {
        scope: "job",
        id: jobId,
        limit: 10,
        sortDir: "desc",
      })) as { entries: Array<{ jobId: string; ts: number }> };
      log(Array.isArray(runs.entries), "runs returns entries array");
      log(
        runs.entries.every((e) => e.jobId === jobId),
        "all entries match jobId filter",
      );

      // ── 9. cron.list with status filter ─────────────────────────
      console.log(`\n${INFO} 9. cron.list filter by enabled=enabled`);
      const enabledOnly = (await client.call("cron.list", {
        enabled: "enabled",
        limit: 100,
      })) as { jobs: CronJob[] };
      log(
        enabledOnly.jobs.every((j) => j.enabled === true),
        "filter enabled=enabled returns only enabled jobs",
      );

      // ── 10. cron.remove ─────────────────────────────────────────
      console.log(`\n${INFO} 10. cron.remove (cleanup test job)`);
      const removeRes = (await client.call("cron.remove", {
        id: jobId,
      })) as { removed: boolean };
      log(removeRes.removed === true, "cron.remove returns removed=true");

      // Verify removed
      const afterRemove = (await client.call("cron.list", {
        enabled: "all",
        limit: 100,
      })) as { jobs: CronJob[] };
      const stillExists = afterRemove.jobs.some((j) => j.id === jobId);
      log(!stillExists, "job no longer in cron.list after remove");

      // ── 11. cron.status (overview) ──────────────────────────────
      console.log(`\n${INFO} 11. cron.status (overview)`);
      const status = (await client.call("cron.status", {})) as {
        enabled: boolean;
        jobs: number;
      };
      log(typeof status.jobs === "number", "cron.status returns jobs count");

      // ── Summary ──────────────────────────────────────────────
      console.log("\n" + "=".repeat(60));
      console.log(`E2E TEST SUMMARY: ${pass} passed, ${fail} failed`);
      console.log("=".repeat(60));
      if (fail > 0) {
        process.exit(1);
      }
    },
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
