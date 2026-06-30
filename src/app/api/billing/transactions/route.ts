import {
  eq,
  and,
  or,
  desc,
  gte,
  lte,
  ilike,
  inArray,
  type SQL,
} from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

// Map the UI's coarse status filter to the raw DB statuses. "success" folds
// installed (paid skill) in; "failed" folds refunded in. Keeps the UI to three
// human buckets (Berhasil / Diproses / Gagal) over the engine's finer states.
const STATUS_GROUPS: Record<string, string[]> = {
  // "success" = money received. install_failed belongs here (the payment
  // settled; only the post-payment skill install failed) so a paid row is never
  // hidden from the Berhasil filter — mirrors MONEY_RECEIVED on the client.
  success: ["completed", "installed", "install_failed"],
  pending: ["pending"],
  failed: ["failed", "refunded"],
};

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const { searchParams } = new URL(req.url);
    const period = searchParams.get("period") ?? "all";
    const category = searchParams.get("category");
    const status = searchParams.get("status");
    // Cap the search term so a giant ILIKE pattern can't make Postgres scan-match
    // a multi-megabyte string (owner-scoped, so not a leak — just self-DoS).
    const q = searchParams.get("q")?.trim().slice(0, 200);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const conditions: SQL[] = [eq(schema.transactions.userId, userId)];

    // Custom date range takes precedence over the period presets; both are just
    // ANDed createdAt bounds, all parameterized (no injection surface).
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime()))
        conditions.push(gte(schema.transactions.createdAt, d));
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999); // inclusive end-of-day
        conditions.push(lte(schema.transactions.createdAt, d));
      }
    }
    if (!from && !to && period !== "all") {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      const since = new Date();
      since.setDate(since.getDate() - days);
      conditions.push(gte(schema.transactions.createdAt, since));
    }

    if (category) conditions.push(eq(schema.transactions.type, category));

    if (status && STATUS_GROUPS[status]) {
      conditions.push(inArray(schema.transactions.status, STATUS_GROUPS[status]));
    }

    if (q) {
      const term = `%${q}%`;
      const ors: SQL[] = [
        ilike(schema.transactions.description, term),
        ilike(schema.transactions.midtransOrderId, term),
      ];
      // Numeric query → also match the exact rupiah amount (strip non-digits so
      // "Rp 99.000" / "99000" both work).
      const amount = Number(q.replace(/\D/g, ""));
      if (Number.isFinite(amount) && amount > 0)
        ors.push(eq(schema.transactions.amountRp, amount));
      const orClause = or(...ors);
      if (orClause) conditions.push(orClause);
    }

    const rows = await db
      .select()
      .from(schema.transactions)
      .where(and(...conditions))
      .orderBy(desc(schema.transactions.createdAt))
      // 500 covers realistic lifetime history for an owner-scoped consumer
      // account, so the client-side summary total isn't silently truncated.
      .limit(500);

    return Response.json(rows);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
