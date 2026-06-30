// Verification: prove the D8 CMS overlay AND the D14 pricing override actually
// APPLY end-to-end at the data layer (not just the no-op fallback). Inserts
// throwaway test rows, asserts the resolvers reflect them, then ALWAYS deletes
// them (try/finally). Run: pnpm tsx --env-file=.env.local scripts/verify-overlays.ts
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveCmsOverrides, invalidateCmsCache } from "@/lib/cms/resolve";
import { applyDotPathOverrides, getAtPath } from "@/lib/i18n/apply-overrides";
import { id as idDict } from "@/lib/i18n/dictionaries/id";
import {
  resolveEffectivePlanPrice,
  isTierBuyable,
} from "@/lib/billing/pricing-resolver";
import { invalidateSettingCache } from "@/lib/admin/settings";
import { resolveFlag, invalidateFlagCache } from "@/lib/admin/flags";
import { resolveInstallTarget } from "@/lib/billing/skill-installer";
import { resolveCommissionPct, computeSplit } from "@/lib/admin/commission";
import { applySettlement } from "@/lib/billing/settle";
import {
  validateCoupon,
  computeDiscount,
  reserveCoupon,
  releaseCoupon,
} from "@/lib/billing/coupon";
import {
  resolveEngineDefaults,
  ENGINE_DEFAULT_KEYS,
} from "@/lib/hermes/engine-defaults";
import { hermesConfig } from "@/lib/hermes/config";

const C3_COUPON = "VERIFYC3PROMO";
const C3_ENGINE_MODEL = "verify/model-x9";

