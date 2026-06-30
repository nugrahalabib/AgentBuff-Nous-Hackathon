import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// Worker liveness (D12 finisher). Read-only — admin AND support may read.
// Each background worker upserts worker_heartbeat once per tick (recordHeartbeat).
// "stale" = hasn't ticked within max(3x its interval, 90s); "missing" = an
// expected worker that has never reported a row (e.g. server.ts failed to boot
// it). Both signal a dead worker even when no error was recorded.
const EXPECTED = [
  "trial-worker",
  "reconcile",
  "skill-retry",
  "renewal-worker",
  "rollup",
];
const STALE_FLOOR_MS = 90_000;

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const rows = await db
      .select()
      .from(schema.workerHeartbeats)
      .orderBy(desc(schema.workerHeartbeats.lastRunAt));

    const now = Date.now();
    const workers = rows.map((w) => {
      const interval = w.intervalMs || 0;
      const staleMs = Math.max(interval * 3, STALE_FLOOR_MS);
      const ageMs = now - new Date(w.lastRunAt).getTime();
      return {
        name: w.name,
        lastRunAt: w.lastRunAt,
        lastOk: w.lastOk,
        lastError: w.lastError,
        intervalMs: interval,
        runs: w.runs,
        fails: w.fails,
        ageMs,
        stale: ageMs > staleMs,
      };
    });

    const seen = new Set(workers.map((w) => w.name));
    const missing = EXPECTED.filter((n) => !seen.has(n));

    return Response.json({ workers, missing });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
