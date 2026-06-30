import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZES = [25, 50, 100] as const;
const PAGE_SIZE = PAGE_SIZES[0];

function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number]) ? n : PAGE_SIZE;
}

// Admin subscription list + active-by-tier metrics (D3). Read-only.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);
    const tier = (url.searchParams.get("tier") ?? "").trim().slice(0, 20);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

    const conds = [];
    if (status) conds.push(eq(schema.subscriptions.status, status));
    if (tier) conds.push(eq(schema.subscriptions.tier, tier));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: schema.subscriptions.id,
        email: schema.users.email,
        tier: schema.subscriptions.tier,
        status: schema.subscriptions.status,
        billingCycle: schema.subscriptions.billingCycle,
        priceRp: schema.subscriptions.priceRp,
        startsAt: schema.subscriptions.startsAt,
        expiresAt: schema.subscriptions.expiresAt,
        autoRenew: schema.subscriptions.autoRenew,
        createdAt: schema.subscriptions.createdAt,
      })
      .from(schema.subscriptions)
      .leftJoin(schema.users, eq(schema.users.id, schema.subscriptions.userId))
      .where(where)
      .orderBy(desc(schema.subscriptions.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.subscriptions)
      .where(where);

    const byTier = await db
      .select({ tier: schema.subscriptions.tier, c: count() })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.status, "active"))
      .groupBy(schema.subscriptions.tier);

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
      metrics: { byTier },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
