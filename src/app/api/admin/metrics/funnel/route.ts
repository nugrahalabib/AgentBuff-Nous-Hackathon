import { count, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

async function n(q: Promise<{ c: number }[]>): Promise<number> {
  const [r] = await q;
  return r?.c ?? 0;
}

// Admin acquisition funnel + self-host analytics activity (D11 / F2). Read-only.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const now = Date.now();
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [users, onboarded, trialActive, subscribed, reg7, reg30] =
      await Promise.all([
        n(db.select({ c: count() }).from(schema.users)),
        n(
          db
            .select({ c: count() })
            .from(schema.userProfiles)
            .where(eq(schema.userProfiles.onboarded, true)),
        ),
        n(
          db
            .select({ c: count() })
            .from(schema.userTrials)
            .where(eq(schema.userTrials.status, "active")),
        ),
        n(
          db
            .select({ c: count() })
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.status, "active")),
        ),
        n(
          db
            .select({ c: count() })
            .from(schema.users)
            .where(gte(schema.users.createdAt, d7)),
        ),
        n(
          db
            .select({ c: count() })
            .from(schema.users)
            .where(gte(schema.users.createdAt, d30)),
        ),
      ]);

    const ev7 = await db
      .select({ event: schema.analyticsEvents.event, c: count() })
      .from(schema.analyticsEvents)
      .where(gte(schema.analyticsEvents.ts, d7))
      .groupBy(schema.analyticsEvents.event);
    const ev30 = await db
      .select({ event: schema.analyticsEvents.event, c: count() })
      .from(schema.analyticsEvents)
      .where(gte(schema.analyticsEvents.ts, d30))
      .groupBy(schema.analyticsEvents.event);
    const toMap = (rows: { event: string; c: number }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.event] = r.c;
      return m;
    };

    return Response.json({
      snapshot: { users, onboarded, trialActive, subscribed },
      registrations: { last7d: reg7, last30d: reg30 },
      events: { last7d: toMap(ev7), last30d: toMap(ev30) },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
