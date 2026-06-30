import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// D2 — subscription expiry calendar. Buckets active subscriptions by days-until-
// expiry so an operator can plan renewal outreach. Read-only (admin/support).
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const SOONEST_LIMIT = 25;

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const rows = await db
      .select({
        email: schema.users.email,
        tier: schema.subscriptions.tier,
        billingCycle: schema.subscriptions.billingCycle,
        expiresAt: schema.subscriptions.expiresAt,
      })
      .from(schema.subscriptions)
      .leftJoin(schema.users, eq(schema.users.id, schema.subscriptions.userId))
      .where(eq(schema.subscriptions.status, "active"));

    const now = Date.now();
    const buckets = { overdue: 0, today: 0, in7: 0, in30: 0, later: 0 };
    const withDays = rows.map((r) => {
      const days = Math.floor((new Date(r.expiresAt).getTime() - now) / DAY_MS);
      if (days < 0) buckets.overdue += 1;
      else if (days === 0) buckets.today += 1;
      else if (days <= 7) buckets.in7 += 1;
      else if (days <= 30) buckets.in30 += 1;
      else buckets.later += 1;
      return {
        email: r.email,
        tier: r.tier,
        billingCycle: r.billingCycle,
        expiresAt: r.expiresAt,
        days,
      };
    });

    const soonest = withDays
      .sort((a, b) => a.days - b.days)
      .slice(0, SOONEST_LIMIT);

    return Response.json({ total: rows.length, buckets, soonest });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
