import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userTrials } from "@/lib/db/schema";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";

// Trial + access state — the single source of truth for "is this onboarded
// user's /app locked?". Reactive: the lock is computed from endsAt vs now and
// the live subscription state, so it is correct even if the lifecycle worker
// hasn't flipped the trial row to 'expired' yet.
//
// Lock conditions (either one locks /app behind the pay overlay):
//   1. TRIAL lapse — the user onboarded (has a trial row), that trial has
//      ended, AND they have no active paid subscription.
//   2. SUBSCRIPTION lapse — they were a paying customer whose access lapsed:
//      no active sub AND a prior subscription row is now expired/canceled.
//      This covers the user who upgraded straight from trial (or never had a
//      trial row at all) and later let their subscription run out — the trial
//      branch alone would leave them unlocked.
//
// A user with NO trial row AND NO subscription history has not onboarded /
// never paid — the onboarding gate handles them, not this lock.

const DAY_MS = 24 * 60 * 60 * 1000;

/** What made /app lock, so the overlay can show the right copy. */
export type LockReason = "trial" | "subscription" | null;

export interface TrialInfo {
  status: string;
  startedAt: string;
  endsAt: string;
  /** Whole days remaining (ceil), 0 once ended. */
  daysLeft: number;
}

export interface AccessState {
  /** True → render the trial-locked overlay; the agent's container is stopped. */
  locked: boolean;
  hasActiveSub: boolean;
  trial: TrialInfo | null;
  /** Why the lock applies: "trial" or "subscription". null when not locked. */
  reason: LockReason;
}

export async function resolveAccessState(userId: string): Promise<AccessState> {
  const sub = await resolveSubscription(userId);
  const hasActiveSub = sub.status === "active";
  // A prior paid subscription that has since lapsed. "starter_default" means the
  // user never had a subscription row at all, so it does NOT count as a lapse.
  const subLapsed = sub.status === "expired" || sub.status === "canceled";

  const [row] = await db
    .select()
    .from(userTrials)
    .where(eq(userTrials.userId, userId))
    .limit(1);

  if (!row) {
    // No trial row. Still lock if they were a paying customer whose subscription
    // lapsed (upgraded-without-trial-row, or trial row predates this table).
    if (!hasActiveSub && subLapsed) {
      return { locked: true, hasActiveSub, trial: null, reason: "subscription" };
    }
    // No trial, no lapsed sub → not onboarded / never paid. Onboarding gate's job.
    return { locked: false, hasActiveSub, trial: null, reason: null };
  }

  const now = Date.now();
  const endsAtMs = row.endsAt.getTime();
  const daysLeft = Math.max(0, Math.ceil((endsAtMs - now) / DAY_MS));
  const trialEnded = endsAtMs <= now || row.status === "expired";

  const trial: TrialInfo = {
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    daysLeft,
  };

  // Active sub → never locked, regardless of trial state.
  if (hasActiveSub) {
    return { locked: false, hasActiveSub, trial, reason: null };
  }

  // No active sub. A lapsed subscription is the stronger, more recent signal —
  // a once-paying customer who let their plan run out sees the "subscription"
  // copy, not the "trial expired" copy. Otherwise fall back to the trial lock.
  if (subLapsed) {
    return { locked: true, hasActiveSub, trial, reason: "subscription" };
  }
  return {
    locked: trialEnded,
    hasActiveSub,
    trial,
    reason: trialEnded ? "trial" : null,
  };
}
