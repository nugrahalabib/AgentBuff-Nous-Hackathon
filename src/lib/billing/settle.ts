import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { computeRenewalExpiry } from "@/lib/billing/period";
import { installSkillForTransaction } from "@/lib/billing/skill-installer";
import {
  resolveCommissionPct,
  computeSplit,
  isoWeekPeriod,
} from "@/lib/admin/commission";
import { releaseCoupon } from "@/lib/billing/coupon";
import { auditLog } from "@/lib/security/audit-log";
import { trackEvent } from "@/lib/analytics/track";
import { emailUser } from "@/lib/email/notify";
import { paymentReceiptEmail } from "@/lib/email/templates";
import { generateReceiptPdf, receiptNumber } from "@/lib/billing/receipt-pdf";
import { hermesConfig } from "@/lib/hermes/config";

// Shared settlement logic — the SINGLE source of truth for "a Midtrans payment
// landed, apply its effects". Called by BOTH:
//   1. the webhook (src/app/api/billing/webhook/route.ts) on a settlement push, and
//   2. the reconcile-worker (src/lib/billing/reconcile-worker.ts) which polls
//      Get-Status for pending transactions when a webhook is late or lost.
// Both must converge to the SAME effect exactly once — hence the idempotent
// conditional UPDATE (pending→completed RETURNING) gates every side-effect.
// The flip + the deterministic effect (sub activation / energy credit) run in
// ONE transaction so a crash can never commit "completed" without applying the
// effect (which would strand a payer: webhook replay sees 'completed' and the
// reconcile-worker only re-picks 'pending'). Retriable fire-and-forget work
// (receipt email, skill-install dispatch, container resume) stays OUTSIDE.

