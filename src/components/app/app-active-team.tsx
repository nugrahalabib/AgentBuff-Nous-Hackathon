"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Link2, Plus, Bot, Cpu, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useAppStore } from "@/lib/app/store";
import { useAgentsList } from "@/components/app/agents/use-agents-data";
import { useChannelsDashboard } from "@/hooks/use-api";
import { profileFromAgent } from "@/components/app/agents/agent-profile";
import { useWorkingAgents, canonAgentId } from "@/lib/app/use-working-agents";
import { cn } from "@/lib/utils";

// REAL "Tim Aktif" right-rail. Data sources (no mock):
// - Agent roster = `agents.list` RPC (useAgentsList) → real agents the chief
//   created in /app/agents, with their identity (name/emoji/theme), model and
//   description.
// - Channel routing = `useChannelsDashboard` → per-agent channel list, derived
//   from each account's `routedAgentId` (falls back to the default agent).
// - Runtime status = derived from the store:
//     • container/gateway status !== "ready" → all offline
//     • the agent owning the ACTIVE session while it streams → "executing"
//     • everyone else → "standby" (online)

export function AppActiveTeam() {
  const { t } = useI18n();
  const tt = t.basecamp.activeTeam;
  const router = useRouter();

  const agentsQuery = useAgentsList();
  const channelsQuery = useChannelsDashboard();

  const status = useAppStore((s) => s.status);
  const agentFilter = useAppStore((s) => s.activeAgentFilter);
  const setAgentFilter = useAppStore((s) => s.setAgentFilter);
  // Feature C: agents working on ANY surface — a live web turn (streaming /
  // sending) OR a channel turn (Telegram / WhatsApp / …) that never streams to
  // /app but is reported via the bridge `sessions.activity` watcher. Drives the
  // per-card "executing" glow so the rail stays in sync with reality off-web.
  const { workingAgentIds } = useWorkingAgents();

  const ready = status === "ready";
  const agents = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data],
  );
  const defaultId = agentsQuery.data?.defaultId ?? "";

  // agentId → set of channel labels it routes. TWO sources, both required:
  //  1. connectedChannels — root/native accounts + the DEFAULT agent's
  //     synthetic accounts (channels-service merges those in, tagged with
  //     routedAgentId).
  //  2. dash.profiles — NAMED agents' synthetic accounts (e.g. Kak Tutor's
  //     own Telegram bot) live ONLY here, never in connectedChannels.
  //     Without this loop the card showed "Belum ada channel" for an agent
  //     that demonstrably had a running bot (chief bug report 2026-06-11).
  const channelsByAgent = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const dash = channelsQuery.data;
    if (!dash) return map;
    const add = (agentId: string, label: string) => {
      if (!agentId) return;
      if (!map.has(agentId)) map.set(agentId, new Set());
      map.get(agentId)!.add(label);
    };
    for (const ch of dash.connectedChannels) {
      for (const acc of ch.accounts) {
        add(acc.routedAgentId ?? defaultId, ch.label);
      }
    }
    for (const [profileId, snap] of Object.entries(dash.profiles ?? {})) {
      // The bridge keys the house agent as the "default" sentinel; agents.list
      // reports its real id via defaultId — fold so the card lookup matches.
      const effective = profileId === "default" ? defaultId : profileId;
      for (const entry of snap.channels) {
        if (entry.accounts.length > 0) add(effective, entry.label);
      }
    }
    return map;
  }, [channelsQuery.data, defaultId]);

  const totalChannels = channelsQuery.data?.totals.channels ?? 0;
  const hasChannels = totalChannels > 0;

  const loading = !agentsQuery.data && agentsQuery.loading;

  return (
    <aside
      className="hidden w-[300px] shrink-0 flex-col gap-3 xl:flex"
      aria-label={tt.title}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-display text-sm font-bold">{tt.title}</h3>
          <p className="mt-0.5 text-[11px] text-white/45">{tt.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/app/agents")}
          className="flex size-7 items-center justify-center rounded-full border border-white/10 text-white/50 transition-colors hover:border-cyan-400/40 hover:text-white"
          aria-label={tt.create}
          title={tt.create}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {ready && !hasChannels ? (
        <motion.button
          type="button"
          onClick={() => router.push("/app/agents#tab=saluran")}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="group relative overflow-hidden rounded-xl border border-amber-400/35 bg-gradient-to-br from-amber-400/10 via-orange-400/5 to-fuchsia-500/10 px-3 py-2.5 text-left transition-all hover:border-amber-400/60 hover:shadow-[0_10px_28px_-10px_rgba(251,191,36,0.45)]"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-400/15 text-amber-200">
              <Link2 className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-bold text-white">
                {tt.linkCta}
              </p>
              <p className="truncate text-[10.5px] text-white/60">
                {tt.offlineHint}
              </p>
            </div>
          </div>
        </motion.button>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {loading ? (
          <>
            <div className="h-[78px] animate-pulse rounded-2xl bg-white/[0.03]" />
            <div className="h-[78px] animate-pulse rounded-2xl bg-white/[0.03]" />
            <div className="h-[78px] animate-pulse rounded-2xl bg-white/[0.03]" />
          </>
        ) : agents.length === 0 ? (
          <button
            type="button"
            onClick={() => router.push("/app/agents")}
            className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-[11.5px] text-white/50 transition hover:border-cyan-400/30 hover:text-white/70"
          >
            {tt.empty}
          </button>
        ) : (
          agents.map((agent, i) => {
            const profile = profileFromAgent(agent, i, agent.id === defaultId);
            const offline = !ready;
            // Feature C: lights when THIS agent is working on ANY surface — a
            // live web turn OR a channel turn reported by the bridge
            // sessions.activity watcher. The default agent is special-cased
            // because its session keys fold to the "default" sentinel
            // regardless of its real profile id.
            const executing =
              !offline &&
              (workingAgentIds.has(canonAgentId(agent.id)) ||
                (agent.id === defaultId && workingAgentIds.has("default")));
            // Feature B: canonical filter id. The house agent always filters
            // as "default" (its session keys fold to that sentinel), so the
            // sidebar match stays a plain equality regardless of the real
            // default profile id reported by agents.list.
            const filterId =
              agent.id === defaultId ? "default" : canonAgentId(agent.id);
            // cyan "selected" state (distinct from the fuchsia executing glow);
            // clicking filters the sidebar to this agent, clicking again clears.
            const selected = agentFilter === filterId;
            const gradient = profile.gradient;
            const emoji = profile.emoji;
            const chans = channelsByAgent.get(agent.id);
            // Model the agent runs on (model.primary from agents.list). Strip a
            // provider prefix ("google/gemini-2.5-flash" → "gemini-2.5-flash")
            // so the narrow card shows a clean id.
            const rawModel = agent.model?.primary?.trim();
            const modelLabel = rawModel
              ? rawModel.includes("/")
                ? rawModel.split("/").pop() || rawModel
                : rawModel
              : null;
            // Feature A: uniform meta — ALWAYS compute BOTH the skill count and
            // the bound channels so every card renders the same shape (the old
            // ternary showed one XOR the other, making cards look different).
            const channelLabel =
              chans && chans.size > 0 ? [...chans].join(" · ") : tt.noChannel;
            const skillLabel = `${agent.skillCount ?? 0} skill`;

            return (
              <motion.div
                key={agent.id}
                layout
                animate={{ opacity: offline ? 0.55 : 1 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${selected ? tt.filterClear : tt.filterBy}: ${profile.name}`}
                onClick={() => setAgentFilter(selected ? null : filterId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setAgentFilter(selected ? null : filterId);
                  }
                }}
                className={cn(
                  "group relative cursor-pointer overflow-hidden rounded-2xl border p-3.5 outline-none transition-all",
                  "focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                  offline
                    ? "border-white/5 bg-white/[0.02]"
                    : executing
                      ? "border-fuchsia-400/40 bg-fuchsia-500/[0.06] shadow-[0_0_0_3px_rgba(217,70,239,0.08),0_18px_44px_-14px_rgba(217,70,239,0.35)]"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]",
                  selected && "ring-2 ring-cyan-400/55",
                )}
              >
                {executing ? <AnimatedBorder /> : null}

                <div className="relative flex items-center gap-3">
                  <div className="relative shrink-0">
                    <div
                      aria-hidden
                      className={cn(
                        "absolute inset-0 rounded-full bg-gradient-to-br blur-md transition-opacity",
                        gradient,
                        offline
                          ? "opacity-10"
                          : executing
                            ? "opacity-90"
                            : "opacity-60",
                      )}
                    />
                    <div
                      className={cn(
                        "relative flex size-11 items-center justify-center overflow-hidden rounded-full border-2 font-display text-sm font-bold text-[#0B0E14] transition-all",
                        profile.avatarUrl ? "bg-[#0B0E14]" : "bg-gradient-to-br " + gradient,
                        offline ? "border-white/5 grayscale-[70%]" : "border-white/10",
                      )}
                    >
                      {profile.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={profile.avatarUrl}
                          alt={profile.name}
                          className="size-full object-cover"
                        />
                      ) : emoji ? (
                        <span className="text-lg">{emoji}</span>
                      ) : (
                        profile.name[0]?.toUpperCase() ?? (
                          <Bot className="size-4" />
                        )
                      )}
                    </div>
                    {executing ? (
                      <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-75" />
                        <motion.span
                          className="relative flex size-3.5 items-center justify-center rounded-full border-[2px] border-[#0B0E14] bg-fuchsia-500"
                          animate={{ rotate: 360 }}
                          transition={{
                            duration: 1.2,
                            repeat: Infinity,
                            ease: "linear",
                          }}
                        >
                          <span className="size-1 rounded-full bg-white" />
                        </motion.span>
                      </span>
                    ) : (
                      <motion.span
                        key={offline ? "off" : "on"}
                        initial={{ scale: 0.6 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 320, damping: 18 }}
                        className={cn(
                          "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-[#0B0E14]",
                          offline
                            ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]"
                            : "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.85)]",
                        )}
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p
                        className={cn(
                          "truncate text-sm font-semibold",
                          offline && "text-white/60",
                        )}
                      >
                        {profile.name}
                      </p>
                      {agent.id === defaultId ? (
                        <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0 font-mono text-[8px] font-bold uppercase tracking-[0.12em] text-cyan-200">
                          Utama
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-[11px] text-white/50">
                      {profile.role}
                    </p>
                    {modelLabel ? (
                      <div className="mt-1 flex items-center gap-1">
                        <Cpu
                          className={cn(
                            "size-3 shrink-0",
                            offline ? "text-white/30" : "text-indigo-300/70",
                          )}
                        />
                        <span
                          className={cn(
                            "truncate font-mono text-[10px] tracking-tight",
                            offline ? "text-white/35" : "text-indigo-200/75",
                          )}
                          title={rawModel ?? undefined}
                        >
                          {modelLabel}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Feature A: uniform meta strip — every card shows BOTH the
                    skill count AND the bound channels, same shape always. */}
                <div className="relative mt-3 flex items-center gap-2 text-[10px]">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1",
                      offline ? "text-white/30" : "text-amber-200/70",
                    )}
                    title={skillLabel}
                  >
                    <Sparkles className="size-3 shrink-0" />
                    <span>{skillLabel}</span>
                  </span>
                  <span aria-hidden className="text-white/15">
                    ·
                  </span>
                  <span
                    className={cn(
                      "inline-flex min-w-0 flex-1 items-center gap-1",
                      offline ? "text-white/30" : "text-cyan-200/65",
                    )}
                    title={channelLabel}
                  >
                    <Link2 className="size-3 shrink-0" />
                    <span className="truncate">{channelLabel}</span>
                  </span>
                </div>

                {/* status pill */}
                <div className="relative mt-2 flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
                      offline
                        ? "text-red-300/90"
                        : executing
                          ? "text-fuchsia-300"
                          : "text-emerald-300/85",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        offline
                          ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]"
                          : executing
                            ? "bg-fuchsia-400 shadow-[0_0_6px_rgba(217,70,239,0.7)]"
                            : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]",
                      )}
                    />
                    {offline ? tt.offline : executing ? tt.executing : tt.standby}
                  </span>
                </div>
              </motion.div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function AnimatedBorder() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-2xl"
      style={{
        background:
          "conic-gradient(from 0deg, rgba(217,70,239,0.45), rgba(99,102,241,0), rgba(34,211,238,0.35), rgba(99,102,241,0), rgba(217,70,239,0.45))",
        WebkitMask:
          "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
        WebkitMaskComposite: "xor",
        maskComposite: "exclude",
        padding: 1,
      }}
      animate={{ rotate: 360 }}
      transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
    />
  );
}
