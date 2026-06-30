"use client";

/**
 * Today Stats — Zone 2.
 *
 * 4 cards horizontal: Task Carry · Energy Pakai · Saluran Aktif · Tim Standby.
 * Each card click → navigate ke tab terkait. Trend % vs kemarin di footer.
 *
 * UX:
 * - 2x2 grid di mobile, 4x1 di desktop
 * - Loading: skeleton card
 * - Engine offline: angka tetap render (cached) + warn "stale" footer
 * - Fresh start (yesterday null): tampilkan label "Baru mulai" instead of trend %
 */
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Activity, CalendarRange, Radio, Users } from "lucide-react";
import {
  useTodayStats,
  type TodayMetricResponse,
} from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { formatNumber, formatTrendPct } from "./helpers";
import { cn } from "@/lib/utils";

export function TodayStats() {
  const { t } = useI18n();
  const { data, isLoading } = useTodayStats();

  if (isLoading || !data) {
    return <TodayStatsSkeleton />;
  }

  return (
    <section aria-label={t.app.overview.todayStats.sectionTitle}>
      <SectionEyebrow>{t.app.overview.todayStats.sectionTitle}</SectionEyebrow>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          icon={<Activity className="size-4" />}
          accentClass="from-cyan-400/15 to-cyan-500/5 border-cyan-400/25"
          label={t.app.overview.todayStats.taskCarry}
          hint={t.app.overview.todayStats.taskCarryHint}
          metric={data.taskCarry}
          unit=""
          href="/app/sessions"
          engineLive={data.engineLive}
        />
        {/* Carry 7 hari — metrik momentum nyata, ganti kartu Energy mati.
            Energy balik nanti sebagai surface sendiri (EnergyTeaserStrip).
            Redesign 2026-06-10. */}
        <StatCard
          icon={<CalendarRange className="size-4" />}
          accentClass="from-fuchsia-400/15 to-fuchsia-500/5 border-fuchsia-400/25"
          label={t.app.overview.todayStats.weekCarryLabel}
          hint={t.app.overview.todayStats.weekCarryHint}
          metric={{
            today: data.weekCarry,
            yesterday: null,
            trendPct: null,
            isFreshStart: false,
          }}
          unit=""
          href="/app/sessions"
          engineLive={data.engineLive}
        />
        <StatCard
          icon={<Radio className="size-4" />}
          accentClass="from-emerald-400/15 to-emerald-500/5 border-emerald-400/25"
          label={t.app.overview.todayStats.channelsLabel}
          hint={t.app.overview.todayStats.channelsHint}
          metric={{
            today: data.channels.active,
            yesterday: data.channels.totalConfigured,
            trendPct: null,
            isFreshStart: false,
          }}
          unit={`/ ${data.channels.totalConfigured}`}
          href="/app/agents"
          engineLive={data.engineLive}
          forceFooter={
            data.channels.activeIds.length > 0
              ? data.channels.activeIds.slice(0, 3).join(" · ").toUpperCase()
              : undefined
          }
        />
        <StatCard
          icon={<Users className="size-4" />}
          accentClass="from-indigo-400/15 to-indigo-500/5 border-indigo-400/25"
          label={t.app.overview.todayStats.agentsLabel}
          hint={t.app.overview.todayStats.agentsHint}
          metric={{
            today: data.agents.standby,
            yesterday: data.agents.total,
            trendPct: null,
            isFreshStart: false,
          }}
          unit={`/ ${data.agents.total}`}
          href="/app/agents"
          engineLive={data.engineLive}
        />
      </div>

      {!data.engineLive ? (
        <p className="mt-2 text-[11px] text-amber-300/75">
          {t.app.overview.todayStats.offlineHint}
        </p>
      ) : null}
    </section>
  );
}

function StatCard({
  icon,
  accentClass,
  label,
  hint,
  metric,
  unit,
  href,
  engineLive,
  forceFooter,
}: {
  icon: ReactNode;
  accentClass: string;
  label: string;
  hint: string;
  metric: TodayMetricResponse;
  unit: string;
  href: string;
  engineLive: boolean;
  forceFooter?: string;
}) {
  const router = useRouter();
  const { t } = useI18n();

  const trend = metric.trendPct != null || metric.isFreshStart
    ? formatTrendPct(metric.trendPct, t)
    : null;

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className={cn(
        "group relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-gradient-to-br p-4 text-left transition-all",
        "hover:border-cyan-400/40 hover:bg-white/[0.04] hover:shadow-[0_8px_28px_-12px_rgba(34,211,238,0.45)]",
        accentClass,
        !engineLive && "opacity-80",
      )}
    >
      <div className="flex items-center gap-2 text-white/60">
        <span className="opacity-80">{icon}</span>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">
          {label}
        </span>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">
          {formatNumber(metric.today)}
        </span>
        {unit ? (
          <span className="text-sm font-medium text-white/45">{unit}</span>
        ) : null}
      </div>

      {/* Footer: trend pct or forced text or hint fallback */}
      <div className="text-[11px] leading-snug">
        {forceFooter ? (
          <span className="font-mono uppercase tracking-[0.14em] text-white/45">
            {forceFooter}
          </span>
        ) : trend ? (
          <span
            className={cn(
              "font-medium",
              trend.tone === "up"
                ? "text-emerald-300/90"
                : trend.tone === "down"
                  ? "text-red-300/90"
                  : "text-white/50",
            )}
          >
            {trend.tone === "up" ? "↑ " : trend.tone === "down" ? "↓ " : ""}
            {trend.label}
          </span>
        ) : (
          <span className="text-white/40">{hint}</span>
        )}
      </div>
    </button>
  );
}

function TodayStatsSkeleton() {
  return (
    <section>
      <SectionEyebrow>—</SectionEyebrow>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
          >
            <div className="flex items-center gap-2">
              <div className="skeleton size-4 rounded" aria-hidden />
              <div className="skeleton h-3 w-20 rounded" aria-hidden />
            </div>
            <div className="skeleton h-8 w-24 rounded" aria-hidden />
            <div className="skeleton h-3 w-32 rounded" aria-hidden />
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
      {children}
    </span>
  );
}
