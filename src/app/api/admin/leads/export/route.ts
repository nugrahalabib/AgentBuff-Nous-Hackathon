import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog } from "@/lib/security/audit-log";

// D10 — guarded CSV export of early-access leads. Same filters as the list route;
// admin/support gated, rate-limited, capped, formula-injection guarded.
export const dynamic = "force-dynamic";

const MAX_ROWS = 20_000;
const MAX_Q = 100;

function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.leads.export", req, actor.id), 10, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);

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
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        name: schema.earlyAccessLeads.name,
        email: schema.earlyAccessLeads.email,
        whatsapp: schema.earlyAccessLeads.whatsapp,
        tier: schema.earlyAccessLeads.tier,
        source: schema.earlyAccessLeads.source,
        utm: schema.earlyAccessLeads.utm,
        status: schema.earlyAccessLeads.status,
        note: schema.earlyAccessLeads.note,
        createdAt: schema.earlyAccessLeads.createdAt,
      })
      .from(schema.earlyAccessLeads)
      .where(where)
      .orderBy(desc(schema.earlyAccessLeads.createdAt))
      .limit(MAX_ROWS);

    const header = [
      "Created",
      "Name",
      "Email",
      "WhatsApp",
      "Tier",
      "Source",
      "UTM Source",
      "UTM Medium",
      "UTM Campaign",
      "Status",
      "Note",
    ].join(",");
    const lines = rows.map((r) => {
      const utm = (r.utm ?? {}) as Record<string, string>;
      return [
        new Date(r.createdAt).toISOString(),
        r.name,
        r.email,
        r.whatsapp,
        r.tier,
        r.source,
        utm.source ?? "",
        utm.medium ?? "",
        utm.campaign ?? "",
        r.status,
        r.note,
      ]
        .map(csvCell)
        .join(",");
    });
    const csv = [header, ...lines].join("\r\n");

    auditLog({
      event: "admin.lead.update",
      outcome: "ok",
      actor: actor.id,
      details: { op: "csv_export", rows: rows.length },
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads.csv"`,
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