/** Drizzle transaction handle (same surface as `db` for the calls we make). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Midtrans sends gross_amount as a decimal string, e.g. "99000.00". */
function grossToInt(grossAmount: string): number | null {
  const n = Math.round(Number(grossAmount));
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply a settled payment exactly once. Idempotent + amount-checked.
 * `grossAmount` is the raw Midtrans string (already signature-verified by the
 * caller); we cross-check it against the amount WE recorded for this order
 * before doing anything, then flip pending→completed and run type-specific
 * effects. A replay (already completed) is a safe no-op.
 */
export async function applySettlement(
  orderId: string,
  grossAmount: string,
  paymentRef: string | null,
  ip: string | null,
  paymentMethod: string | null = null,
): Promise<void> {
  // Defensive amount cross-check BEFORE any side-effect. The signature already
  // proves the payload is authentic; this catches our recorded amount diverging
  // from what was actually charged (tampered charge request / bug). A mismatch
  // is NOT settled — left pending for manual review (Get-Status reconcile will
  // re-check against Midtrans' authoritative amount).
  const [pre] = await db
    .select({
      amountRp: schema.transactions.amountRp,
      status: schema.transactions.status,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.midtransOrderId, orderId))
    .limit(1);
  if (!pre) {
    auditLog({
      event: "billing.settlement.order_not_found",
      outcome: "reject",
      target: orderId,
      ip,
    });
    return;
  }
  const gross = grossToInt(grossAmount);
  if (gross === null || gross !== pre.amountRp) {
    auditLog({
      event: "billing.settlement.amount_mismatch",
      outcome: "reject",
      target: orderId,
      ip,
      details: { gross, expected: pre.amountRp },
    });
    return;
  }

  // Idempotency gate + deterministic effect in ONE transaction. Only the first
  // settlement advances pending→completed AND applies its effect atomically;
  // replays return no rows → exit. UNIQUE(midtrans_order_id) also prevents
  // duplicate inserts; this prevents duplicate (or partial) SIDE-EFFECTS.
  const settledNow = new Date();
  const tx = await db.transaction(async (dbtx) => {
    const [row] = await dbtx
      .update(schema.transactions)
      .set({
        status: "completed",
        paymentRef,
        // Authoritative payment provenance, set once at settlement.
        paymentMethod,
        paidAt: settledNow,
        updatedAt: settledNow,
      })
      .where(
        and(
          eq(schema.transactions.midtransOrderId, orderId),
          eq(schema.transactions.status, "pending"),
        ),
      )
      .returning();
    if (!row) return null;

    if (row.type === "topup") {
      // Energy OFF (BYOK) — don't write phantom balances while the system is off.
      if (hermesConfig.energyGateEnabled) {
        await creditEnergy(dbtx, row.userId, row.energyDelta, row.description);
      }
    } else if (row.type === "subscription") {
      await activateSubscriptionTx(dbtx, orderId, row);
    }
    // skill-install: only the flip is transactional; the install dispatch is
    // retriable fire-and-forget AFTER commit (below).
    //
    // Marketplace sale → record the seller commission split ATOMICALLY with the
    // flip. Because the pending→completed flip gates this AND payout_ledger.
    // transactionId is UNIQUE (onConflictDoNothing), a webhook replay can never
    // double-credit a seller. first_party listings record no row.
    const meta = (row.metadata ?? {}) as { source?: string; listingId?: string };
    if (
      row.type === "skill-install" &&
      meta.source === "marketplace" &&
      typeof meta.listingId === "string"
    ) {
      await recordMarketplaceCommission(dbtx, row, meta.listingId, settledNow);
    }
    return row;
  });

  if (!tx) {
    auditLog({
      event: "billing.settlement.replay_ignored",
      outcome: "ok",
      target: orderId,
      ip,
    });
    return;
  }

  auditLog({
    event: "billing.settlement.applied",
    outcome: "ok",
    actor: tx.userId,
    target: orderId,
    ip,
    details: { type: tx.type, amountRp: tx.amountRp },
  });

  // Receipt email + official PDF receipt (fire-and-forget; no-op if SMTP
  // unconfigured). Money-in types only — a skill-install completion isn't a
  // "receipt". The receipt NUMBER derives from the IMMUTABLE tx.createdAt so it
  // is identical everywhere it's generated (email + on-demand download + the
  // history list) — a stable reference the user can quote for verification. The
  // displayed DATE is the PAID date (tx.paidAt) so a delayed VA/QRIS payment
  // shows when the money actually landed. The send OUTCOME is audited
  // (billing.receipt.sent / .failed) so a swallowed failure is still visible.
  if (tx.type === "topup" || tx.type === "subscription") {
    const receiptNo = receiptNumber(tx.id, tx.createdAt);
    const paidDate = tx.paidAt ?? tx.updatedAt ?? settledNow;
    void emailUser(
      tx.userId,
      (loc) =>
        paymentReceiptEmail(
          { description: tx.description, amountRp: tx.amountRp },
          loc,
        ),
      async ({ email, name, locale }) => {
        const pdf = await generateReceiptPdf({
          receiptNo,
          dateIso: paidDate.toISOString(),
          description: tx.description,
          amountRp: tx.amountRp,
          paymentRef: tx.paymentRef,
          paymentMethod: tx.paymentMethod,
          orderId: tx.midtransOrderId,
          billedToEmail: email,
          billedToName: name,
          locale,
        });
        return [{ filename: `Struk-${receiptNo}.pdf`, content: pdf }];
      },
    )
      .then((ok) =>
        auditLog({
          event: ok ? "billing.receipt.sent" : "billing.receipt.failed",
          outcome: ok ? "ok" : "reject",
          actor: tx.userId,
          target: orderId,
        }),
      )
      .catch((e) => console.error("[settle] receipt send failed:", e));
  }

  if (tx.type === "subscription") {
    // Resume the container AFTER commit if it was docker-stopped at expiry.
    // Fire-and-forget (startContainer waits for health) so the caller returns
    // fast; lazy import keeps docker off the static graph.
    void import("@/lib/hermes/docker")
      .then(({ startContainer }) => startContainer(tx.userId))
      .then(() =>
        auditLog({
          event: "billing.throttle.cleared",
          outcome: "ok",
          actor: tx.userId,
          target: orderId,
          details: { reason: "subscription_activated" },
        }),
      )
      .catch((e) => console.error("[settle] container resume failed:", e));
    return;
  }

  if (tx.type === "skill-install") {
    auditLog({
      event: "billing.skill.install_started",
      outcome: "ok",
      actor: tx.userId,
      target: tx.id,
      details: { sku: tx.sku ?? null },
    });
    // Background — don't block the caller. The retry worker picks up failures
    // via the same transactionId.
    void installSkillForTransaction(tx.id).catch((e) => {
      console.error("[settle] skill install dispatch failed:", e);
    });
  }
}

/**
 * Mark a transaction failed (deny/cancel/expire/failure/fraud-deny). Guarded to
 * 'pending' so a replayed terminal status (signature stays valid forever) or a
 * late terminal-fail arriving AFTER a reconcile-settlement can NEVER clobber an
 * already-'completed' (paid) row to 'failed' and corrupt the financial record.
 */
export async function markTransactionFailed(orderId: string): Promise<void> {
  // The flip and the coupon release must be atomic: a crash between them would
  // leave the order 'failed' but the coupon use permanently burned. One txn.
  await db.transaction(async (dbtx) => {
    const [row] = await dbtx
      .update(schema.transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.midtransOrderId, orderId),
          eq(schema.transactions.status, "pending"),
        ),
      )
      .returning();
    // The payment lapsed → release any held coupon reservation so the slot isn't
    // burned by an unpaid order. Only fires when a pending row was actually
    // flipped (RETURNING is empty on a replay of an already-terminal order).
    const meta = (row?.metadata ?? {}) as { couponCode?: string };
    if (meta.couponCode) await releaseCoupon(meta.couponCode, dbtx);
  });
}

