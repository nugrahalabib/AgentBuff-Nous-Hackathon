import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// Daily KPI trend (admin-panel F4 / D11). Read-only — admin AND support may read.
// Reads precomputed daily_rollup rows (populated by the rollup worker) and pivots
// them into a per-metric time series over the requested window. Dimensionless
// metrics only (dimsKey = ""). Each series is aligned to the same day axis.
const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

function utcDayStr(base: Date, daysAgo: number): string {
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const days = Math.max(
      1,
      Math.min(MAX_DAYS, Number(url.searchParams.get("days") ?? "") || DEFAULT_DAYS),
    );
    const now = new Date();
    const dayList: string[] = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(utcDayStr(now, i));

    const rows = await db
      .select({
        day: schema.dailyRollups.day,
        metric: schema.dailyRollups.metric,
        value: schema.dailyRollups.value,
        dimsKey: schema.dailyRollups.dimsKey,
      })
      .from(schema.dailyRollups)
      .where(inArray(schema.dailyRollups.day, dayList));

    const byMetric: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (r.dimsKey !== "") continue;
      (byMetric[r.metric] ??= {})[r.day] = r.value;
    }
    const metrics: Record<string, number[]> = {};
    for (const m of Object.keys(byMetric).sort()) {
      metrics[m] = dayList.map((d) => byMetric[m][d] ?? 0);
    }

    return Response.json({ days: dayList, metrics });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
