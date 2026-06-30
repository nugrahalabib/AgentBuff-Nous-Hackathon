import { and, count, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DISTINCT_EVENT_CAP = 200;
const CSV_MAX_ROWS = 5000;

// Clamp a client-supplied pageSize to the allowlist. Never trust the client.
function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : PAGE_SIZE;
}

// Parse a YYYY-MM-DD (or datetime-local) string into an inclusive day bound.
// `end=true` snaps to end-of-day so `to` is inclusive of the whole day.
// Returns undefined for empty/NaN so the filter is skipped.
function parseDateBound(raw: string | null, end: boolean): Date | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  // Date-only input (no time component) → treat as whole-day inclusive bound.
  if (!s.includes("T") && !s.includes(":")) {
    if (end) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
  }
  return d;
}

// Quote every cell AND neutralise spreadsheet formula injection (= + - @ tab cr).
function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

// Admin audit-log viewer (D12). Read-only — admin AND support may read.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const event = (url.searchParams.get("event") ?? "").trim().slice(0, 60);
    const outcome = (url.searchParams.get("outcome") ?? "").trim().slice(0, 10);
    const from = parseDateBound(url.searchParams.get("from"), false);
    const to = parseDateBound(url.searchParams.get("to"), true);
    const format = (url.searchParams.get("format") ?? "").trim().toLowerCase();

    // Shared WHERE for list + count + CSV (drizzle parameterized — no concat).
    const conds = [];
    if (event) conds.push(ilike(schema.auditLogs.event, `%${event}%`));
    if (outcome) conds.push(eq(schema.auditLogs.outcome, outcome));
    if (from) conds.push(gte(schema.auditLogs.ts, from));
    if (to) conds.push(lte(schema.auditLogs.ts, to));
    const where = conds.length ? and(...conds) : undefined;

    if (format === "csv") {
      // Guard the export separately — it can return up to CSV_MAX_ROWS.
      const rl = take(keyFromRequest("admin.audit.export", req, actor.id), 10, 60_000);
      if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

      const csvRows = await db
        .select({
          ts: schema.auditLogs.ts,
          event: schema.auditLogs.event,
          outcome: schema.auditLogs.outcome,
          actorHash: schema.auditLogs.actorHash,
          targetHash: schema.auditLogs.targetHash,
          ip: schema.auditLogs.ip,
        })
        .from(schema.auditLogs)
        .where(where)
        .orderBy(desc(schema.auditLogs.ts))
        .limit(CSV_MAX_ROWS);

      const header = ["ts", "event", "outcome", "actorHash", "targetHash", "ip"].join(",");
      const lines = csvRows.map((r) =>
        [
          new Date(r.ts).toISOString(),
          r.event,
          r.outcome,
          r.actorHash,
          r.targetHash,
          r.ip,
        ]
          .map(csvCell)
          .join(","),
      );
      const csv = [header, ...lines].join("\r\n");

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-log.csv"`,
        },
      });
    }

    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const offset = (page - 1) * pageSize;

    const rows = await db
      .select({
        id: schema.auditLogs.id,
        ts: schema.auditLogs.ts,
        event: schema.auditLogs.event,
        outcome: schema.auditLogs.outcome,
        actorHash: schema.auditLogs.actorHash,
        targetHash: schema.auditLogs.targetHash,
        ip: schema.auditLogs.ip,
        details: schema.auditLogs.details,
      })
      .from(schema.auditLogs)
      .where(where)
      .orderBy(desc(schema.auditLogs.ts))
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.auditLogs)
      .where(where);

    // Distinct event list for the filter combobox (whole table, not filtered).
    const eventRows = await db
      .selectDistinct({ event: schema.auditLogs.event })
      .from(schema.auditLogs)
      .orderBy(sql`${schema.auditLogs.event} asc`)
      .limit(DISTINCT_EVENT_CAP);
    const events = eventRows.map((e) => e.event);

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
      events,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
