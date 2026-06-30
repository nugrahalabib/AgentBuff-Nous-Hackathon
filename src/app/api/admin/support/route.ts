import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZES = [25, 50, 100] as const;
const PAGE_SIZE = PAGE_SIZES[0];
const MAX_Q = 100;

// Clamp client pageSize to a fixed allowlist — never trust the raw value.
function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number]) ? n : PAGE_SIZE;
}

// Admin support inbox (D16). Read-only — admin AND support may read.
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 16);
    const category = (url.searchParams.get("category") ?? "").trim().slice(0, 16);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

    const conds = [];
    if (q)
      conds.push(
        or(
          ilike(schema.supportTickets.subject, `%${q}%`),
          ilike(schema.supportTickets.ref, `%${q}%`),
        ),
      );
    if (status) conds.push(eq(schema.supportTickets.status, status));
    if (category) conds.push(eq(schema.supportTickets.category, category));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: schema.supportTickets.id,
        ref: schema.supportTickets.ref,
        userId: schema.supportTickets.userId,
        email: schema.users.email,
        category: schema.supportTickets.category,
        subject: schema.supportTickets.subject,
        message: schema.supportTickets.message,
        status: schema.supportTickets.status,
        reply: schema.supportTickets.reply,
        repliedAt: schema.supportTickets.repliedAt,
        repliedBy: schema.supportTickets.repliedBy,
        createdAt: schema.supportTickets.createdAt,
      })
      .from(schema.supportTickets)
      .leftJoin(schema.users, eq(schema.users.id, schema.supportTickets.userId))
      .where(where)
      .orderBy(desc(schema.supportTickets.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.supportTickets)
      .where(where);
    const [openRow] = await db
      .select({ c: count() })
      .from(schema.supportTickets)
      .where(eq(schema.supportTickets.status, "open"));

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
      openCount: openRow?.c ?? 0,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
