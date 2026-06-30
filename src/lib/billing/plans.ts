// SINGLE SOURCE OF TRUTH for the plan/pricing CATALOG. Every surface that shows
// a tier (landing item-shop, in-app Item Shop subscription tab, /checkout, the
// subscription API) reads the STRUCTURE from here — change a price/status/CTA
// once and both surfaces update. Marketing COPY (name, tagline, feature
// bullets) lives in i18n under `t.plans.<tier>` (also shared by both surfaces).

export type PlanTier = "starter" | "op_buff" | "full_managed" | "guild_master";
export type BillingCycle = "monthly" | "yearly";

/** free = the always-on free/trial tier · live = buyable now · coming_soon =
 *  not buyable yet (early-access) · enterprise = handled off-site (Spead). */
export type PlanStatus = "free" | "live" | "coming_soon" | "enterprise";
/** What the tier's button does. current = the user's own free tier (no buy). */
export type PlanCta = "current" | "subscribe" | "early_access" | "external";
export type PlanBadge = "popular" | "coming_soon" | "enterprise" | null;

export interface PlanDef {
  tier: PlanTier;
  /** Display order across both shop surfaces (ascending). */
  order: number;
  status: PlanStatus;
  /** Self-serve buyable via the Snap /checkout flow (only op_buff). The
   *  subscription API also rejects non-self-serve tiers. */
  selfServe: boolean;
  /** null = no displayed price (free tier shows "Gratis"; enterprise shows
   *  "Custom" and routes off-site). */
  priceMonthly: number | null;
  priceYearly: number | null;
  ctaKind: PlanCta;
  /** For ctaKind="external" (guild_master → Spead enterprise site). */
  externalUrl?: string;
  highlighted: boolean;
  badge: PlanBadge;
}

export const PLANS: Record<PlanTier, PlanDef> = {
  starter: {
    tier: "starter",
    order: 0,
    status: "free",
    selfServe: false,
    priceMonthly: 0,
    priceYearly: 0,
    ctaKind: "current",
    highlighted: false,
    badge: null,
  },
  op_buff: {
    tier: "op_buff",
    order: 1,
    status: "live",
    selfServe: true,
    priceMonthly: 99_000,
    priceYearly: 990_000,
    ctaKind: "subscribe",
    highlighted: true,
    badge: "popular",
  },
  full_managed: {
    tier: "full_managed",
    order: 2,
    status: "coming_soon",
    selfServe: false,
    priceMonthly: 449_000,
    priceYearly: 4_490_000,
    ctaKind: "early_access",
    highlighted: false,
    badge: "coming_soon",
  },
  guild_master: {
    tier: "guild_master",
    order: 3,
    status: "enterprise",
    selfServe: false,
    // Enterprise = no self-serve price shown; routed to the Spead sales site.
    priceMonthly: null,
    priceYearly: null,
    ctaKind: "external",
    externalUrl: "https://spead.ai",
    highlighted: false,
    badge: "enterprise",
  },
};

/** Catalog in display order — what the shop surfaces map over. */
export const PLANS_ORDERED: PlanDef[] = (Object.values(PLANS) as PlanDef[]).sort(
  (a, b) => a.order - b.order,
);

/** Tiers a user can actually buy via self-serve checkout (currently: OP Buff). */
export const SUBSCRIBABLE_TIERS: PlanTier[] = PLANS_ORDERED.filter(
  (p) => p.selfServe,
).map((p) => p.tier);

export function isSubscribableTier(tier: string): tier is PlanTier {
  return (SUBSCRIBABLE_TIERS as string[]).includes(tier);
}

export function planPrice(tier: PlanTier, cycle: BillingCycle): number {
  const def = PLANS[tier];
  return (cycle === "yearly" ? def.priceYearly : def.priceMonthly) ?? 0;
}

export function formatRp(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

/** Whole months saved by paying yearly vs 12x monthly (e.g. 2). 0 if N/A. */
export function yearlySavingMonths(tier: PlanTier): number {
  const m = PLANS[tier].priceMonthly;
  const y = PLANS[tier].priceYearly;
  if (!m || !y) return 0;
  return Math.max(0, Math.round((m * 12 - y) / m));
}
