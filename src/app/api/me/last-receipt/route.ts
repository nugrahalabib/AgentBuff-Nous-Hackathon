import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const dynamic = "force-dynamic";

// Returns the current user's most recent purchase of a skill (by slug) so the
// in-chat receipt card can show reliable date/ref + a working "struk lengkap"
// link — WITHOUT depending on the agent pasting those fields verbatim (Nemotron
// trims long JSON blocks). Source of truth = the transaction row.
export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ found: false }, { status: 401 });

  // slug is OPTIONAL — if the agent trimmed it from the block, fall back to the
  // user's most recent skill purchase (which is the one just made). Source of
  // truth is the DB, never the agent-pasted block.
  const slug = new URL(request.url).searchParams.get("slug");

  const where = slug
    ? and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.sku, slug),
        eq(schema.transactions.type, "skill-install"),
      )
    : and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.type, "skill-install"),
      );

  const [tx] = await db
    .select({
      orderId: schema.transactions.midtransOrderId,
      paidAt: schema.transactions.paidAt,
      paymentRef: schema.transactions.paymentRef,
      amountRp: schema.transactions.amountRp,
      name: schema.transactions.description,
    })
    .from(schema.transactions)
    .where(where)
    .orderBy(desc(schema.transactions.paidAt))
    .limit(1);

  if (!tx) return NextResponse.json({ found: false });
  return NextResponse.json({
    found: true,
    orderId: tx.orderId,
    paidAt: tx.paidAt,
    paymentRef: tx.paymentRef,
    amountRp: tx.amountRp,
  });
}