// 14-day chargeback hold before a ledger row becomes payout-eligible.
const PAYOUT_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Record the commission split for a settled marketplace sale. Runs INSIDE the
 * settlement transaction (atomic with the pending→completed flip). first-party
 * sellers (platform-owned) and a vanished listing/seller record no row — the
 * install still proceeds; there's simply nothing to pay out.
 */
async function recordMarketplaceCommission(
  dbtx: Tx,
  row: typeof schema.transactions.$inferSelect,
  listingId: string,
  now: Date,
): Promise<void> {
  const [listing] = await dbtx
    .select({
      category: schema.listings.category,
      sellerId: schema.listings.sellerId,
    })
    .from(schema.listings)
    .where(eq(schema.listings.id, listingId))
    .limit(1);
  if (!listing) return;

  const [seller] = await dbtx
    .select({
      id: schema.sellers.id,
      type: schema.sellers.type,
      commissionPct: schema.sellers.commissionPct,
    })
    .from(schema.sellers)
    .where(eq(schema.sellers.id, listing.sellerId))
    .limit(1);
  if (!seller || seller.type === "first_party") return;

  const pct = await resolveCommissionPct(
    seller,
    { category: listing.category },
    dbtx,
  );
  const { commissionRp, netRp } = computeSplit(row.amountRp, pct);

  await dbtx
    .insert(schema.payoutLedger)
    .values({
      transactionId: row.id,
      listingId,
      sellerId: seller.id,
      grossRp: row.amountRp,
      commissionPct: pct,
      commissionRp,
      netRp,
      period: isoWeekPeriod(now),
      holdUntil: new Date(now.getTime() + PAYOUT_HOLD_MS),
      status: "pending",
    })
    .onConflictDoNothing({ target: schema.payoutLedger.transactionId });
}

async function creditEnergy(
  dbtx: Tx,
  userId: string,
  delta: number,
  description: string,
): Promise<void> {
  if (delta <= 0) return;
  // Top-up = capacity naik. Balance + max bertambah equal supaya display
  // "used / max" konsisten (fuel-gauge mental model: top-up nambah kapasitas,
  // bukan reset progress).
  await dbtx
    .update(schema.userEnergy)
    .set({
      balance: sql`${schema.userEnergy.balance} + ${delta}`,
      maxBalance: sql`${schema.userEnergy.maxBalance} + ${delta}`,
      lastTopupAt: new Date(),
    })
    .where(eq(schema.userEnergy.userId, userId));

  await dbtx.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "zap",
    text: `Top-up berhasil! +${delta} Energy — ${description}`,
    highPriority: false,
  });
}

