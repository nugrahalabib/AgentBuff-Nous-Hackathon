import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { reconcileOne } from "@/lib/billing/reconcile-worker";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";

// On-demand settlement check. The checkout poll + "Cek status sekarang" + the
// riwayat per-row "Cek status" call this so a genuinely-paid order settles within
// SECONDS — dev has no webhook reaching localhost, and even in prod this is the
// webhook-loss safety net. Without it the user is stuck on "Diproses" until the
// 5-min background worker happens to run.
//
// SECURITY: this is NOT a "mark me paid" endpoint. It is owner-scoped (only the
// caller's own tx), rate-limited, and merely asks us to re-run the SAME
// authoritative path the worker uses — Midtrans Get-Status -> SHA512 signature
// verify -> idempotent applySettlement. The tx flips to completed ONLY if
// Midtrans itself reports the payment captured/settled; a forged request cannot
// move money or grant access. Already-terminal txs are returned untouched (no
// Midtrans call) so repeated polling stays cheap.

const RECONCILE_LIMIT = 30;
const RECONCILE_WINDOW_MS = 60_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    const ip = clientIpFromRequest(req);

    const rl = take(
      keyFromRequest("billing.reconcile", req, userId),
      RECONCILE_LIMIT,
      RECONCILE_WINDOW_MS,
    );
    if (!rl.ok) {
      auditLog({
        event: "rate_limit.exceeded",
        outcome: "reject",
        actor: userId,
        ip,
        details: { ns: "billing.reconcile" },
      });
      return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    const { id } = await params;
    if (!id || id.length > 80)
      return Response.json({ error: "INVALID_ID" }, { status: 400 });

    const [tx] = await db
      .select({
        id: schema.transactions.id,
        status: schema.transactions.status,
        midtransOrderId: schema.transactions.midtransOrderId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.userId, userId),
        ),
      )
      .limit(1);

    if (!tx) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    // Only a pending tx with a registered Midtrans order is worth reconciling.
    // Terminal states (completed/installed/failed/refunded) return as-is — no
    // Midtrans call — so the checkout poll firing every few seconds stays cheap.
    if (tx.status === "pending" && tx.midtransOrderId) {
      await reconcileOne(tx.midtransOrderId);
      // Re-read with the SAME owner scope as the first lookup — defense in depth
      // so the status we return is self-evidently the caller's own row.
      const [fresh] = await db
        .select({ status: schema.transactions.status })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.userId, userId),
          ),
        )
        .limit(1);
      return Response.json({ status: fresh?.status ?? tx.status });
    }

    return Response.json({ status: tx.status });
  } catch (e) {
    console.error("[transactions reconcile]", e);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
