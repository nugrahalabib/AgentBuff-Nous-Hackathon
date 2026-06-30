"use client";

/**
 * AgentDetail — right pane with 5 tabs (rewritten 2026-05-26).
 *
 * Tabs (mass-market structure):
 *   1. Profil    — identity + model + capability summary
 *   2. Persona   — file editor (Jiwa/Memori/Tentang Kamu)
 *   3. Kemampuan — UNIFIED: tools + skills + plugin + MCP (4 sub-tabs)
 *   4. Saluran   — channel binding (read-only reverse view)
 *   5. Jadwal    — cron rutinitas (read-only reverse view)
 *
 * Header: identity + agent id + workspace path + default badge.
 */
import { Calendar, Cpu, FileText, Radio, Sparkles, Star, User } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { AgentProfilPanel } from "./agent-profil-panel";
import { AgentOtakPanel } from "./agent-otak-panel";
import { AgentPersonaPanel } from "./agent-persona-panel";
import { AgentKemampuanPanel } from "./agent-kemampuan-panel";
import { AgentSaluranPanel } from "./agent-saluran-panel";
import { AgentRutinitasPanel } from "./agent-rutinitas-panel";
import {
  type AgentRow,
  type ModelChoice,
  type ModelAuthProvider,
  getAgentDisplayName,
} from "./helpers";

export type AgentTabId =
  | "profil"
  | "otak"
  | "persona"
  | "kemampuan"
  | "saluran"
  | "jadwal";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

const TABS: Array<{
  id: AgentTabId;
  label: string;
  icon: typeof User;
  hint: string;
}> = [
  {
    id: "profil",
    label: "Profile",
    icon: User,
    hint: "Who your agent is — name, avatar, role",
  },
  {
    id: "otak",
    label: "Agent Brain",
    icon: Cpu,
    hint: "AI model, fallback model & auxiliary tasks for this agent",
  },
  {
    id: "persona",
    label: "Persona",
    icon: FileText,
    hint: "Agent character & memory — edit Soul/Memory/User",
  },
  {
    id: "kemampuan",
    label: "Capabilities",
    icon: Sparkles,
    hint: "Tools & skills for this agent (per-agent) + plugins (global)",
  },
  {
    id: "saluran",
    label: "Channels",
    icon: Radio,
    hint: "Where this agent shows up — WhatsApp/Telegram/Discord/etc.",
  },
  {
    id: "jadwal",
    label: "Schedule",
    icon: Calendar,
    hint: "Automated scheduled tasks (cron)",
  },
];

export function AgentDetail({
  agent,
  isDefault,
  allAgentIds,
  defaultId,
  modelsList,
  authProviders,
  modelsLoading,
  onAfterChange,
  onAfterDelete,
  setToast,
}: {
  agent: AgentRow;
  isDefault: boolean;
  allAgentIds: string[];
  defaultId: string;
  modelsList: ModelChoice[];
  authProviders: ModelAuthProvider[];
  modelsLoading: boolean;
  onAfterChange: () => void;
  onAfterDelete: () => void;
  setToast: ToastSetter;
}) {
  const [tab, setTab] = useState<AgentTabId>("profil");

  // Reset to Profil whenever agent ref changes (selection switch)
  useEffect(() => {
    setTab("profil");
  }, [agent.id]);

  // Welcome-banner "next step" CTAs navigate via `#tab=<key>` hash links
  // (agents-tab.tsx buildCtas). Honor them: read the hash on mount + on
  // hashchange and switch tabs, so those buttons actually do something
  // instead of just setting a dead URL fragment. (P2 fix 2026-05-30.)
  useEffect(() => {
    const KNOWN: AgentTabId[] = [
      "profil",
      "otak",
      "persona",
      "kemampuan",
      "saluran",
      "jadwal",
    ];
    const applyHash = () => {
      const m = /[#&]tab=([a-z]+)/.exec(window.location.hash);
      const key = m?.[1] as AgentTabId | undefined;
      if (key && KNOWN.includes(key)) setTab(key);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-white/[0.06] bg-[#0B0E14]/60 px-5 py-4 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-60 blur-md" />
            <div className="relative flex size-12 items-center justify-center overflow-hidden rounded-2xl border border-white/15 bg-[#0B0E14]">
              {agent.identity?.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={agent.identity.avatar}
                  alt={getAgentDisplayName(agent)}
                  className="size-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              {!agent.identity?.avatar && agent.identity?.emoji ? (
                <span className="text-2xl">{agent.identity.emoji}</span>
              ) : null}
              {!agent.identity?.avatar && !agent.identity?.emoji ? (
                <User className="size-5 text-white/55" aria-hidden />
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
              ✦ Selected Agent
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
              <h1 className="font-display text-xl font-bold text-white">
                {getAgentDisplayName(agent)}
              </h1>
              {isDefault ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-200">
                  <Star className="size-2.5 fill-cyan-300" aria-hidden />
                  Default
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/35">
              <span className="normal-case tracking-normal">{agent.id}</span>
              {/*
                NOTE: agent.workspace intentionally NOT rendered. The raw
                filesystem path (`/home/hermes/.hermes` for default,
                `~/.hermes/profiles/<id>` for named) leaks the upstream
                Hermes brand + container internals. Path is system-level
                infrastructure — user doesn't need it. If we ever need
                to surface "where files live" for power users, do it in
                a Pengaturan → Debug tab with explicit brand-scrubbed
                display (e.g. "~/agentbuff/<id>/").
              */}
            </p>
          </div>
        </div>

        {/* Tab bar */}
        <nav
          className="mt-4 flex overflow-x-auto"
          role="tablist"
          aria-label="Agent panel"
        >
          <div className="flex gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1">
            {TABS.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`agent-tab-${t.id}`}
                  aria-selected={active}
                  aria-controls={`agent-panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] transition",
                    active
                      ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14]"
                      : "text-white/55 hover:bg-white/[0.04] hover:text-white/90",
                  )}
                  title={t.hint}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      {/* Panel body */}
      <div
        role="tabpanel"
        id={`agent-panel-${tab}`}
        aria-labelledby={`agent-tab-${tab}`}
        className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-5"
      >
        {tab === "profil" ? (
          <AgentProfilPanel
            agent={agent}
            isDefault={isDefault}
            allAgentIds={allAgentIds}
            modelsList={modelsList}
            authProviders={authProviders}
            loadingCatalog={modelsLoading}
            onAfterChange={onAfterChange}
            onAfterDelete={onAfterDelete}
            setToast={setToast}
            onJumpToKemampuan={() => setTab("kemampuan")}
          />
        ) : null}

        {tab === "otak" ? (
          <AgentOtakPanel
            agent={agent}
            modelsList={modelsList}
            authProviders={authProviders}
            loadingCatalog={modelsLoading}
            onAfterChange={onAfterChange}
            setToast={setToast}
          />
        ) : null}

        {tab === "persona" ? (
          <AgentPersonaPanel agentId={agent.id} setToast={setToast} />
        ) : null}

        {tab === "kemampuan" ? (
          <AgentKemampuanPanel
            agent={agent}
            onAfterChange={onAfterChange}
            setToast={setToast}
          />
        ) : null}

        {tab === "saluran" ? (
          <AgentSaluranPanel
            agent={agent}
            defaultId={defaultId}
            setToast={setToast}
          />
        ) : null}

        {tab === "jadwal" ? (
          <AgentRutinitasPanel
            agent={agent}
            defaultId={defaultId}
            setToast={setToast}
          />
        ) : null}
      </div>
    </section>
  );
}
