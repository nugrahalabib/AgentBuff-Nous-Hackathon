import { and, count, eq, sum } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveSellerForUser, SELLER_PENDING } from "@/lib/seller/resolve";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D4 seller portal — own seller profile + summary (GET), apply to become a
// seller (POST), edit profile/bank (PATCH). All scoped to the session user.
export const dynamic = "force-dynamic";

function sanitizePayout(p: Record<string, unknown> | null) {
  if (!p) return null;
  return {
    bankCode: typeof p.bankCode === "string" ? p.bankCode : "",
    accountNumber: typeof p.accountNumber === "string" ? p.accountNumber : "",
    accountName: typeof p.accountName === "string" ? p.accountName : "",
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const seller = await resolveSellerForUser(session.user.id);
  if (!seller) return Response.json({ seller: null });

  const [listingsRow] = await db
    .select({ c: count() })
    .from(schema.listings)
    .where(eq(schema.listings.sellerId, seller.id));
  const [salesRow] = await db
    .select({ c: count(), gross: sum(schema.payoutLedger.grossRp), net: sum(schema.payoutLedger.netRp) })
    .from(schema.payoutLedger)
    .where(eq(schema.payoutLedger.sellerId, seller.id));
  const [paidRow] = await db
    .select({ net: sum(schema.payoutLedger.netRp) })
    .from(schema.payoutLedger)
    .where(
      and(
        eq(schema.payoutLedger.sellerId, seller.id),
        eq(schema.payoutLedger.status, "paid"),
      ),
    );

  return Response.json({
    seller: {
      id: seller.id,
      status: seller.status,
      displayName: seller.displayName,
      commissionPct: seller.commissionPct,
      payout: sanitizePayout(seller.payoutInfo),
    },
    summary: {
      listings: listingsRow?.c ?? 0,
      sales: salesRow?.c ?? 0,
      grossRp: Number(salesRow?.gross ?? 0),
      earnedNetRp: Number(salesRow?.net ?? 0),
      paidNetRp: Number(paidRow?.net ?? 0),
    },
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const userId = session.user.id;
  const rl = take(keyFromRequest("seller-apply", req, userId), 5, 60 * 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  const existing = await resolveSellerForUser(userId);
  if (existing) return Response.json({ error: "ALREADY_SELLER" }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as { displayName?: string };
  const displayName = (body.displayName ?? "").trim().slice(0, 80);
  if (!displayName) {
    return Response.json({ error: "DISPLAY_NAME_REQUIRED" }, { status: 400 });
  }
  await db.insert(schema.sellers).values({
    type: "third_party",
    ownerUserId: userId,
    displayName,
    status: SELLER_PENDING, // admin approves -> active before payouts
  });
  auditLog({
    event: "admin.seller.create",
    outcome: "ok",
    actor: userId,
    details: { self_apply: true },
  });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const seller = await resolveSellerForUser(session.user.id);
  if (!seller) return Response.json({ error: "NOT_SELLER" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    displayName?: string;
    bankCode?: string;
    accountNumber?: string;
    accountName?: string;
  };
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.displayName === "string" && body.displayName.trim()) {
    updates.displayName = body.displayName.trim().slice(0, 80);
  }
  // Bank info — same format rules as the admin seller editor.
  const bankCode = (body.bankCode ?? "").trim().toLowerCase().slice(0, 24);
  const accountNumber = (body.accountNumber ?? "").trim().slice(0, 40);
  const accountName = (body.accountName ?? "").trim().slice(0, 120);
  if (bankCode || accountNumber || accountName) {
    if (!bankCode || !accountNumber || !accountName) {
      return Response.json({ error: "INCOMPLETE_BANK" }, { status: 400 });
    }
    if (!/^[0-9]+$/.test(accountNumber)) {
      return Response.json({ error: "INVALID_ACCOUNT_NUMBER" }, { status: 400 });
    }
    updates.payoutInfo = { bankCode, accountNumber, accountName };
  }

  await db
    .update(schema.sellers)
    .set(updates)
    .where(eq(schema.sellers.id, seller.id));
  auditLog({
    event: "admin.seller.update",
    outcome: "ok",
    actor: session.user.id,
    target: seller.id,
    details: { self_edit: true, fields: Object.keys(updates) },
  });
  return Response.json({ ok: true });
}