const C3_SELLER = "verify-c3-seller";
const C3_RULE_SCOPEID = "verify-c3-seller";
const C3_USER = "verify-c3-user";
const C3_ORDER = "VERIFY-MKT-ORDER-9999";
const C3_LISTING_OK = "verify-c3-listing-ok";
const C3_LISTING_BAD = "verify-c3-listing-bad";
const CMS_KEY = "hero.titleLine1";
const CMS_VAL = "VERIFY_CMS_OVERLAY_12345";
const PRICE_KEY = "pricing.op_buff.monthly";
const PRICE_VAL = 123456;
const STATUS_KEY = "pricing.op_buff.status";
const FLAG_KEY = "maintenance.enabled";
const FLAG_MSG = "VERIFY_MAINT_MSG";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ` (${extra})` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ""}`);
  }
}

async function main() {
  console.log("=== D8 CMS overlay ===");
  const dictDefault = getAtPath(idDict, CMS_KEY);
  console.log(`  dict default hero.titleLine1 = ${JSON.stringify(dictDefault)}`);

  // No-op first: no row -> overrides empty -> dict unchanged.
  invalidateCmsCache();
  const ovEmpty = await resolveCmsOverrides("id");
  check("no-op: override absent before insert", ovEmpty[CMS_KEY] === undefined);

  await db
    .insert(schema.cmsContent)
    .values({ key: CMS_KEY, locale: "id", value: CMS_VAL })
    .onConflictDoUpdate({
      target: [schema.cmsContent.key, schema.cmsContent.locale],
      set: { value: CMS_VAL },
    });

  invalidateCmsCache();
  const ov = await resolveCmsOverrides("id");
  check("resolver returns inserted override", ov[CMS_KEY] === CMS_VAL,
    String(ov[CMS_KEY]));

  const merged = applyDotPathOverrides(idDict, ov);
  check("merged dict node is overridden", getAtPath(merged, CMS_KEY) === CMS_VAL);
  check("base dict NOT mutated", getAtPath(idDict, CMS_KEY) === dictDefault);
  check(
    "sibling node preserved (hero.badge present)",
    getAtPath(merged, "hero.badge") !== undefined,
  );

  console.log("=== D14 pricing override ===");
  invalidateSettingCache();
  const before = await resolveEffectivePlanPrice("op_buff", "monthly");
  console.log(`  effective op_buff/monthly before = ${before}`);

  await db
    .insert(schema.adminSettings)
    .values({ key: PRICE_KEY, scope: "global", scopeId: "", value: PRICE_VAL })
    .onConflictDoUpdate({
      target: [
        schema.adminSettings.key,
        schema.adminSettings.scope,
        schema.adminSettings.scopeId,
      ],
      set: { value: PRICE_VAL },
    });
  invalidateSettingCache();
  const after = await resolveEffectivePlanPrice("op_buff", "monthly");
  check("price override applies to charge resolver", after === PRICE_VAL, String(after));

  // Pause-sales lever: status coming_soon -> not buyable.
  await db
    .insert(schema.adminSettings)
    .values({ key: STATUS_KEY, scope: "global", scopeId: "", value: "coming_soon" })
    .onConflictDoUpdate({
      target: [
        schema.adminSettings.key,
        schema.adminSettings.scope,
        schema.adminSettings.scopeId,
      ],
      set: { value: "coming_soon" },
    });
  invalidateSettingCache();
  check("status=coming_soon makes op_buff NOT buyable", !(await isTierBuyable("op_buff")));

  console.log("=== D13 feature flag (maintenance) ===");
  invalidateFlagCache();
  check("flag absent -> OFF (safe default)", !(await resolveFlag(FLAG_KEY)).enabled);
  await db
    .insert(schema.featureFlags)
    .values({ key: FLAG_KEY, scope: "global", scopeId: "", enabled: true, value: FLAG_MSG })
    .onConflictDoUpdate({
      target: [
        schema.featureFlags.key,
        schema.featureFlags.scope,
        schema.featureFlags.scopeId,
      ],
      set: { enabled: true, value: FLAG_MSG },
    });
  invalidateFlagCache();
  const flag = await resolveFlag(FLAG_KEY);
  check("flag resolves enabled after set", flag.enabled === true);
  check("flag value resolves", flag.value === FLAG_MSG, String(flag.value));

  console.log("=== C3 Phase A install resolver ===");
  await db
    .insert(schema.sellers)
    .values({ id: C3_SELLER, type: "third_party", displayName: "Verify Seller" })
    .onConflictDoNothing();
  await db
    .insert(schema.listings)
    .values({
      id: C3_LISTING_OK,
      sellerId: C3_SELLER,
      kind: "skill",
      slug: "verify-c3-slug",
      title: "Verify Skill",
      priceRp: 5000,
      status: "published",
      installSpec: { type: "clawhub", slug: "verify-c3-slug", version: "1.0.0" },
    })
    .onConflictDoUpdate({
      target: schema.listings.id,
      set: { installSpec: { type: "clawhub", slug: "verify-c3-slug", version: "1.0.0" } },
    });
  await db
    .insert(schema.listings)
    .values({
      id: C3_LISTING_BAD,
      sellerId: C3_SELLER,
      kind: "mcp_app",
      slug: "verify-c3-bad",
      title: "Bad Spec",
      priceRp: 0,
      status: "published",
      installSpec: { type: "mcp_app", command: "x" },
    })
    .onConflictDoUpdate({
      target: schema.listings.id,
      set: { installSpec: { type: "mcp_app", command: "x" } },
    });

  type TxArg = Parameters<typeof resolveInstallTarget>[0];
  const okRes = await resolveInstallTarget({
    id: "verify-tx-ok",
    sku: "verify-c3-slug",
    metadata: { source: "marketplace", listingId: C3_LISTING_OK },
  } as unknown as TxArg);
  check(
    "marketplace clawhub listing resolves to install target",
    okRes.ok &&
      okRes.target.source === "clawhub" &&
      okRes.target.skillKey === "verify-c3-slug" &&
      okRes.target.marketplaceItemId === C3_LISTING_OK,
  );
  const badRes = await resolveInstallTarget({
    id: "verify-tx-bad",
    sku: "x",
    metadata: { source: "marketplace", listingId: C3_LISTING_BAD },
  } as unknown as TxArg);
  check("marketplace mcp_app rejected (unsupported installSpec)", !badRes.ok);
  const missingRes = await resolveInstallTarget({
    id: "verify-tx-missing",
    sku: "x",
    metadata: { source: "marketplace", listingId: "nope-does-not-exist" },
  } as unknown as TxArg);
  check("marketplace missing listing rejected", !missingRes.ok);

  console.log("=== C3 Phase B commission ===");
  // computeSplit math (pure).
  const s1 = computeSplit(10000, 20);
  check("split 10000@20% = 2000/8000", s1.commissionRp === 2000 && s1.netRp === 8000);
  const s2 = computeSplit(333, 20);
  check("split floors commission (333@20% = 66/267)", s2.commissionRp === 66 && s2.netRp === 267);
  const s0 = computeSplit(10000, 0);
  check("split 0% = 0/10000", s0.commissionRp === 0 && s0.netRp === 10000);
  // Precedence.
  check(
    "first_party seller -> 0%",
    (await resolveCommissionPct({ id: "x", type: "first_party", commissionPct: null }, { category: null })) === 0,
  );
  check(
    "explicit seller.commissionPct override",
    (await resolveCommissionPct({ id: "x", type: "third_party", commissionPct: 15 }, { category: null })) === 15,
  );
  check(
    "no override + no rules -> default 20%",
    (await resolveCommissionPct({ id: "verify-c3-norule", type: "third_party", commissionPct: null }, { category: null })) === 20,
  );
  // Seller-scope rule wins over default (use the test scopeId so we never touch
  // a real global rule).
  await db
    .insert(schema.commissionRules)
    .values({ scope: "seller", scopeId: C3_RULE_SCOPEID, pct: 10 })
    .onConflictDoUpdate({
      target: [schema.commissionRules.scope, schema.commissionRules.scopeId],
      set: { pct: 10 },
    });
  check(
    "commission_rule(scope=seller) applies",
    (await resolveCommissionPct({ id: C3_RULE_SCOPEID, type: "third_party", commissionPct: null }, { category: null })) === 10,
  );

  console.log("=== C3 Phase B settle->ledger integration ===");
  // Throwaway user (FK for transaction.userId). seller (C3_SELLER, third_party,
  // 10% via the rule above) + listing (C3_LISTING_OK, priceRp 5000) already
  // seeded. Run the REAL applySettlement and assert the commission split lands.
  await db
    .insert(schema.users)
    .values({ id: C3_USER, email: "verify-c3@example.invalid", name: "Verify C3" })
    .onConflictDoNothing();
  const [tx] = await db
    .insert(schema.transactions)
    .values({
      userId: C3_USER,
      type: "skill-install",
      description: "Verify Skill",
      amountRp: 5000,
      energyDelta: 0,
      status: "pending",
      midtransOrderId: C3_ORDER,
      sku: "verify-c3-slug",
      metadata: { source: "marketplace", listingId: C3_LISTING_OK, sellerId: C3_SELLER },
    })
    .returning({ id: schema.transactions.id });

  await applySettlement(C3_ORDER, "5000", "verify-ref", null);

  const [led] = await db
    .select({
      grossRp: schema.payoutLedger.grossRp,
      commissionRp: schema.payoutLedger.commissionRp,
      netRp: schema.payoutLedger.netRp,
      status: schema.payoutLedger.status,
    })
    .from(schema.payoutLedger)
    .where(eq(schema.payoutLedger.transactionId, tx.id));
  check("settle wrote a payout_ledger row", Boolean(led));
  check(
    "ledger split 5000@10% = 500 commission / 4500 net",
    led?.grossRp === 5000 && led?.commissionRp === 500 && led?.netRp === 4500,
  );
  check("ledger status pending (hold)", led?.status === "pending");

  // Replay the settlement (webhook replay) — must NOT double-credit.
  await applySettlement(C3_ORDER, "5000", "verify-ref", null);
  const dup = await db
    .select({ id: schema.payoutLedger.id })
    .from(schema.payoutLedger)
    .where(eq(schema.payoutLedger.transactionId, tx.id));
  check("replay: still exactly 1 ledger row (idempotent)", dup.length === 1);

  console.log("=== D10/D14 coupon reserve/discount ===");
  // Seed a percent-10 coupon scoped to op_buff, single-use.
  await db
    .insert(schema.coupons)
    .values({
      code: C3_COUPON,
      type: "percent",
      value: 10,
      tierScope: "op_buff",
      maxUses: 1,
      used: 0,
      active: true,
    })
    .onConflictDoUpdate({
      target: schema.coupons.code,
      set: { type: "percent", value: 10, tierScope: "op_buff", maxUses: 1, used: 0, active: true, expiresAt: null },
    });
  const disc = computeDiscount({ type: "percent", value: 10 }, 5000);
  check("discount 10% of 5000 = 500 off / 4500 final", disc.discountRp === 500 && disc.finalRp === 4500);
  const fixedDisc = computeDiscount({ type: "fixed", value: 9999 }, 5000);
  check("fixed discount caps at amount (no negative final)", fixedDisc.discountRp === 5000 && fixedDisc.finalRp === 0);
  const res1 = await reserveCoupon(C3_COUPON, "op_buff");
  check("reserve succeeds, used -> 1", !!res1 && res1.used === 1);
  const res2 = await reserveCoupon(C3_COUPON, "op_buff");
  check("reserve blocked at maxUses (returns null)", res2 === null);
  await releaseCoupon(C3_COUPON);
  const res3 = await reserveCoupon(C3_COUPON, "op_buff");
  check("release frees the slot (reserve again ok)", !!res3);
  await releaseCoupon(C3_COUPON);
  const wrongTier = await validateCoupon(C3_COUPON, "full_managed");
  check("tier-scoped coupon rejected for wrong tier", !wrongTier.ok && wrongTier.error === "TIER_MISMATCH");
  const rightTier = await validateCoupon(C3_COUPON, "op_buff");
  check("valid coupon accepted for matching tier", rightTier.ok === true);

  console.log("=== D6 engine defaults per tier ===");
  // No override yet -> resolves to the env-backed config default.
  const baseEd = await resolveEngineDefaults("op_buff");
  check(
    "engine model with no override = config default",
    baseEd.model === hermesConfig.defaultModel,
    baseEd.model,
  );
  // Insert a per-tier model override for op_buff only.
  await db
    .insert(schema.adminSettings)
    .values({
      key: ENGINE_DEFAULT_KEYS.model,
      scope: "tier",
      scopeId: "op_buff",
      value: C3_ENGINE_MODEL,
    })
    .onConflictDoUpdate({
      target: [schema.adminSettings.key, schema.adminSettings.scope, schema.adminSettings.scopeId],
      set: { value: C3_ENGINE_MODEL },
    });
  invalidateSettingCache();
  const opEd = await resolveEngineDefaults("op_buff");
  check("op_buff model override applies", opEd.model === C3_ENGINE_MODEL, opEd.model);
  const starterEd = await resolveEngineDefaults("starter");
  check(
    "other tier (starter) NOT affected by op_buff override",
    starterEd.model === hermesConfig.defaultModel,
    starterEd.model,
  );
}

async function cleanup() {
  await db.delete(schema.coupons).where(eq(schema.coupons.code, C3_COUPON));
  await db
    .delete(schema.adminSettings)
    .where(
      and(
        eq(schema.adminSettings.key, ENGINE_DEFAULT_KEYS.model),
        eq(schema.adminSettings.scope, "tier"),
        eq(schema.adminSettings.scopeId, "op_buff"),
      ),
    );
  await db
    .delete(schema.cmsContent)
    .where(and(eq(schema.cmsContent.key, CMS_KEY), eq(schema.cmsContent.locale, "id")));
  for (const k of [PRICE_KEY, STATUS_KEY]) {
    await db
      .delete(schema.adminSettings)
      .where(
        and(
          eq(schema.adminSettings.key, k),
          eq(schema.adminSettings.scope, "global"),
          eq(schema.adminSettings.scopeId, ""),
        ),
      );
  }
  await db
    .delete(schema.featureFlags)
    .where(
      and(
        eq(schema.featureFlags.key, FLAG_KEY),
        eq(schema.featureFlags.scope, "global"),
        eq(schema.featureFlags.scopeId, ""),
      ),
    );
  // Settle-integration rows first (ledger -> tx -> user FK order).
  await db.delete(schema.payoutLedger).where(eq(schema.payoutLedger.sellerId, C3_SELLER));
  await db.delete(schema.transactions).where(eq(schema.transactions.midtransOrderId, C3_ORDER));
  for (const lid of [C3_LISTING_OK, C3_LISTING_BAD]) {
    await db.delete(schema.listings).where(eq(schema.listings.id, lid));
  }
  await db.delete(schema.sellers).where(eq(schema.sellers.id, C3_SELLER));
  await db.delete(schema.users).where(eq(schema.users.id, C3_USER));
  await db
    .delete(schema.commissionRules)
    .where(
      and(
        eq(schema.commissionRules.scope, "seller"),
        eq(schema.commissionRules.scopeId, C3_RULE_SCOPEID),
      ),
    );
  invalidateCmsCache();
  invalidateSettingCache();
  invalidateFlagCache();
  console.log("  cleanup: test rows deleted");
}

main()
  .catch((e) => {
    fail++;
    console.error("ERROR", e);
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
