// Server-side EFFECTIVE pricing (admin-panel D14). Overlays admin_setting price
// + status overrides onto the static plans.ts catalog. plans.ts stays the
// client-safe DEFAULT/fallback; THIS module is the authoritative price source
// for the charge path (api/billing/subscription) and every server-rendered
// price display + the public /api/pricing feed that client display reads.
//
// MONEY-SAFETY INVARIANT: the price a user is SHOWN must equal the price they
// are CHARGED. Both ends resolve through here (display via /api/pricing, charge
// via resolveEffectivePlanPrice), and the charge route re-confirms against the
// price the client actually displayed (PRICE_CHANGED guard) to close the
// admin-changed-mid-session race.
//
// NOTE: no `import "server-only"` — same constraint as admin/settings.ts: this
// is reachable from the plain-Node tsx worker chain through the billing
// surfaces, and the server-only shim only resolves under Next's bundler.
import {
  PLANS,
  type PlanDef,
  type PlanTier,
  type PlanStatus,
  type BillingCycle,
} from "./plans";
import { resolveSetting } from "@/lib/admin/settings";

const VALID_STATUS: PlanStatus[] = ["free", "live", "coming_soon", "enterprise"];

// Fat-finger ceiling — an override above this is ignored (falls back to the
// catalog price). Rp 100 juta per period is already far beyond any real plan.
export const PRICE_MAX = 100_000_000;

// Tiers whose self-serve price/status an admin may edit. starter (free=0) and
// guild_master (enterprise/off-site=null) carry no editable self-serve price.
export const PRICEABLE_TIERS: PlanTier[] = ["op_buff", "full_managed"];

function sanePrice(v: unknown, fallback: number | null): number | null {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX) return fallback;
  return Math.round(n);
}

function saneStatus(v: unknown, fallback: PlanStatus): PlanStatus {
  return typeof v === "string" && (VALID_STATUS as string[]).includes(v)
    ? (v as PlanStatus)
    : fallback;
}

/** Effective plan = catalog def with admin price/status overrides applied. */
export async function resolveEffectivePlan(tier: PlanTier): Promise<PlanDef> {
  const def = PLANS[tier];
  const [m, y, st] = await Promise.all([
    resolveSetting<number | null>(`pricing.${tier}.monthly`, def.priceMonthly, {}),
    resolveSetting<number | null>(`pricing.${tier}.yearly`, def.priceYearly, {}),
    resolveSetting<string | null>(`pricing.${tier}.status`, null, {}),
  ]);
  return {
    ...def,
    priceMonthly: sanePrice(m, def.priceMonthly),
    priceYearly: sanePrice(y, def.priceYearly),
    status: saneStatus(st, def.status),
  };
}

/** Whole catalog with overrides applied — what the display surfaces map over. */
export async function resolveEffectivePlans(): Promise<
  Record<PlanTier, PlanDef>
> {
  const tiers = Object.keys(PLANS) as PlanTier[];
  const out = {} as Record<PlanTier, PlanDef>;
  await Promise.all(
    tiers.map(async (t) => {
      out[t] = await resolveEffectivePlan(t);
    }),
  );
  return out;
}

/** Authoritative charge price for a tier+cycle (admin override > catalog). */
export async function resolveEffectivePlanPrice(
  tier: PlanTier,
  cycle: BillingCycle,
): Promise<number> {
  const def = await resolveEffectivePlan(tier);
  return (cycle === "yearly" ? def.priceYearly : def.priceMonthly) ?? 0;
}

/**
 * Is this tier buyable via self-serve checkout RIGHT NOW? Requires BOTH the
 * catalog selfServe flag (only op_buff has the settle/zod path — defense in
 * depth even if a status override says otherwise) AND the effective status being
 * "live" — so an admin can PAUSE op_buff sales by flipping its status to
 * coming_soon, with no code change.
 */
export async function isTierBuyable(tier: PlanTier): Promise<boolean> {
  if (!PLANS[tier].selfServe) return false;
  const def = await resolveEffectivePlan(tier);
  return def.status === "live";
}
