"use client";

/**
 * AgentRoster — left sidebar list of all agents.
 *
 * Pattern: Notion sidebar / Linear team list. Search at top, list below.
 * Each row shows: emoji/avatar · name · default badge · routed channel
 * count chip. Selected agent gets cyan gradient rail + cyan tint.
 *
 * Responsive: full-width on mobile (hamburger overlay), 280-320px fixed
 * sidebar on md+. AgentsTab orchestrator handles overlay state.
 */
import { Bot, Plus, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { getAgentDisplayName, type AgentRow } from "./helpers";

export function AgentRoster({
  agents,
  defaultId,
  selectedId,
  routedChannelCountByAgent,
  loading,
  onSelect,
  onCreate,
}: {
  agents: AgentRow[];
  defaultId: string;
  selectedId: string | null;
  routedChannelCountByAgent: Map<string, number>;
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "default" | "custom">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter === "default" && a.id !== defaultId) return false;
      if (filter === "custom" && a.id === defaultId) return false;
      if (!q) return true;
      const hay = `${a.id} ${a.identity?.name ?? ""} ${a.name ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, defaultId, filter, query]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-white/[0.06] bg-[#0B0E14]/60 backdrop-blur-xl lg:w-72 xl:w-80">
      {/* Header */}
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
              ✦ Roster
            </div>
            <h2 className="mt-0.5 font-display text-base font-bold text-white">
              Your Agents
            </h2>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#0B0E14] shadow-[0_8px_22px_-8px_rgba(99,102,241,0.55)] transition hover:brightness-110 active:scale-[0.97]"
            aria-label="Create new agent — choose method"
            title="Create new agent — choose method (wizard / full form / duplicate / import)"
          >
            <Plus className="size-3.5" aria-hidden />
            New
          </button>
        </div>

        {/* Search */}
        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/40"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-3 text-[13px] text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
          />
        </div>

        {/* Filter chips */}
        <div className="mt-2 flex gap-1">
          {(
            [
              { id: "all", label: "All" },
              { id: "default", label: "Default" },
              { id: "custom", label: "Custom" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] transition",
                filter === opt.id
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                  : "border-white/10 bg-white/[0.02] text-white/55 hover:border-white/25 hover:text-white/75",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-2">
        {loading && agents.length === 0 ? (
          <div className="space-y-1.5">
            <div className="h-14 animate-pulse rounded-lg bg-white/[0.03]" />
            <div className="h-14 animate-pulse rounded-lg bg-white/[0.03]" />
            <div className="h-14 animate-pulse rounded-lg bg-white/[0.03]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
            {query ? "No results found" : "No agents yet"}
          </div>
        ) : (
          <ul className="space-y-1">
            {filtered.map((agent) => {
              const isDefault = agent.id === defaultId;
              const isSelected = agent.id === selectedId;
              const channelCount = routedChannelCountByAgent.get(agent.id) ?? 0;
              const emoji = agent.identity?.emoji;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(agent.id)}
                    className={cn(
                      "group relative flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition",
                      isSelected
                        ? "border-cyan-400/40 bg-cyan-400/[0.08] shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                        : "border-transparent hover:border-white/10 hover:bg-white/[0.03]",
                    )}
                  >
                    {/* Gradient rail */}
                    <span
                      className={cn(
                        "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full transition",
                        isSelected
                          ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                          : "bg-transparent group-hover:bg-cyan-400/40",
                      )}
                    />
                    {/* Avatar */}
                    <div
                      className={cn(
                        "ml-1 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border transition",
                        isSelected
                          ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                          : "border-white/10 bg-white/[0.04]",
                      )}
                    >
                      {emoji ? (
                        <span className="text-base">{emoji}</span>
                      ) : (
                        <Bot
                          className={cn(
                            "size-4",
                            isSelected ? "text-cyan-200" : "text-white/55",
                          )}
                          aria-hidden
                        />
                      )}
                    </div>
                    {/* Name + meta */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-[13px] font-semibold",
                            isSelected ? "text-cyan-50" : "text-white/90",
                          )}
                        >
                          {getAgentDisplayName(agent)}
                        </span>
                        {isDefault ? (
                          <Star
                            className="size-3 shrink-0 fill-cyan-300 text-cyan-300"
                            aria-label="Default"
                          />
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                        <span className="truncate normal-case tracking-normal">
                          {agent.id}
                        </span>
                        {channelCount > 0 ? (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-cyan-400/25 bg-cyan-400/[0.06] px-1.5 py-0 text-[9px] text-cyan-200/85">
                            {channelCount} channel{channelCount !== 1 ? "s" : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
