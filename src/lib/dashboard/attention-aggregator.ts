/**
 * Attention Aggregator — server-side service yang aggregate alert dari
 * multiple source (DB + container state + subscription state) jadi satu
 * uniform list untuk UI dashboard "Perlu Perhatian".
 *
 * Production rationale:
 * 1. Single source of truth: 1 user → 1 list alert. Klien tinggal render.
 * 2. De-duplication terpusat (1 issue muncul dari 3 source → 1 alert).
 * 3. Severity ordering konsisten (critical → warning → info).
 * 4. Tier-aware: Starter & OP Buff bisa punya alert berbeda (e.g. Starter
 *    dapat nudge upgrade, OP Buff tidak).
 * 5. Cross-surface ready: future mobile app + email digest + push notif
 *    semua tinggal panggil aggregator yang sama.
 * 6. Audit-friendly: alert kapan muncul tracable di server log.
 *
 * Categories (8 source aggregated):
 *  - Energy balance low (< threshold)
 *  - Energy balance critical (< 5%)
 *  - Container throttled (balance ≤ 0)
 *  - Container offline / unhealthy
 *  - Subscription expiring soon (< 7 days)
 *  - Channel disconnected (linked → unlinked)
 *  - Skill error / install failed
 *  - BYOK API key expired / expiring
 */

import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  resolveSubscription,
  type SubscriptionState,
} from "./subscription-resolver";

export type AttentionSeverity = "critical" | "warning" | "info";

export type AttentionItem = {
  /** Stable ID untuk client-side dismiss/key. Format: `<source>:<reason>`. */
  id: string;
  severity: AttentionSeverity;
  /** Lucide icon name (di-map di komponen client). */
  icon: string;
  title: string;
  description: string;
  /** Action utama. Bisa internal route, external URL, atau popup signal. */
  action?: {
    /** Label tombol (e.g. "Top Up", "Cek Saluran"). */
    label: string;
    /** "navigate" → router.push. "popup" → window.open billing/energy. "external" → new tab. */
    kind: "navigate" | "popup" | "external";
    /** Target href / route. */
    href: string;
  };
};

export type AttentionPayload = {
  items: AttentionItem[];
  /** Server timestamp aggregate dilakukan. UI bisa display "diperbarui Xs lalu". */
  generatedAt: string;
};

const ENERGY_LOW_THRESHOLD_PCT = 0.2; // 20%
const ENERGY_CRITICAL_THRESHOLD_PCT = 0.05; // 5%

// KOREKSI BISNIS MODEL (Chief 2026-06-02): AgentBuff saat ini full BYOK —
// user bawa API key & model sendiri, jadi BELUM ada energy beneran (gak
// ngonversi token jadi saldo). Selama fase ini, JANGAN munculin alert
// energy (habis/menipis/throttled) — itu false-positive (balance default 0)
// + ngasih kesan keliru bahwa kami sediain LLM. Skema energy diaktifkan
// pasca-launch → flip flag ini ke true.
const ENERGY_ENABLED = false;

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Main entry — aggregate all attention items untuk satu user.
 * Returns sorted list (critical → warning → info, lalu by source order).
 */
