// SINGLE SOURCE OF TRUTH for subscription period math. Imported by BOTH:
//   1. the settlement writer (src/lib/billing/settle.ts) — what the DB records, and
//   2. the checkout preview (src/app/checkout/checkout-client.tsx) — what the user
//      is told their new expiry will be.
// Keeping the rule in one pure module guarantees the promise on the checkout
// screen and the value written on payment can never diverge (no "kepalsuan").

import type { BillingCycle } from "@/lib/billing/plans";

/**
 * Add one calendar month/year from `base`, clamping day overflow. Without the
 * clamp, `setMonth`/`setFullYear` roll a day-29-31 pay date into the NEXT month
 * (Jan 31 +1mo -> Mar 3, Aug 31 +1mo -> Oct 1, Feb 29 +1yr -> Mar 1), silently
 * granting ~31 free days. Clamp snaps back to the last day of the intended month.
 */
export function addCalendarPeriod(base: Date, cycle: BillingCycle): Date {
  const d = new Date(base);
  const day = d.getDate();
  if (cycle === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

export type RenewalComputation = {
  /** The date the new period is counted FROM. */
  base: Date;
  /** The resulting expiry after adding one period to `base`. */
  expiresAt: Date;
  /** true = stacked onto remaining paid time (active renewal); false = reset from now. */
  isExtension: boolean;
};

/**
 * Compute the new expiry when a subscription payment settles (or is previewed).
 *
 *  - Still active (`currentExpiry` in the future)  -> EXTEND: stack the new period
 *    on top of the remaining paid time (current expiry + 1 period). Switching
 *    cycle (monthly -> yearly) while active extends from the same base, so paying
 *    yearly mid-month adds a full year onto the current end date.
 *  - Lapsed / never subscribed (`currentExpiry` null or in the past) -> RESET:
 *    the new period starts from `now`, so the end date is "today + 1 period".
 *
 * Single rule shared by the checkout preview (what the user is promised) and the
 * settlement writer (what the DB records).
 */
export function computeRenewalExpiry(
  currentExpiry: Date | null,
  cycle: BillingCycle,
  now: Date,
): RenewalComputation {
  const isExtension =
    currentExpiry !== null && currentExpiry.getTime() > now.getTime();
  const base = isExtension && currentExpiry !== null ? currentExpiry : now;
  return { base, expiresAt: addCalendarPeriod(base, cycle), isExtension };
}
