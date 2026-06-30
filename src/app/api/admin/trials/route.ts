import { count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZE = 25;

// Admin trial list + lifecycle metrics + anti-farm ledger size (D3). Read-only.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const where = status ? eq(schema.userTrials.status, status) : undefined;

    const rows = await db
      .select({
        userId: schema.userTrials.userId,
        email: schema.users.email,
        status: schema.userTrials.status,
        startedAt: schema.userTrials.startedAt,
        endsAt: schema.userTrials.endsAt,
        convertedAt: schema.userTrials.convertedAt,
      })
      .from(schema.userTrials)
      .leftJoin(schema.users, eq(schema.users.id, schema.userTrials.userId))
      .where(where)
      .orderBy(desc(schema.userTrials.startedAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.userTrials)
      .where(where);

    const byStatus = await db
      .select({ status: schema.userTrials.status, c: count() })
      .from(schema.userTrials)
      .groupBy(schema.userTrials.status);
    const pick = (s: string) => byStatus.find((r) => r.status === s)?.c ?? 0;

    const [grants] = await db.select({ c: count() }).from(schema.trialGrants);

    return Response.json({
      rows,
      page,
      pageSize: PAGE_SIZE,
      total: totalRow?.total ?? 0,
      metrics: {
        active: pick("active"),
        converted: pick("converted"),
        expired: pick("expired"),
        grantsTotal: grants?.c ?? 0,
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
