"use client";

/**
 * Command Center Hero — Zone 1 (focal point).
 *
 * Menggantikan tiga komponen lama (GreetingBar + EnergyHero + EngineHealthStrip)
 * dengan satu kartu hero hidup. Alasan: EnergyHero adalah focal point terbesar
 * dashboard tapi isinya cuma teaser "Segera Hadir" (energy OFF di fase BYOK),
 * jadi prime real-estate terbuang. Hero baru menjawab dalam satu pandang:
 * engine nyala? tim siap? ada yang lagi kerja SEKARANG (web/channel)? hari ini
 * udah carry berapa?
 *
 * Data (semua REAL, tanpa RPC baru):
 * - profile.nickname + subscription.tier → identitas (salam + tier badge)
 * - store.status + store.engineSnapshot → status engine + uptime live
 * - agents.list (useAgentsList) → jumlah agen siap
 * - useWorkingAgents → jumlah agen yang lagi kerja real-time (web ATAU channel)
 * - today-stats.taskCarry.today → headline ROI "carry N task hari ini"
 *
 * Motion: pulse "lagi gaspol" hanya muncul saat ada turn berjalan; dimatikan
 * via motion-reduce untuk aksesibilitas.
 */
import { Castle, ChevronRight, Crown, Sparkles, Zap } from "lucide-react";
import { useProfile, useSubscriptionState, useTodayStats } from "@/hooks/use-api";
import { useAgentsList } from "@/components/app/channels/use-agents-list";
import { useWorkingAgents } from "@/lib/app/use-working-agents";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { buildGreetingText, formatUptimeShort, resolveGreeting } from "./helpers";
import { cn } from "@/lib/utils";

export function CommandCenterHero() {
  const { t } = useI18n();
  const cc = t.app.overview.commandCenter;

  const profileQ = useProfile();
  const status = useAppStore((s) => s.status);
  const engineSnap = useAppStore((s) => s.engineSnapshot);
  const agents = useAgentsList();
  const { workingAgentIds } = useWorkingAgents();
  const statsQ = useTodayStats();

  const nickname = profileQ.data?.profile?.nickname ?? null;
  const greetingText = buildGreetingText(resolveGreeting(), nickname, t);

  const isOnline = status === "ready";
  const engineTone =
    status === "ready" ? "emerald" : status === "reconnecting" ? "amber" : "red";
  const engineLabel = isOnline
    ? cc.engineOnline
    : status === "reconnecting"
      ? cc.engineReconnecting
      : cc.engineOffline;

  const liveUptimeMs = engineSnap?.uptimeMs
    ? engineSnap.uptimeMs +
      Math.max(0, Date.now() - new Date(engineSnap.receivedAt).getTime())
    : null;

  const totalAgents = agents.data?.agents?.length ?? 0;
  const workingCount = workingAgentIds.size;
  const carry = statsQ.data?.taskCarry?.today ?? 0;

  return (
    <section
      aria-label={cc.eyebrow}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/[0.07] via-[#0B0E14]/85 to-[#0B0E14]/85 p-5 backdrop-blur-xl sm:p-6"
    >
      {/* Layered atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -top-24 size-[320px] rounded-full blur-[130px]"
        style={{ background: "radial-gradient(closest-side, rgba(34,211,238,0.22), transparent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-28 -right-20 size-[360px] rounded-full blur-[150px]"
        style={{ background: "radial-gradient(closest-side, rgba(217,70,239,0.16), transparent)" }}
      />

      <div className="relative flex flex-col gap-5">
        {/* Row 1 — identity */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-300/70">
              {cc.eyebrow}
            </span>
            {profileQ.isLoading ? (
              <div className="skeleton mt-1.5 h-7 w-64 rounded" aria-hidden />
            ) : (
              <h1 className="mt-1 font-display text-xl font-semibold text-white/95 sm:text-2xl">
                {greetingText}
              </h1>
            )}
          </div>
          <TierBadge />
        </div>

        {/* Row 2 — live ops status */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Engine status */}
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#0B0E14]/60 px-3 py-1.5 backdrop-blur-md">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                engineTone === "emerald"
                  ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]"
                  : engineTone === "amber"
                    ? "animate-pulse bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)] motion-reduce:animate-none"
                    : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.7)]",
              )}
            />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/85">
              {engineLabel}
            </span>
            {liveUptimeMs != null ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                · {cc.uptimePrefix} {formatUptimeShort(liveUptimeMs)}
              </span>
            ) : null}
          </span>

          {/* Team status */}
          <span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/25 bg-indigo-400/[0.06] px-3 py-1.5 backdrop-blur-md">
            <span className="font-mono text-[11px] font-bold text-white/85">
              {totalAgents}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              {cc.teamReady}
            </span>
          </span>

          {/* Working-now pulse — only when something is actually running */}
          {workingCount > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/[0.08] px-3 py-1.5 backdrop-blur-md">
              <span aria-hidden className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
              </span>
              <span className="font-mono text-[11px] font-bold text-cyan-200">
                {workingCount}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
                {cc.teamWorking}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
              {cc.idleHeadline}
            </span>
          )}
        </div>

        {/* Row 3 — carry headline (ROI) */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {carry > 0 ? (
              <p className="text-sm leading-relaxed text-white/60 sm:text-base">
                {cc.carryPrefix}{" "}
                <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-400 bg-clip-text font-display text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
                  {carry}
                </span>{" "}
                {cc.carryUnit}.
              </p>
            ) : (
              <div>
                <p className="font-display text-lg font-bold text-white/90 sm:text-xl">
                  {cc.carryZeroHeadline}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-white/50">
                  {cc.carryZeroSub}
                </p>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (typeof document === "undefined") return;
              const el = document.getElementById("detail-engine");
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
              if (el instanceof HTMLDetailsElement) el.open = true;
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45 transition hover:bg-white/[0.04] hover:text-white/80"
          >
            <Zap className="size-3" aria-hidden />
            {cc.detailCta}
            <ChevronRight className="size-3" />
          </button>
        </div>
      </div>
    </section>
  );
}

function TierBadge() {
  const { t } = useI18n();
  const subQ = useSubscriptionState();
  const sub = subQ.data;

  if (subQ.isLoading) {
    return <div className="skeleton h-8 w-36 rounded-full" aria-hidden />;
  }
  if (!sub) return null;

  const isGuild = sub.tier === "guild_master";
  const isOpBuff = sub.tier === "op_buff";

  const cfg = isGuild
    ? {
        Icon: Castle,
        label: t.app.overview.tier.guildMaster,
        gradient: "from-amber-400 to-orange-500",
        border: "border-amber-400/40",
      }
    : isOpBuff
      ? {
          Icon: Crown,
          label: t.app.overview.tier.opBuff,
          gradient: "from-cyan-400 to-violet-500",
          border: "border-cyan-400/40",
        }
      : {
          Icon: Sparkles,
          label: t.app.overview.tier.starter,
          gradient: "from-slate-500 to-slate-600",
          border: "border-white/10",
        };

  const Icon = cfg.Icon;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 self-start rounded-full border bg-[#0B0E14]/60 px-3 py-1.5 backdrop-blur-md",
        cfg.border,
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[#0B0E14]",
          cfg.gradient,
        )}
      >
        <Icon className="size-3" strokeWidth={2.5} />
      </span>
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-white/90">
        {cfg.label}
      </span>
    </div>
  );
}