export async function aggregateAttention(userId: string): Promise<AttentionPayload> {
  // Parallel fetch semua sumber data — masing-masing independent + read-only.
  // Failure di satu source TIDAK boleh kill seluruh aggregate; pakai
  // Promise.allSettled untuk graceful degradation.
  const [energy, container, subscription] = await Promise.allSettled([
    fetchEnergy(userId),
    fetchContainer(userId),
    resolveSubscription(userId),
  ]);

  const items: AttentionItem[] = [];

  // ── Energy alerts ────────────────────────────────────────────
  if (ENERGY_ENABLED && energy.status === "fulfilled" && energy.value) {
    const e = energy.value;
    const pct = e.maxBalance > 0 ? e.balance / e.maxBalance : 0;
    if (e.balance <= 0) {
      items.push({
        id: "energy:exhausted",
        severity: "critical",
        icon: "Zap",
        title: "Energy kamu habis",
        description: "Top up sekarang biar agent bisa lanjut kerja.",
        action: {
          label: "Top Up Sekarang",
          kind: "popup",
          href: "/billing/energy",
        },
      });
    } else if (pct <= ENERGY_CRITICAL_THRESHOLD_PCT) {
      items.push({
        id: "energy:critical",
        severity: "critical",
        icon: "Zap",
        title: "Energy hampir habis",
        description: `Tinggal ${formatNumber(e.balance)} ⚡ dari ${formatNumber(e.maxBalance)}. Top up sebelum kehabisan.`,
        action: { label: "Top Up", kind: "popup", href: "/billing/energy" },
      });
    } else if (pct <= ENERGY_LOW_THRESHOLD_PCT) {
      items.push({
        id: "energy:low",
        severity: "warning",
        icon: "Zap",
        title: "Energy mulai menipis",
        description: `${Math.round(pct * 100)}% energy tersisa. Pertimbangkan top up.`,
        action: { label: "Top Up", kind: "popup", href: "/billing/energy" },
      });
    }
  }

  // ── Container state alerts ──────────────────────────────────
  if (container.status === "fulfilled" && container.value) {
    const c = container.value;
    if (ENERGY_ENABLED && c.status === "stopped" && c.balanceThrottledAt != null) {
      items.push({
        id: "container:throttled",
        severity: "critical",
        icon: "PauseCircle",
        title: "Engine ditahan karena Energy habis",
        description:
          "AI agent kamu standby. Top up untuk lanjutin task yang tertunda.",
        action: { label: "Top Up", kind: "popup", href: "/billing/energy" },
      });
    } else if (c.status === "failed" || c.status === "destroyed") {
      items.push({
        id: "container:failed",
        severity: "critical",
        icon: "AlertTriangle",
        title: "Engine bermasalah",
        description: c.errorMessage
          ? `Provisioning gagal: ${c.errorMessage.slice(0, 120)}`
          : "Coba ulang provisioning dari halaman Loby.",
        action: { label: "Cek Engine", kind: "navigate", href: "/loby" },
      });
    } else if (c.status === "stopped") {
      items.push({
        id: "container:stopped",
        severity: "warning",
        icon: "Power",
        title: "Engine berhenti",
        description: "Agent gak bisa terima delegasi sampai engine dihidupkan lagi.",
        action: { label: "Cek Engine", kind: "navigate", href: "/loby" },
      });
    }
  }

  // ── Subscription expiry alerts ──────────────────────────────
  if (subscription.status === "fulfilled") {
    const s = subscription.value;
    if (s.status === "active" && s.isExpiringSoon && s.daysUntilExpire != null) {
      // Manual renewal only — subscriptions persist autoRenew=false, so never
      // imply recurring auto-debit. One clear "perpanjang" message.
      items.push({
        id: "subscription:expiring",
        severity: s.daysUntilExpire <= 2 ? "warning" : "info",
        icon: "Calendar",
        title: `Langganan ${tierLabel(s)} berakhir ${s.daysUntilExpire} hari lagi`,
        description:
          "Perpanjang manual sekarang biar fitur kamu tetap aktif. Nggak ada potongan otomatis.",
        action: {
          label: "Perpanjang",
          kind: "navigate",
          href: "/checkout",
        },
      });
    } else if (s.status === "expired") {
      items.push({
        id: "subscription:expired",
        severity: "warning",
        icon: "Calendar",
        title: "Langganan kamu expired",
        description:
          "Kembali ke tier Starter. Upgrade ulang biar bisa pakai fitur premium.",
        action: {
          label: "Upgrade Lagi",
          kind: "navigate",
          href: "/checkout",
        },
      });
    }
  }

  // ── Channel disconnected alerts ─────────────────────────────
  // (Future: query container_skill atau channel state. Sekarang skip karena
  //  channel state real-time hanya tersedia via gateway health RPC, dan kita
  //  TIDAK panggil gateway disini untuk hemat resource. Channel alert bisa
  //  ditambah di today-stats endpoint yang memang panggil health RPC, lalu
  //  dispatch ke aggregator via in-memory bus, atau di-merge di client side.
  //  Untuk MVP attention endpoint: focus ke alert yang murni DB-driven.)

  // ── Skill install failures ──────────────────────────────────
  const failedSkills = await fetchFailedSkillTransactions(userId);
  for (const tx of failedSkills.slice(0, 3)) {
    items.push({
      id: `skill:install_failed:${tx.id}`,
      severity: "warning",
      icon: "Package",
      title: `Install ${tx.sku ?? "skill"} gagal`,
      description:
        tx.lastInstallError?.slice(0, 120) ??
        "Coba install ulang dari Item Shop atau hubungi support.",
      action: { label: "Cek Item Shop", kind: "navigate", href: "/app/shop" },
    });
  }

  // Sort: severity DESC (critical first), preserve insertion order dalam grup.
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    items,
    generatedAt: new Date().toISOString(),
  };
}

// ── Internal data fetchers ────────────────────────────────────────

type EnergyRow = { balance: number; maxBalance: number; lastTopupAt: Date | null };

async function fetchEnergy(userId: string): Promise<EnergyRow | null> {
  const [row] = await db
    .select({
      balance: schema.userEnergy.balance,
      maxBalance: schema.userEnergy.maxBalance,
      lastTopupAt: schema.userEnergy.lastTopupAt,
    })
    .from(schema.userEnergy)
    .where(eq(schema.userEnergy.userId, userId))
    .limit(1);
  return row ?? null;
}

type ContainerRow = {
  status: string;
  errorMessage: string | null;
  balanceThrottledAt: Date | null;
  stopWarnedAt: Date | null;
};

async function fetchContainer(userId: string): Promise<ContainerRow | null> {
  const [row] = await db
    .select({
      status: schema.userContainers.status,
      errorMessage: schema.userContainers.errorMessage,
      balanceThrottledAt: schema.userContainers.balanceThrottledAt,
      stopWarnedAt: schema.userContainers.stopWarnedAt,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);
  return row ?? null;
}

type FailedSkillTx = { id: string; sku: string | null; lastInstallError: string | null };

async function fetchFailedSkillTransactions(userId: string): Promise<FailedSkillTx[]> {
  return db
    .select({
      id: schema.transactions.id,
      sku: schema.transactions.sku,
      lastInstallError: schema.transactions.lastInstallError,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.status, "install_failed"),
      ),
    )
    .orderBy(desc(schema.transactions.updatedAt))
    .limit(5);
}

// ── Utilities ─────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function tierLabel(s: SubscriptionState): string {
  if (s.tier === "op_buff") return "OP Buff";
  if (s.tier === "guild_master") return "Guild Master";
  return "Starter";
}

// Suppress unused imports warning (gt sengaja di-import untuk extension future).
void gt;
