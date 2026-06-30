"use client";

/**
 * Active Surface — Zone 5 (2-col grid).
 *
 * Sources (Hermes bridge, same as the dedicated tabs — NOT the legacy `health`
 * RPC which on the Hermes bridge only returns a liveness flag with no channels
 * or agents):
 *   - Channels: REST /api/users/me/dashboard/channels (channels.status, incl.
 *     synthetic multi-account platforms) via useChannelsDashboard().
 *   - Agents:   WS RPC `agents.list` via useAgentsList().
 *
 * Per-row click → navigate ke tab terkait.
 */
import { useRouter } from "next/navigation";
import { ChevronRight, Crown, Plus, Radio, Users } from "lucide-react";
import {
  useChannelsDashboard,
  type ChannelDashboardEntryResponse,
} from "@/hooks/use-api";
import {
  useAgentsList,
  formatAgentLabel,
  type AgentSummary,
} from "@/components/app/channels/use-agents-list";
import { useI18n } from "@/lib/i18n/context";
import { useWorkingAgents, canonAgentId } from "@/lib/app/use-working-agents";
import { cn } from "@/lib/utils";

export function ActiveSurface() {
  const channels = useChannelsDashboard();
  const agents = useAgentsList();

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChannelsPanel
        channels={channels.data?.connectedChannels ?? []}
        loading={channels.isLoading && !channels.data}
      />
      <AgentsPanel
        agents={agents.data?.agents ?? []}
        defaultId={agents.data?.defaultId ?? null}
        loading={agents.isLoading && !agents.data}
      />
    </section>
  );
}

function ChannelsPanel({
  channels,
  loading,
}: {
  channels: ChannelDashboardEntryResponse[];
  loading: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <article className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white/90">
            <Radio className="size-4 text-cyan-300/85" aria-hidden />
            {t.app.overview.activeSurface.channelsTitle}
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-white/45">
            {t.app.overview.activeSurface.channelsDesc}
          </p>
        </div>
      </header>

      {loading ? (
        <SurfaceSkeleton rows={3} />
      ) : channels.length === 0 ? (
        <EmptyCta
          message={t.app.overview.activeSurface.channelsEmpty}
          ctaLabel={t.app.overview.activeSurface.channelsEmptyCta}
          onClick={() => router.push("/app/agents")}
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {channels.map((ch) => {
            const accountCount = ch.summary.totalAccounts;
            const online = ch.summary.onlineAccounts > 0;
            return (
              <li key={ch.channelId}>
                <button
                  type="button"
                  onClick={() => router.push("/app/agents")}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition hover:border-cyan-400/30 hover:bg-white/[0.04]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white/85">
                      {ch.label}
                    </div>
                    {accountCount > 0 ? (
                      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                        {accountCount} {t.app.overview.accountsCount}
                      </div>
                    ) : null}
                  </div>
                  <StatusPill
                    tone={online ? "emerald" : "amber"}
                    label={
                      online
                        ? t.app.overview.statusLinked
                        : t.app.overview.statusConfigured
                    }
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {channels.length > 0 ? (
        <footer className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => router.push("/app/agents")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45 transition hover:bg-white/[0.04] hover:text-white/80"
          >
            {t.app.overview.activeSurface.viewAllChannels}
            <ChevronRight className="size-3" />
          </button>
        </footer>
      ) : null}
    </article>
  );
}

function AgentsPanel({
  agents,
  defaultId,
  loading,
}: {
  agents: AgentSummary[];
  defaultId: string | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { workingAgentIds } = useWorkingAgents();

  return (
    <article className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white/90">
            <Users className="size-4 text-indigo-300/85" aria-hidden />
            {t.app.overview.activeSurface.agentsTitle}
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-white/45">
            {t.app.overview.activeSurface.agentsDesc}
          </p>
        </div>
      </header>

      {loading ? (
        <SurfaceSkeleton rows={3} />
      ) : agents.length === 0 ? (
        <EmptyCta
          message={t.app.overview.activeSurface.agentsEmpty}
          ctaLabel={t.app.overview.activeSurface.agentsEmptyCta}
          onClick={() => router.push("/app/agents")}
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {agents.slice(0, 5).map((a) => {
            const isDefault = a.isDefault === true || a.id === defaultId;
            const modelLabel =
              typeof a.model === "string"
                ? a.model
                : a.model?.primary ?? null;
            // Live: agen ini lagi kerja (web ATAU channel)? Fold default sama
            // seperti hero + Tim Aktif rail supaya konsisten.
            const executing =
              workingAgentIds.has(canonAgentId(a.id)) ||
              (isDefault && workingAgentIds.has("default"));
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/app/agents?focus=${encodeURIComponent(a.id)}`)
                  }
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition hover:border-indigo-400/30 hover:bg-white/[0.04]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white/85">
                        {formatAgentLabel(a, isDefault)}
                      </span>
                      {isDefault ? (
                        <span
                          title={t.app.overview.badgeDefault}
                          aria-label={t.app.overview.badgeDefault}
                          className="inline-flex size-4 shrink-0 items-center justify-center rounded border border-fuchsia-400/40 bg-fuchsia-400/15 text-fuchsia-200"
                        >
                          <Crown className="size-2.5" />
                        </span>
                      ) : null}
                    </div>
                    {modelLabel ? (
                      <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                        {modelLabel}
                      </div>
                    ) : null}
                  </div>
                  {executing ? (
                    <WorkingPill label={t.app.overview.commandCenter.workingBadge} />
                  ) : (
                    <StatusPill
                      tone="emerald"
                      label={t.app.overview.agentReady}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {agents.length > 0 ? (
        <footer className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => router.push("/app/agents")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45 transition hover:bg-white/[0.04] hover:text-white/80"
          >
            {t.app.overview.activeSurface.viewAllAgents}
            <ChevronRight className="size-3" />
          </button>
        </footer>
      ) : null}
    </article>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "emerald" | "amber" | "muted";
  label: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
        tone === "emerald"
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
          : tone === "amber"
            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
            : "border-white/10 bg-white/[0.04] text-white/50",
      )}
    >
      {label}
    </span>
  );
}

function WorkingPill({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-200">
      <span aria-hidden className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400 opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-cyan-300" />
      </span>
      {label}
    </span>
  );
}

function EmptyCta({
  message,
  ctaLabel,
  onClick,
}: {
  message: string;
  ctaLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-6 text-center">
      <p className="text-xs text-white/55">{message}</p>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20"
      >
        <Plus className="size-3" />
        {ctaLabel}
      </button>
    </div>
  );
}

function SurfaceSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {Array.from({ length: rows }).map((_, i) => (
        <li
          key={i}
          className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
        >
          <div className="space-y-1">
            <div className="skeleton h-3 w-28 rounded" aria-hidden />
            <div className="skeleton h-2 w-20 rounded" aria-hidden />
          </div>
          <div className="skeleton h-4 w-16 rounded-full" aria-hidden />
        </li>
      ))}
    </ul>
  );
}
