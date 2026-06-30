import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog } from "@/lib/security/audit-log";

// D2 — guarded CSV export of the admin transaction ledger. Same filters as the
// list route; admin/support gated, rate-limited, capped. Mirrors the user-facing
// export's spreadsheet-formula-injection guard.
export const dynamic = "force-dynamic";

const MAX_ROWS = 10_000;
const MAX_Q = 100;

// Quote every cell AND neutralise spreadsheet formula injection (= + - @ tab cr).
function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.tx.export", req, actor.id), 10, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const type = (url.searchParams.get("type") ?? "").trim().slice(0, 20);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);

    const conds = [];
    if (q)
      conds.push(
        or(
          ilike(schema.transactions.midtransOrderId, `%${q}%`),
          ilike(schema.transactions.description, `%${q}%`),
        ),
      );
    if (type) conds.push(eq(schema.transactions.type, type));
    if (status) conds.push(eq(schema.transactions.status, status));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        email: schema.users.email,
        type: schema.transactions.type,
        description: schema.transactions.description,
        amountRp: schema.transactions.amountRp,
        status: schema.transactions.status,
        paymentMethod: schema.transactions.paymentMethod,
        midtransOrderId: schema.transactions.midtransOrderId,
        paidAt: schema.transactions.paidAt,
        createdAt: schema.transactions.createdAt,
      })
      .from(schema.transactions)
      .leftJoin(schema.users, eq(schema.users.id, schema.transactions.userId))
      .where(where)
      .orderBy(desc(schema.transactions.createdAt))
      .limit(MAX_ROWS);

    const header = [
      "Created",
      "Paid",
      "Email",
      "Type",
      "Description",
      "Amount (Rp)",
      "Status",
      "Payment Method",
      "Order ID",
    ].join(",");
    const lines = rows.map((r) =>
      [
        new Date(r.createdAt).toISOString(),
        r.paidAt ? new Date(r.paidAt).toISOString() : "",
        r.email,
        r.type,
        r.description,
        r.amountRp,
        r.status,
        r.paymentMethod,
        r.midtransOrderId,
      ]
        .map(csvCell)
        .join(","),
    );
    const csv = [header, ...lines].join("\r\n");

    auditLog({
      event: "admin.transaction.reconcile",
      outcome: "ok",
      actor: actor.id,
      details: { op: "csv_export", rows: rows.length },
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="transactions.csv"`,
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
