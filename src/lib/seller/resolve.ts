// Seller self-service (D4 portal). Resolve the 3rd-party seller a logged-in user
// owns (sellers.ownerUserId). One user owns at most one seller. NOT server-only:
// imported by the /api/seller route handlers.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export type OwnedSeller = {
  id: string;
  type: string;
  status: string;
  displayName: string;
  commissionPct: number | null;
  payoutInfo: Record<string, unknown> | null;
};

/** The third_party seller owned by this user, or null. (House/first_party
 *  sellers have no ownerUserId, so they never resolve here.) */
export async function resolveSellerForUser(
  userId: string,
): Promise<OwnedSeller | null> {
  const [row] = await db
    .select({
      id: schema.sellers.id,
      type: schema.sellers.type,
      status: schema.sellers.status,
      displayName: schema.sellers.displayName,
      commissionPct: schema.sellers.commissionPct,
      payoutInfo: schema.sellers.payoutInfo,
    })
    .from(schema.sellers)
    .where(
      and(
        eq(schema.sellers.ownerUserId, userId),
        eq(schema.sellers.type, "third_party"),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Statuses a seller account can be in (admin approves pending -> active).
export const SELLER_PENDING = "pending";
export const SELLER_ACTIVE = "active";
