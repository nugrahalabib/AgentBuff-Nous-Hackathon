import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// D2 — subscription retention cohorts. Groups subscriptions by their start month
// and reports how many are still active = a simple retention proxy. Read-only.
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const rows = await db
      .select({
        startsAt: schema.subscriptions.startsAt,
        status: schema.subscriptions.status,
      })
      .from(schema.subscriptions);

    const byMonth = new Map<string, { total: number; active: number }>();
    for (const r of rows) {
      const d = new Date(r.startsAt);
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const bucket = byMonth.get(month) ?? { total: 0, active: 0 };
      bucket.total += 1;
      if (r.status === "active") bucket.active += 1;
      byMonth.set(month, bucket);
    }

    const cohorts = [...byMonth.entries()]
      .map(([month, b]) => ({
        month,
        total: b.total,
        active: b.active,
        retentionPct: b.total > 0 ? Math.round((b.active / b.total) * 100) : 0,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));

    return Response.json({ cohorts });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
