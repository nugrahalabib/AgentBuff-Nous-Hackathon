import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";
import { stopContainer } from "@/lib/hermes/docker";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";
import { auditLog } from "@/lib/security/audit-log";
import { trackEvent } from "@/lib/analytics/track";
import { emailUser } from "@/lib/email/notify";
import {
  subscriptionReminderEmail,
  subscriptionExpiredEmail,
} from "@/lib/email/templates";

// Renewal-reminder worker — the subscription analogue of the trial lifecycle
// worker. Renewal is MANUAL (no auto-debit; Midtrans recurring only covers
// cc/gopay-token, our market is QRIS/e-wallet). So before a subscription
// expires we nudge (in-app + email at the SUB_REMINDER_OFFSETS below), and ON
// expiry we docker-stop the container (resolveSubscription already flips the
// EFFECTIVE state to expired reactively, so the /app gate locks automatically —
// this worker just frees the container + sends the "expired" email).
//
// Reminder cadence is DISTINCT from the trial worker's [3,2,1]: a paid
// subscriber has a longer runway and a higher switching cost, so we nudge
// earlier — H-7, H-3, H-1, plus a hari-H (day 0) "expires today" touch — and
// keep it separate from the shared admin trial offsets on purpose.
//
// Single-row model (settle.ts updates ONE row in place): we sweep both 'active'
// and 'canceled'-not-yet-expired rows — the resolver treats canceled-with-future
// -expiry as still having access, so a canceled sub must also get pre-expiry
// reminders and, on lapse, the stop/notify. The expire flip is guarded on
// `expiresAt <= now` so a renewal that lands in the same tick (pushing expiry
// into the future) is never wrongly flipped to expired.

const DAY_MS = 24 * 60 * 60 * 1000;

// Subscription renewal reminder offsets (days-left), descending. Hardcoded and
// independent of getEmailSettings().reminderOffsetsDays (those drive the trial
// worker). Day 0 = "expires today" reminder; actual expiry (expiresAtMs <= now)
// is handled by expireSubscription, not this offset.
const SUB_REMINDER_OFFSETS = [7, 3, 1, 0] as const;
const INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AGENTBUFF_RENEWAL_WORKER_INTERVAL_MS ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000; // 30 min default
})();

async function sendRenewalReminder(
  userId: string,
  daysLeft: number,
): Promise<void> {
  const text =
    daysLeft <= 0
      ? "Langganan kamu habis hari ini. Perpanjang sekarang biar Buff kamu — termasuk yang di WhatsApp — nggak berhenti."
      : daysLeft === 1
        ? "Langganan kamu habis besok. Perpanjang biar Buff kamu — termasuk yang di WhatsApp — nggak berhenti."
        : `Langganan kamu tinggal ${daysLeft} hari lagi. Perpanjang biar Buff kamu tetap jalan tanpa putus.`;
  await db.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "clock",
    text,
    highPriority: daysLeft <= 1,
    actionLabel: "Perpanjang",
    actionHref: "/checkout",
  });
  void emailUser(userId, (loc) => subscriptionReminderEmail(daysLeft, loc));
}

async function expireSubscription(subId: string, userId: string): Promise<void> {
  // Flip THIS row active→expired (bookkeeping; the resolver is already reactive
  // on expiresAt). Conditional + returning so a concurrent webhook can't double
  // -process.
  const flipped = await db
    .update(schema.subscriptions)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(schema.subscriptions.id, subId),
        inArray(schema.subscriptions.status, ["active", "canceled"]),
        // Still lapsed — a renewal that pushed expiry into the future in the
        // meantime makes this 0 rows, so we never expire a just-renewed sub.
        lte(schema.subscriptions.expiresAt, new Date()),
      ),
    )
    .returning({
      id: schema.subscriptions.id,
      tier: schema.subscriptions.tier,
    });
  if (flipped.length === 0) return;

  // Renewed? A newer row keeps them EFFECTIVELY active — only a stale row was
  // flipped, so don't notify/stop.
  const sub = await resolveSubscription(userId);
  if (sub.status === "active") return;

  // Funnel churn event (F2) — fires once per real subscription→expired transition
  // (after the renewed-check, mirroring the subscription_history guard below).
  trackEvent("churn", {
    userId,
    props: { kind: "subscription", tier: flipped[0].tier },
  });

  // F4 subscription lifecycle history — record the real churn (only after the
  // renewed-check, so a stale row flipped while a newer row keeps the user
  // active is NOT counted as expiry).
  await db.insert(schema.subscriptionHistory).values({
    userId,
    subscriptionId: subId,
    fromTier: flipped[0].tier,
    toTier: flipped[0].tier,
    fromStatus: null,
    toStatus: "expired",
    reason: "expiry",
  });

  await db.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "lock",
    text: "Langganan kamu sudah berakhir. Buff kamu berhenti dulu sampai kamu perpanjang.",
    highPriority: true,
    actionLabel: "Perpanjang sekarang",
    actionHref: "/checkout",
  });
  void emailUser(userId, (loc) => subscriptionExpiredEmail(loc));

  try {
    await stopContainer(userId);
  } catch (e) {
    console.error("[renewal-worker] stopContainer failed for", userId, e);
  }

  auditLog({
    event: "billing.throttle.applied",
    outcome: "ok",
    actor: userId,
    details: { reason: "subscription_expired" },
  });
}

export async function sweepSubscriptions(): Promise<number> {
  const now = Date.now();
  // Subscription reminders use the dedicated [7,3,1,0] cadence, NOT the trial
  // worker's admin-configurable offsets.
  const offsets: readonly number[] = SUB_REMINDER_OFFSETS;
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(inArray(schema.subscriptions.status, ["active", "canceled"]));

  let touched = 0;
  for (const s of rows) {
    const expiresAtMs = s.expiresAt.getTime();
    if (expiresAtMs <= now) {
      await expireSubscription(s.id, s.userId);
      touched++;
      continue;
    }
    // daysLeft is >= 1 here (expiresAtMs > now → ceil of a positive value), so
    // the day-0 offset fires on the LAST tick before expiry, when the remaining
    // window rounds up to 1 day or less. We map that final pre-expiry window to
    // the 0 offset so the "expires today" reminder lands before the hard stop.
    const rawDaysLeft = Math.ceil((expiresAtMs - now) / DAY_MS);
    const daysLeft = (expiresAtMs - now) <= DAY_MS ? 0 : rawDaysLeft;
    if (offsets.includes(daysLeft)) {
      const last = s.lastRenewalRemindedDaysLeft;
      if (last == null || daysLeft < last) {
        await sendRenewalReminder(s.userId, daysLeft);
        await db
          .update(schema.subscriptions)
          .set({ lastRenewalRemindedDaysLeft: daysLeft })
          .where(eq(schema.subscriptions.id, s.id));
        touched++;
      }
    }
  }
  return touched;
}

export type RenewalWorkerHandle = { stop: () => Promise<void> };

export function startRenewalReminderWorker(): RenewalWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepSubscriptions();
      } catch (e) {
        ok = false;
        console.error("[renewal-worker] sweep failed:", e);
      } finally {
        recordHeartbeat("renewal-worker", ok, { intervalMs: INTERVAL_MS });
        inFlight = null;
      }
    })();
  }, INTERVAL_MS);

  console.log(`[renewal-worker] started — interval=${INTERVAL_MS}ms`);

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      if (inFlight) await inFlight;
    },
  };
}
