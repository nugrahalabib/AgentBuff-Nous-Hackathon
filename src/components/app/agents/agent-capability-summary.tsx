"use client";

/**
 * AgentCapabilitySummary — collapsible banner di tab Profil yang nge-show
 * "agen ini bisa apa" big picture.
 *
 * Aggregates from: tools.catalog (enabled toolsets) + skills.status
 * (allowlist) + plugins.list + mcp.list. Shows top chips + total count
 * + CTA "Lihat semua →" jump ke tab Kemampuan.
 *
 * Collapse state persisted at `agentbuff:agents:summaryCollapsed`.
 * Default = EXPANDED.
 */
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { type AgentRow } from "./helpers";
import {
  useMcpList,
  usePluginsList,
  useSkillsStatus,
  useToolsCatalog,
} from "./use-agents-data";
import {
  translatePlugin,
  translateSkill,
  translateToolset,
} from "./vocab";

const COLLAPSE_KEY = "agentbuff:agents:summaryCollapsed";

export function AgentCapabilitySummary({
  agent,
  onJumpToKemampuan,
}: {
  agent: AgentRow;
  onJumpToKemampuan?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(COLLAPSE_KEY);
      if (v === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = () => {
    // Side-effect (storage write) lives in the handler, NOT inside the state
    // updater — React may invoke updaters more than once (StrictMode/concurrent)
    // and updaters must stay pure. A click handler reads `collapsed` safely from
    // closure. (Audit MED.)
    const next = !collapsed;
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    setCollapsed(next);
  };

  const tools = useToolsCatalog(agent.id);
  const skills = useSkillsStatus(agent.id);
  const plugins = usePluginsList();
  const mcp = useMcpList();

  const enabledToolsets = useMemo(
    () => (tools.data?.groups ?? []).filter((g) => g.enabled),
    [tools.data],
  );
  const allowedSkills = useMemo(() => {
    const all = skills.data?.skills ?? [];
    const allowlist = new Set(agent.skills ?? []);
    if (allowlist.size === 0) return all.filter((s) => !s.disabled);
    return all.filter((s) => allowlist.has(s.name) && !s.disabled);
  }, [skills.data, agent.skills]);
  const enabledPlugins = useMemo(
    () => (plugins.data?.plugins ?? []).filter((p) => p.enabled),
    [plugins.data],
  );
  const enabledMcp = useMemo(
    () => (mcp.data?.servers ?? []).filter((s) => s.enabled),
    [mcp.data],
  );

  const totalCapabilities =
    enabledToolsets.length +
    allowedSkills.length +
    enabledPlugins.length +
    enabledMcp.length;

  // Build chip list (top 8 representative)
  const chips = useMemo(() => {
    const out: Array<{ icon: string; label: string; key: string }> = [];
    for (const g of enabledToolsets.slice(0, 4)) {
      const v = translateToolset(g.id);
      out.push({ icon: v.icon, label: v.label, key: `t:${g.id}` });
    }
    for (const s of allowedSkills.slice(0, 2)) {
      const v = translateSkill(s.name);
      out.push({ icon: v.icon, label: v.label, key: `s:${s.name}` });
    }
    for (const p of enabledPlugins.slice(0, 1)) {
      const v = translatePlugin(p.key);
      out.push({ icon: v.icon, label: v.label, key: `p:${p.key}` });
    }
    for (const m of enabledMcp.slice(0, 1)) {
      out.push({ icon: "🌐", label: m.name, key: `m:${m.name}` });
    }
    return out;
  }, [enabledToolsets, allowedSkills, enabledPlugins, enabledMcp]);

  const loading =
    (tools.loading && !tools.data) ||
    (skills.loading && !skills.data) ||
    (plugins.loading && !plugins.data) ||
    (mcp.loading && !mcp.data);

  return (
    <section className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.06] via-[#0B0E14]/40 to-fuchsia-400/[0.04] p-4">
      <header className="flex items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10">
          <Sparkles className="size-4 text-cyan-200" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-bold text-white">
            {agent.identity?.name || agent.name || agent.id} can handle{" "}
            <span className="text-cyan-200">{totalCapabilities} things</span>
          </h3>
          <p className="mt-0.5 text-[11.5px] text-white/60">
            {enabledToolsets.length} core features · {allowedSkills.length} skills · {enabledPlugins.length} plugins · {enabledMcp.length} connectors
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/65 hover:border-cyan-400/30 hover:text-cyan-100"
          title={collapsed ? "Show details" : "Hide details"}
        >
          {collapsed ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronUp className="size-3" aria-hidden />
          )}
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </header>

      {!collapsed ? (
        <div className="mt-3 space-y-2">
          {loading ? (
            <div className="h-10 animate-pulse rounded-lg bg-white/[0.02]" />
          ) : chips.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.01] px-3 py-3 text-center text-[11.5px] text-white/55">
              This agent has no capabilities yet.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span
                  key={c.key}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/85"
                >
                  <span aria-hidden>{c.icon}</span>
                  <span className="truncate max-w-[140px]">{c.label}</span>
                </span>
              ))}
              {totalCapabilities > chips.length ? (
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
                  +{totalCapabilities - chips.length}
                </span>
              ) : null}
            </div>
          )}
          {onJumpToKemampuan ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={onJumpToKemampuan}
                className="inline-flex items-center gap-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] text-cyan-200 hover:text-cyan-100"
              >
                Manage agent capabilities →
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
