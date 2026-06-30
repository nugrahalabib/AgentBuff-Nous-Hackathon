/**
 * Subscription Resolver — single source of truth untuk "tier efektif" user.
 *
 * Production rationale:
 * 1. User bisa punya MULTIPLE row di `subscription` table sepanjang waktu (renewal,
 *    upgrade Starter→OP Buff, downgrade OP Buff→Starter post-cancel, expired). Endpoint
 *    naive yang ambil row terakhir bisa salah resolve "tier sekarang".
 * 2. Resolver ini encapsulate aturan: row mana yang counts sebagai "active",
 *    apa default kalau belum ada row, kapan tier degrade jadi Starter karena
 *    expired.
 * 3. Surface lain (dashboard, billing, gating middleware, future mobile app)
 *    panggil function yang sama → konsistensi cross-surface.
 * 4. Logic complex (`expiresAt > now AND status === 'active'`) di-test di satu
 *    tempat, bukan tersebar di tiap caller.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

// Tier vocabulary mengikuti CLAUDE.md §10 + dictionary `t.itemShop.tiers`.
// Starter adalah tier default semua user yang belum upgrade.
export type EffectiveTier = "starter" | "op_buff" | "guild_master";

export type SubscriptionState = {
  tier: EffectiveTier;
  /** "active" = subscription row aktif. "starter_default" = belum pernah upgrade. */
  status: "active" | "starter_default" | "expired" | "canceled";
  /** ISO string of expiresAt. null untuk starter_default (selamanya). */
  expiresAt: string | null;
  /** Apakah subscription auto-renew. null untuk starter. */
  autoRenew: boolean | null;
  /** Billing cycle aktif: "monthly" | "yearly" | null untuk starter. */
  billingCycle: "monthly" | "yearly" | null;
  /** Harga yang di-lock saat aktif (untuk yearly hemat 2 bulan, dll). null untuk starter. */
  priceRp: number | null;
  /** Apakah expire dalam 7 hari ke depan. UI pakai ini buat alert. */
  isExpiringSoon: boolean;
  /** Hari sampai expire. null untuk starter atau already-expired. */
  daysUntilExpire: number | null;
};

/**
 * Resolve tier efektif user pada saat ini.
 *
 * Order of precedence:
 *   1. Most-recent active row dengan expiresAt > now → that tier.
 *   2. Most-recent expired/canceled row → tier="starter", status reflektif.
 *   3. Tidak ada row sama sekali → tier="starter", status="starter_default".
 *
 * Tidak melempar error untuk DB miss — degrade gracefully ke starter default
 * supaya dashboard tetap bisa render bahkan kalau subscription table baru.
 */
export async function resolveSubscription(userId: string): Promise<SubscriptionState> {
  const now = new Date();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // Ambil row paling baru (createdAt desc) — ini handle case multiple history.
  // LIMIT 1 cukup karena urutan creation = urutan resolve preference.
  const [row] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);

  if (!row) {
    return {
      tier: "starter",
      status: "starter_default",
      expiresAt: null,
      autoRenew: null,
      billingCycle: null,
      priceRp: null,
      isExpiringSoon: false,
      daysUntilExpire: null,
    };
  }

  const expiresAtMs = row.expiresAt.getTime();
  // 'canceled' = user opted out of renewing, but NEVER forfeits paid days: the
  // tier stays effective until expiresAt, then degrades to starter like any
  // lapse (handled by the not-active branch below, which reports 'canceled').
  const isActive =
    (row.status === "active" || row.status === "canceled") &&
    expiresAtMs > now.getTime();

  if (!isActive) {
    // Expired atau canceled → degrade ke starter default tier, tapi pertahankan
    // status reflektif (UI bisa show "subscription expired, renew?" message).
    return {
      tier: "starter",
      status: row.status === "canceled" ? "canceled" : "expired",
      expiresAt: row.expiresAt.toISOString(),
      autoRenew: row.autoRenew,
      billingCycle: row.billingCycle as "monthly" | "yearly",
      priceRp: row.frozenPriceRp ?? row.priceRp,
      isExpiringSoon: false,
      daysUntilExpire: null,
    };
  }

  const msUntilExpire = expiresAtMs - now.getTime();
  const daysUntilExpire = Math.max(0, Math.ceil(msUntilExpire / (24 * 60 * 60 * 1000)));
  const isExpiringSoon = msUntilExpire <= sevenDaysMs && msUntilExpire > 0;

  const tier = normalizeTier(row.tier);

  return {
    tier,
    status: "active",
    expiresAt: row.expiresAt.toISOString(),
    autoRenew: row.autoRenew,
    billingCycle: row.billingCycle as "monthly" | "yearly",
    priceRp: row.frozenPriceRp ?? row.priceRp,
    isExpiringSoon,
    daysUntilExpire,
  };
}

/**
 * Normalize tier string dari DB ke union type. Defensive — kalau DB punya
 * value tak terduga (legacy tier name, typo), fall back ke starter daripada
 * crash. Audit log entry bisa ditambah disini di future kalau perlu trace.
 */
function normalizeTier(raw: string): EffectiveTier {
  const normalized = raw.toLowerCase().replace(/[\s-]/g, "_");
  if (normalized === "op_buff") return "op_buff";
  if (normalized === "guild_master") return "guild_master";
  if (normalized === "starter") return "starter";
  // Fallback untuk legacy values (e.g. "Bisnis", "Pro") — treat sebagai OP Buff
  // karena kemungkinan paid tier dari fase pricing experiment lama. Lebih aman
  // overcredit user daripada degrade silently.
  if (normalized === "bisnis" || normalized === "pro" || normalized === "premium") {
    return "op_buff";
  }
  return "starter";
}

/**
 * Helper: apakah user punya akses ke fitur tier-gated.
 *
 * Pakai ini di middleware atau gate untuk fitur premium (custom skill, multi-channel,
 * dll). Memusatkan logic "boleh akses?" supaya gak di-duplikasi.
 */
export function hasAccessToTier(
  current: EffectiveTier,
  required: EffectiveTier,
): boolean {
  const order: Record<EffectiveTier, number> = {
    starter: 0,
    op_buff: 1,
    guild_master: 2,
  };
  return order[current] >= order[required];
}
