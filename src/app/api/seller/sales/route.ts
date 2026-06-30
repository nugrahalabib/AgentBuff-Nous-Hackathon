import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveSellerForUser } from "@/lib/seller/resolve";

// D4 seller portal — my sales (per-sale commission split) + my payout batches.
// All scoped to the caller's seller; read-only.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const seller = await resolveSellerForUser(session.user.id);
  if (!seller) return Response.json({ error: "NOT_SELLER" }, { status: 403 });

  const sales = await db
    .select({
      id: schema.payoutLedger.id,
      listingTitle: schema.listings.title,
      grossRp: schema.payoutLedger.grossRp,
      commissionPct: schema.payoutLedger.commissionPct,
      commissionRp: schema.payoutLedger.commissionRp,
      netRp: schema.payoutLedger.netRp,
      status: schema.payoutLedger.status,
      period: schema.payoutLedger.period,
      createdAt: schema.payoutLedger.createdAt,
    })
    .from(schema.payoutLedger)
    .leftJoin(
      schema.listings,
      eq(schema.listings.id, schema.payoutLedger.listingId),
    )
    .where(eq(schema.payoutLedger.sellerId, seller.id))
    .orderBy(desc(schema.payoutLedger.createdAt))
    .limit(200);

  const batches = await db
    .select({
      id: schema.payoutBatches.id,
      totalNetRp: schema.payoutBatches.totalNetRp,
      status: schema.payoutBatches.status,
      submittedAt: schema.payoutBatches.submittedAt,
      completedAt: schema.payoutBatches.completedAt,
      createdAt: schema.payoutBatches.createdAt,
    })
    .from(schema.payoutBatches)
    .where(eq(schema.payoutBatches.sellerId, seller.id))
    .orderBy(desc(schema.payoutBatches.createdAt))
    .limit(50);

  return Response.json({ sales, batches });
}
