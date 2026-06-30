import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const PAGE_SIZE = PAGE_SIZE_OPTIONS[0];
const MAX_Q = 100;
// tier is varchar(30), source is varchar(40) — clamp filter inputs to match.
const MAX_TIER = 30;
const MAX_SOURCE = 40;

// Never trust client pageSize: parse + clamp to the fixed allowlist.
function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number]) ? n : PAGE_SIZE;
}

// Admin early-access leads list + status counts (D10). Read-only.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);
    const tier = (url.searchParams.get("tier") ?? "").trim().slice(0, MAX_TIER);
    const source = (url.searchParams.get("source") ?? "").trim().slice(0, MAX_SOURCE);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

    const conds = [];
    if (q)
      conds.push(
        or(
          ilike(schema.earlyAccessLeads.email, `%${q}%`),
          ilike(schema.earlyAccessLeads.name, `%${q}%`),
          ilike(schema.earlyAccessLeads.whatsapp, `%${q}%`),
        ),
      );
    if (status) conds.push(eq(schema.earlyAccessLeads.status, status));
    if (tier) conds.push(eq(schema.earlyAccessLeads.tier, tier));
    if (source) conds.push(eq(schema.earlyAccessLeads.source, source));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: schema.earlyAccessLeads.id,
        name: schema.earlyAccessLeads.name,
        email: schema.earlyAccessLeads.email,
        whatsapp: schema.earlyAccessLeads.whatsapp,
        note: schema.earlyAccessLeads.note,
        tier: schema.earlyAccessLeads.tier,
        source: schema.earlyAccessLeads.source,
        utm: schema.earlyAccessLeads.utm,
        status: schema.earlyAccessLeads.status,
        createdAt: schema.earlyAccessLeads.createdAt,
      })
      .from(schema.earlyAccessLeads)
      .where(where)
      .orderBy(desc(schema.earlyAccessLeads.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.earlyAccessLeads)
      .where(where);

    const byStatus = await db
      .select({ status: schema.earlyAccessLeads.status, c: count() })
      .from(schema.earlyAccessLeads)
      .groupBy(schema.earlyAccessLeads.status);
    const pick = (s: string) => byStatus.find((r) => r.status === s)?.c ?? 0;

    // Distinct filter values (unfiltered — so the dropdowns always offer every
    // option regardless of the active filter). Both columns are notNull.
    const tierRows = await db
      .selectDistinct({ tier: schema.earlyAccessLeads.tier })
      .from(schema.earlyAccessLeads)
      .orderBy(asc(schema.earlyAccessLeads.tier));
    const sourceRows = await db
      .selectDistinct({ source: schema.earlyAccessLeads.source })
      .from(schema.earlyAccessLeads)
      .orderBy(asc(schema.earlyAccessLeads.source));
    const tiers = tierRows.map((r) => r.tier).filter((v): v is string => Boolean(v));
    const sources = sourceRows.map((r) => r.source).filter((v): v is string => Boolean(v));

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
      counts: {
        new: pick("new"),
        contacted: pick("contacted"),
        converted: pick("converted"),
        archived: pick("archived"),
      },
      filters: { tiers, sources },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
