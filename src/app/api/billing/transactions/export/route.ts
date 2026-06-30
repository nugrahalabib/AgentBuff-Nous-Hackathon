import { eq, desc } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// Quote every cell AND neutralise spreadsheet formula injection: a value that
// starts with = + - @ (or tab/CR) is treated as a formula by Excel/Sheets, so
// prefix it with a single quote. `description` is user-influenced (bundle/skill
// names), so it must be guarded even though it's already quoted.
function csvCell(value: string | number | null): string {
  const s = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const rl = take(keyFromRequest("tx-export", req, userId), 10, 60_000);
    if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

    const rows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId))
      .orderBy(desc(schema.transactions.createdAt))
      .limit(2000);

    const header = "Date,Type,Description,Amount (Rp),Energy,Status";
    const lines = rows.map((r) => {
      const date = new Date(r.createdAt).toISOString().slice(0, 10);
      return [date, r.type, r.description, r.amountRp, r.energyDelta, r.status]
        .map(csvCell)
        .join(",");
    });

    const csv = [header, ...lines].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=transactions.csv",
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