async function activateSubscriptionTx(
  dbtx: Tx,
  orderId: string,
  txRow: typeof schema.transactions.$inferSelect,
): Promise<void> {
  const now = new Date();
  const userId = txRow.userId;

  // Serialize ALL subscription settlements for this user. Two payments settling
  // concurrently (e.g. user paid twice, or webhook + reconcile overlap on two
  // different orders) would otherwise race the extend-or-insert below: a lost
  // update could drop a paid period, or two "first" settlements could insert two
  // active rows. The advisory lock auto-releases on tx commit/rollback. The
  // pending->completed flip gate already serializes the SAME order; this covers
  // DIFFERENT orders for the same user.
  await dbtx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

  // Tier + cycle come from THIS transaction's metadata (what the user paid for
  // now), not the old sub row — so switching monthly -> yearly takes effect.
  const meta = (txRow.metadata ?? {}) as {
    tier?: string;
    billingCycle?: string;
  };
  // A self-serve subscription settlement only ever activates op_buff — the POST
  // route's zod enum rejects anything else, so we never mint guild_master from
  // transaction metadata (that tier is enterprise, granted out-of-band only).
  const tier = "op_buff" as const;
  const billingCycle = meta.billingCycle === "yearly" ? "yearly" : "monthly";
  const priceRp = txRow.amountRp;

  // The user's current subscription row (latest by createdAt — the SAME row the
  // resolver treats as effective). Renewal/extension UPDATES this one row in
  // place; a first-ever subscribe finds none and inserts. Never create a second
  // active row — that would orphan paid time and confuse the resolver.
  const [existing] = await dbtx
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);

  // Never let a self-serve op_buff settlement clobber an enterprise sub. If an
  // admin granted guild_master after this charge was created (rare race), keep
  // the higher tier untouched. The tx is already flipped to completed above, so
  // log for a manual credit decision rather than silently downgrading the user.
  if (
    existing?.tier === "guild_master" &&
    (existing.status === "active" || existing.status === "canceled") &&
    existing.expiresAt.getTime() > now.getTime()
  ) {
    auditLog({
      event: "billing.settlement.tier_downgrade_blocked",
      outcome: "reject",
      actor: userId,
      target: orderId,
      details: { existingTier: existing.tier, paidFor: tier },
    });
    return;
  }

  // EXTEND from the current expiry when the existing sub still grants access
  // (active, or canceled-but-not-yet-expired); otherwise RESET from now (lapsed
  // or brand-new). Single rule shared with the checkout preview (period.ts) so
  // what the user was promised == what we write.
  const currentExpiry =
    existing && (existing.status === "active" || existing.status === "canceled")
      ? existing.expiresAt
      : null;
  const { expiresAt, isExtension } = computeRenewalExpiry(
    currentExpiry,
    billingCycle,
    now,
  );
  const maxBalance = 5_000; // op_buff energy cap (energy gate currently OFF)

  if (existing) {
    await dbtx
      .update(schema.subscriptions)
      .set({
        tier,
        billingCycle,
        priceRp,
        status: "active",
        autoRenew: false,
        // Keep the original start when stacking onto live time; reset to now when
        // reactivating after a lapse.
        startsAt: isExtension ? existing.startsAt : now,
        expiresAt,
        midtransOrderId: orderId,
        // New period -> let the renewal worker re-send H-7/3/1 reminders.
        lastRenewalRemindedDaysLeft: null,
        updatedAt: now,
      })
      .where(eq(schema.subscriptions.id, existing.id));
  } else {
    await dbtx.insert(schema.subscriptions).values({
      userId,
      tier,
      billingCycle,
      priceRp,
      status: "active",
      autoRenew: false,
      startsAt: now,
      expiresAt,
      midtransOrderId: orderId,
    });
  }
  // Convert the trial (if any) so the lifecycle worker leaves it alone.
  await dbtx
    .update(schema.userTrials)
    .set({ status: "converted", convertedAt: now })
    .where(eq(schema.userTrials.userId, userId));
  // Energy OFF (BYOK) — skip the per-tier energy cap write while energy is off.
  if (hermesConfig.energyGateEnabled) {
    await dbtx
      .update(schema.userEnergy)
      .set({ maxBalance })
      .where(eq(schema.userEnergy.userId, userId));
  }
  await dbtx.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "crown",
    text: isExtension
      ? "Langganan diperpanjang! Masa aktif Buff kamu ketambah. Gas terus, Chief."
      : "Langganan aktif! Buff kamu udah on. Selamat datang kembali, Chief.",
    highPriority: true,
  });

  // F4 subscription lifecycle history (cohort/retention) — atomic with the
  // activation above (same tx). The funnel "paid" emit is fire-and-forget on its
  // own connection, so it can never roll back the settlement.
  await dbtx.insert(schema.subscriptionHistory).values({
    userId,
    subscriptionId: existing?.id ?? null,
    fromTier: existing?.tier ?? null,
    toTier: tier,
    fromStatus: existing?.status ?? null,
    toStatus: "active",
    reason: isExtension ? "renewal" : existing ? "reactivate" : "new",
  });
  trackEvent("paid", { userId, props: { tier, billingCycle, priceRp } });
}
