"use client";

/**
 * Overview Tab — "Ringkasan" / Markas surface untuk /app/overview.
 *
 * Redesign 2026-06-10: focal point lama (EnergyHero "Segera Hadir") mati di
 * fase BYOK, jadi prime real-estate terbuang + tab terasa hampar. Sekarang:
 *
 *   Zone 1: Command Center Hero (salam + tier + status engine + live working
 *           pulse + carry ROI) — satu kartu hidup, focal point sesungguhnya.
 *   Zone 2: Today's Impact (4 stat REAL: Carry hari ini · Carry 7 hari ·
 *           Saluran · Tim — tanpa kartu "Segera Hadir").
 *   Zone 3: Attention (conditional — hide kalau zero).
 *   Zone 4: Quick Actions.
 *   Zone 5: Active Surface (channels + agents grid; agen ber-pulse saat kerja).
 *   Zone 6: Recent Activity (timeline sessions + cron).
 *   Zone 7: Energy teaser strip (non-dominant) + Detail Engine (collapsible).
 *
 * Sumber data (semua REAL, lihat masing-masing sub-komponen):
 * - REST /api/users/me/{profile,subscription,dashboard/today-stats,dashboard/attention,dashboard/channels}
 * - WS RPC agents.list, sessions.list, cron.list (via useRpc / hooks)
 * - store: status engine + engineSnapshot (uptime/version) + liveSessionIds
 * - useWorkingAgents: agen yang lagi kerja real-time (web ATAU channel)
 *
 * Brand voice: gaming/hustler per CLAUDE.md §10. Energy = skema masa depan
 * (BYOK sekarang) → cuma teaser kecil, bukan focal point.
 */
import { useI18n } from "@/lib/i18n/context";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { ActiveSurface } from "@/components/app/overview/active-surface";
import { AttentionSection } from "@/components/app/overview/attention-section";
import { CommandCenterHero } from "@/components/app/overview/command-center-hero";
import { DetailEngine } from "@/components/app/overview/detail-engine";
import { EnergyTeaserStrip } from "@/components/app/overview/energy-hero";
import { QuickActions } from "@/components/app/overview/quick-actions";
import { RecentActivity } from "@/components/app/overview/recent-activity";
import { TodayStats } from "@/components/app/overview/today-stats";

export function OverviewTab() {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow={t.app.overview.eyebrow}
        title={t.app.overview.title}
        subtitle={t.app.overview.subtitle}
      />

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          {/* Zone 1 — Command Center (focal point) */}
          <CommandCenterHero />

          {/* Zone 2 — Today's Impact */}
          <TodayStats />

          {/* Zone 3 — Attention (conditional) */}
          <AttentionSection />

          {/* Zone 4 — Quick Actions */}
          <QuickActions />

          {/* Zone 5 — Active Surface */}
          <ActiveSurface />

          {/* Zone 6 — Recent Activity */}
          <RecentActivity />

          {/* Zone 7 — Energy teaser (non-dominant) + Detail Engine (collapsed) */}
          <EnergyTeaserStrip />
          <DetailEngine />
        </div>
      </div>
    </div>
  );
}
