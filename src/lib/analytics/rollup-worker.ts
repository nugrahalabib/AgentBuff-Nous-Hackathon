// NOTE: no `import "server-only"` — this worker runs in the plain-Node
// custom-server chain (server.ts), where the server-only shim can't resolve.
// Same constraint as src/lib/analytics/track.ts.
import { and, count, gte, lt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";

// Daily rollup worker (admin-panel F4 / D11). Precomputes per-day KPI counts into
// daily_rollup so the admin dashboard shows trends without scanning raw tables.
// Recomputes a small trailing window each tick (idempotent upsert) so late events
// and same-day accumulation are always reflected.
const INTERVAL_MS = 30 * 60 * 1000; // 30 min
const ROLLUP_WINDOW_DAYS = 3;
const REVENUE_STATUSES = ["completed", "installed"];

// UTC midnight of (today - daysAgo).
function utcDayStart(base: Date, daysAgo: number): Date {
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

async function upsertRollup(
  day: string,
  metric: string,
  value: number,
): Promise<void> {
  await db
    .insert(schema.dailyRollups)
    .values({ day, metric, dimsKey: "", value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        schema.dailyRollups.day,
        schema.dailyRollups.metric,
        schema.dailyRollups.dimsKey,
      ],
      set: { value, updatedAt: new Date() },
    });
}

async function rollupDay(dayStart: Date): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const day = dayStart.toISOString().slice(0, 10);

  // New users that day.
  const [u] = await db
    .select({ c: count() })
    .from(schema.users)
    .where(
      and(
        gte(schema.users.createdAt, dayStart),
        lt(schema.users.createdAt, dayEnd),
      ),
    );
  await upsertRollup(day, "users.new", u?.c ?? 0);

  // Per-event activity (register / onboard_complete / paid / …).
  const evs = await db
    .select({ event: schema.analyticsEvents.event, c: count() })
    .from(schema.analyticsEvents)
    .where(
      and(
        gte(schema.analyticsEvents.ts, dayStart),
        lt(schema.analyticsEvents.ts, dayEnd),
      ),
    )
    .groupBy(schema.analyticsEvents.event);
  for (const e of evs) {
    await upsertRollup(day, `event.${e.event}`, e.c);
  }

  // Settled revenue (Rupiah) that day.
  const [rev] = await db
    .select({
      s: sql<number>`coalesce(sum(${schema.transactions.amountRp}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.status, REVENUE_STATUSES),
        // Book revenue on the day the MONEY ARRIVED (webhook settlement), not the
        // day the order was opened. createdAt is stamped at 'pending'; for async
        // methods (QRIS, bank transfer) settlement lands hours/days later, so
        // bucketing by createdAt mis-dates revenue. NULL paidAt (not yet settled)
        // never matches the range — correct, those rows aren't revenue yet.
        gte(schema.transactions.paidAt, dayStart),
        lt(schema.transactions.paidAt, dayEnd),
      ),
    );
  await upsertRollup(day, "revenue.settled", Number(rev?.s ?? 0));
}

async function sweepRollups(windowDays: number): Promise<void> {
  const now = new Date();
  for (let i = 0; i < windowDays; i++) {
    await rollupDay(utcDayStart(now, i));
  }
}

export type RollupWorkerHandle = { stop: () => Promise<void> };

export function startDailyRollupWorker(): RollupWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const tick = () => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepRollups(ROLLUP_WINDOW_DAYS);
      } catch (e) {
        ok = false;
        console.error("[rollup] sweep failed:", e);
      } finally {
        recordHeartbeat("rollup", ok, { intervalMs: INTERVAL_MS });
        inFlight = null;
      }
    })();
  };

  const interval = setInterval(tick, INTERVAL_MS);
  // Leading run ~2s after boot so the dashboard has fresh rollups immediately,
  // not only after the first 30-min interval elapses.
  const lead = setTimeout(tick, 2000);

  console.log(
    `[rollup] started — interval=${INTERVAL_MS}ms window=${ROLLUP_WINDOW_DAYS}d`,
  );

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      clearTimeout(lead);
      if (inFlight) await inFlight;
    },
  };
}
