import { and, eq, isNull, or, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";
import { installSkillForTransaction } from "./skill-installer";

const POLL_INTERVAL_MS = Number.parseInt(
  // Renamed from OPENCLAW_SKILL_RETRY_INTERVAL_MS (2026-06-03 OpenClaw purge).
  process.env.AGENTBUFF_SKILL_RETRY_INTERVAL_MS ?? "",
  10,
);
const DEFAULT_INTERVAL = Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0
  ? POLL_INTERVAL_MS
  : 30_000;

const MAX_BATCH = 8;

async function findPendingInstalls(): Promise<string[]> {
  const rows = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.type, "skill-install"),
        eq(schema.transactions.status, "completed"),
        isNull(schema.transactions.installedAt),
        // Either never scheduled a retry, or it's due.
        or(
          isNull(schema.transactions.nextRetryAt),
          lte(schema.transactions.nextRetryAt, sql`NOW()`),
        ),
      ),
    )
    .limit(MAX_BATCH);
  return rows.map((r) => r.id);
}

export async function sweepOnce(): Promise<number> {
  const ids = await findPendingInstalls();
  if (ids.length === 0) return 0;

  // Sequential processing: opening WS connections per container, and the
  // batch is small (<=8). Keeps WS concurrency bounded.
  let processed = 0;
  for (const id of ids) {
    try {
      await installSkillForTransaction(id);
      processed += 1;
    } catch (e) {
      console.error("[skill-retry] installSkillForTransaction threw:", e);
    }
  }
  return processed;
}

export type SkillRetryWorkerHandle = {
  stop: () => Promise<void>;
};

export function startSkillRetryWorker(): SkillRetryWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepOnce();
      } catch (e) {
        ok = false;
        console.error("[skill-retry] sweep failed:", e);
      } finally {
        recordHeartbeat("skill-retry", ok, { intervalMs: DEFAULT_INTERVAL });
        inFlight = null;
      }
    })();
  }, DEFAULT_INTERVAL);

  console.log(`[skill-retry] started — interval=${DEFAULT_INTERVAL}ms batch=${MAX_BATCH}`);

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      if (inFlight) await inFlight;
    },
  };
}
