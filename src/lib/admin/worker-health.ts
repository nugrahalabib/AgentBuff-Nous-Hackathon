// NOTE: no `import "server-only"` here. recordHeartbeat is called from the
// plain-Node custom-server worker chain (server.ts -> billing workers), where the
// `server-only` shim cannot resolve (it only exists under Next's react-server
// bundler condition). Same constraint as src/lib/analytics/track.ts. This module
// is server-side by construction — it imports the postgres-backed `db`.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workerHeartbeats } from "@/lib/db/schema";

const MAX_ERR = 500;

/**
 * Worker liveness upsert (admin-panel D12). One row per background worker, keyed
 * by name. Call once per tick with the tick outcome. Fire-and-forget + fail-safe:
 * a heartbeat write must NEVER break the worker tick that calls it.
 */
export function recordHeartbeat(
  name: string,
  ok: boolean,
  opts: { intervalMs?: number; error?: unknown } = {},
): void {
  const errText = ok
    ? null
    : (opts.error instanceof Error
        ? opts.error.message
        : String(opts.error ?? "")
      ).slice(0, MAX_ERR);
  const interval = opts.intervalMs ?? 0;
  const now = new Date();
  void db
    .insert(workerHeartbeats)
    .values({
      name,
      lastRunAt: now,
      lastOk: ok,
      lastError: errText,
      intervalMs: interval,
      runs: 1,
      fails: ok ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.name,
      set: {
        lastRunAt: now,
        lastOk: ok,
        lastError: errText,
        intervalMs: interval,
        runs: sql`${workerHeartbeats.runs} + 1`,
        fails: sql`${workerHeartbeats.fails} + ${ok ? 0 : 1}`,
        updatedAt: now,
      },
    })
    .catch(() => {
      /* best-effort: heartbeat must never break a worker tick */
    });
}
