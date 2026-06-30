import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";
import { stopContainer } from "@/lib/hermes/docker";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";
import { auditLog } from "@/lib/security/audit-log";
import { trackEvent } from "@/lib/analytics/track";
import { emailUser } from "@/lib/email/notify";
import { trialReminderEmail, trialExpiredEmail } from "@/lib/email/templates";
import { getEmailSettings } from "@/lib/email/settings";

// Trial lifecycle worker — the proactive half of the 14-day trial enforcement
// (the reactive lock lives in resolveAccessState / the /app overlay).
//
// Every tick it sweeps ACTIVE trials and:
//   - sends H-3 / H-2 / H-1 reminder notifications (each once, deduped via
//     user_trial.last_reminded_days_left)
//   - expires a trial whose window has closed → flips status, notifies, and
//     `docker stop`s the container (volume preserved; resumed on payment)
//
// Renewal is MANUAL (no auto-debit). A user who pays has their trial flipped to
// 'converted' + container restarted by the billing webhook; this worker never
// touches converted/expired rows.

const DAY_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.AGENTBUFF_TRIAL_WORKER_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000; // 30 min default
})();

async function sendReminder(userId: string, daysLeft: number): Promise<void> {
  // H-1 copy MUST spell out that the WhatsApp agent stops too (Chief mandate).
  const text =
    daysLeft <= 1
      ? "Tinggal 1 hari! Besok masa percobaan habis dan agen kamu — termasuk yang di WhatsApp — akan berhenti. Perpanjang sekarang biar nggak putus."
      : `Tinggal ${daysLeft} hari lagi masa percobaan kamu. Perpanjang biar Buff kamu tetap jalan tanpa putus.`;
  await db.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "clock",
    text,
    highPriority: daysLeft <= 1,
    actionLabel: "Perpanjang",
    actionHref: "/checkout",
  });
  // Email reminder too (fire-and-forget; no-op if SMTP unconfigured). Users who
  // aren't in /app still get nudged — Google-only auth = every user has email.
  void emailUser(userId, (loc) => trialReminderEmail(daysLeft, loc));
}

async function expireTrial(userId: string): Promise<void> {
  // Last-moment guard: if they paid right at the wire, the webhook owns the
  // transition — don't stop a paying user's container.
  const sub = await resolveSubscription(userId);
  if (sub.status === "active") return;

  // Only expire a still-ACTIVE trial, and learn whether we actually flipped it.
  // If the payment webhook converted it (status='converted') in the same window,
  // this matches no row → we skip the notify + stopContainer, so we never clobber
  // a converted trial or race a docker stop against the webhook's start.
  const flipped = await db
    .update(schema.userTrials)
    .set({ status: "expired" })
    .where(
      and(
        eq(schema.userTrials.userId, userId),
        eq(schema.userTrials.status, "active"),
      ),
    )
    .returning({ userId: schema.userTrials.userId });
  if (flipped.length === 0) return;

  // Funnel churn event (F2) — fires once per real trial→expired transition.
  trackEvent("churn", { userId, props: { kind: "trial" } });

  await db.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "lock",
    text: "Masa percobaan 14 hari kamu sudah habis. Buff kamu — termasuk yang di WhatsApp — berhenti dulu sampai kamu perpanjang.",
    highPriority: true,
    actionLabel: "Perpanjang sekarang",
    actionHref: "/checkout",
  });

  void emailUser(userId, (loc) => trialExpiredEmail(loc));

  try {
    await stopContainer(userId);
  } catch (e) {
    console.error("[trial-worker] stopContainer failed for", userId, e);
  }

  auditLog({
    event: "billing.throttle.applied",
    outcome: "ok",
    actor: userId,
    details: { reason: "trial_expired" },
  });
}

/**
 * Self-heal pass: expireTrial swallows a failed `stopContainer` (and only ACTIVE
 * trials are swept), so a stop that failed once leaves an expired-trial container
 * running indefinitely with no retry. Re-stop any container that is still
 * 'running' for an expired, unpaid trial. Idempotent (stopContainer no-ops a
 * stopped container); a user who paid since is skipped (their sub is active).
 */
async function reconcileOrphanedContainers(): Promise<number> {
  const rows = await db
    .select({ userId: schema.userTrials.userId })
    .from(schema.userTrials)
    .innerJoin(
      schema.userContainers,
      eq(schema.userContainers.userId, schema.userTrials.userId),
    )
    .where(
      and(
        eq(schema.userTrials.status, "expired"),
        eq(schema.userContainers.status, "running"),
      ),
    );

  let reclaimed = 0;
  for (const r of rows) {
    const sub = await resolveSubscription(r.userId);
    if (sub.status === "active") continue; // paid since → leave it running
    try {
      await stopContainer(r.userId);
      reclaimed++;
      auditLog({
        event: "billing.throttle.applied",
        outcome: "ok",
        actor: r.userId,
        details: { reason: "orphaned_container_reclaimed" },
      });
    } catch (e) {
      console.error("[trial-worker] reclaim stopContainer failed for", r.userId, e);
    }
  }
  return reclaimed;
}

export async function sweepTrials(): Promise<number> {
  const now = Date.now();
  // Reminder thresholds are admin-configurable (default [3,2,1]); drive both
  // the in-app notification and the email off the same offsets.
  const offsets = (await getEmailSettings()).reminderOffsetsDays;
  const rows = await db
    .select()
    .from(schema.userTrials)
    .where(eq(schema.userTrials.status, "active"));

  let touched = 0;
  for (const t of rows) {
    const endsAtMs = t.endsAt.getTime();
    if (endsAtMs <= now) {
      await expireTrial(t.userId);
      touched++;
      continue;
    }
    const daysLeft = Math.ceil((endsAtMs - now) / DAY_MS);
    if (offsets.includes(daysLeft)) {
      const last = t.lastRemindedDaysLeft;
      // Send once per descending threshold (3 → 2 → 1).
      if (last == null || daysLeft < last) {
        await sendReminder(t.userId, daysLeft);
        await db
          .update(schema.userTrials)
          .set({ lastRemindedDaysLeft: daysLeft })
          .where(eq(schema.userTrials.userId, t.userId));
        touched++;
      }
    }
  }
  // Reclaim any container left running for an expired, unpaid trial (failed stop).
  touched += await reconcileOrphanedContainers();
  return touched;
}

export type TrialWorkerHandle = { stop: () => Promise<void> };

export function startTrialLifecycleWorker(): TrialWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepTrials();
      } catch (e) {
        ok = false;
        console.error("[trial-worker] sweep failed:", e);
      } finally {
        recordHeartbeat("trial-worker", ok, { intervalMs: INTERVAL_MS });
        inFlight = null;
      }
    })();
  }, INTERVAL_MS);

  console.log(`[trial-worker] started — interval=${INTERVAL_MS}ms`);

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      if (inFlight) await inFlight;
    },
  };
}
