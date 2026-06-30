import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZE = 25;
const MAX_Q = 100;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

// Clamp client-supplied pageSize to a fixed allowlist — never trust the client.
function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])
    ? n
    : PAGE_SIZE;
}

// Admin transaction ledger (D2). Read-only — admin AND support may read.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const type = (url.searchParams.get("type") ?? "").trim().slice(0, 20);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

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
        id: schema.transactions.id,
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
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.transactions)
      .where(where);

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
