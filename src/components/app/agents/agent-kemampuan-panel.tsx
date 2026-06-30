"use client";

/**
 * AgentKemampuanPanel — unified capability hub for an agent.
 *
 * Replaces 4 separate tabs (Senjata, Skill, Plugin, Saluran-tools) with
 * 1 tab containing horizontal sub-tab nav:
 *
 *   [ Kemampuan Utama ] [ Skill Khusus ] [ Plugin & Connector ] [ Mode Pro ⚙ ]
 *
 * Pemula mode: friendly Bahasa labels + emoji + simple toggles + bucket
 *              grouping (Data/Kreatif/Komunikasi/Tools Agen/Developer).
 * Pro mode:    raw technical names, manifest paths, config IDs visible.
 *
 * Mass-market design principle: every capability surfaces via SAME visual
 * card (UnifiedCapabilityCard) regardless of underlying type (tool/skill/
 * plugin/MCP). User cares about "agen bisa apa", not "ini toolset vs skill".
 */
import {
  CircleAlert,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  type AgentRow,
  type McpPreset,
  type McpServerRow,
  type SkillStatusEntry,
  type ToolCatalogGroup,
  type ToolSource,
  formatRelative,
} from "./helpers";
import {
  type CapabilityBucket,
  type Requirement,
  BUCKET_LABEL,
  bucketLabel,
  translatePlugin,
  translateSkill,
  translateToolset,
} from "./vocab";
import {
  type CapabilityReadiness,
  readinessBadgeTone,
  resolveReadiness,
} from "./capability-requirements";
import {
  addMcpServer,
  configureMcpServer,
  disablePlugin,
  enablePlugin,
  removeMcpServer,
  rediscoverPlugins,
  removePlugin,
  setAgentSkillAllowlist,
  setAgentSkillDisabled,
  deleteAgentCreatedSkill,
  resetAgentSkillsToFactory,
  testMcpServer,
  toggleToolset,
  useChannelsStatus,
  useEnvList,
  useMcpList,
  useMcpPresets,
  useModelsAuthStatus,
  usePluginsList,
  useSkillsStatus,
  useToolsCatalog,
} from "./use-agents-data";
import { SkillCategoryBrowser } from "./skill-category-browser";
import {
  isEssentialSkill,
  isEssentialToolset,
  isHiddenToolset,
  isHiddenSkill,
  isProtectedPlugin,
} from "./capability-tiers";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

type SubTabId = "tools" | "skills" | "agent-created" | "plugins-mcp";

const SUB_TABS: Array<{ id: SubTabId; label: string; emoji: string; hint: string }> = [
  { id: "tools", label: "Core Abilities", emoji: "⚡", hint: "Agent's built-in features" },
  { id: "skills", label: "Custom Skills", emoji: "📖", hint: "Knowledge + SOPs" },
  { id: "agent-created", label: "Agent-Created", emoji: "✨", hint: "Skills the agent built itself" },
  { id: "plugins-mcp", label: "Plugins & Connectors", emoji: "🔌", hint: "Extensions + app integrations" },
];

export function AgentKemampuanPanel({
  agent,
  onAfterChange,
  setToast,
}: {
  agent: AgentRow;
  onAfterChange?: () => void;
  setToast: ToastSetter;
}) {
  const [sub, setSub] = useState<SubTabId>("tools");
  // Bumped after a factory reset so the skill sections remount + refetch.
  const [resetNonce, setResetNonce] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleResetSkills = async () => {
    setResetting(true);
    const res = await resetAgentSkillsToFactory(agent.id);
    setResetting(false);
    setConfirmReset(false);
    if (res.ok) {
      setToast({
        kind: "success",
        text: `Skills reset to factory defaults (${res.data.builtinOn} built-in skills enabled, ${res.data.nonBuiltinOff} extra skills disabled)`,
      });
      setResetNonce((n) => n + 1);
      onAfterChange?.();
    } else {
      setToast({ kind: "error", text: `Reset failed: ${res.error}` });
    }
  };

  // Correct model (verified live vs Hermes 0.16.0): each agent is a profile with
  // its OWN config.yaml/skills/SOUL/model, and the bridge writes per-agent +
  // persona_patch enforces the agent's own toolsets/SOUL/model at chat runtime.
  // So Tools + Persona are PER-AGENT. Plugins are the exception — the engine
  // loads them once per process from the global config, so plugin on/off is
  // container-wide.

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-3.5 py-2.5 text-[12px] leading-relaxed text-cyan-100/85">
        <span aria-hidden className="mt-0.5 text-sm">🎯</span>
        <p>
          <strong className="font-semibold text-cyan-50">Tools &amp; persona</strong> here
          apply to <strong className="font-semibold text-cyan-50">this agent only</strong> —
          each agent has its own set. <strong className="font-semibold text-cyan-50">Plugins &amp;
          connectors</strong> are global (all agents share the same ones).
        </p>
      </div>
      {/* Sub-tab nav (horizontal browser-tab style) */}
      <nav
        className="flex overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.02] p-1"
        role="tablist"
        aria-label="Capabilities panel"
      >
        {SUB_TABS.map((t) => {
          const active = sub === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSub(t.id)}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] transition",
                active
                  ? "bg-gradient-to-r from-cyan-400/20 via-indigo-500/20 to-fuchsia-500/20 text-white shadow-[0_0_0_1px_rgba(34,211,238,0.35)]"
                  : "text-white/55 hover:bg-white/[0.04] hover:text-white/80",
              )}
              title={t.hint}
            >
              <span aria-hidden>{t.emoji}</span>
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Reset-to-factory bar */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2">
        <p className="min-w-0 text-[11.5px] leading-snug text-white/55">
          <span className="font-semibold text-white/80">Reset to factory defaults</span>{" "}
          — all built-in skills will be turned back on. Skills you purchased or that the
          agent created <strong className="text-white/75">stay, but get disabled</strong>.
          You can re-enable them manually any time.
        </p>
        {confirmReset ? (
          <div className="inline-flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleResetSkills()}
              disabled={resetting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50"
            >
              {resetting ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-3" aria-hidden />
              )}
              Confirm reset?
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/70 transition hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-100 transition hover:border-amber-400/50 hover:bg-amber-400/15"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Reset Skills
          </button>
        )}
      </div>

      {sub === "tools" ? (
        <ToolsSection
          key={`tools-${resetNonce}`}
          agent={agent}
          onAfterChange={onAfterChange}
          setToast={setToast}
        />
      ) : null}
      {sub === "skills" ? (
        <SkillsSection
          key={`skills-${resetNonce}`}
          agent={agent}
          onAfterChange={onAfterChange}
          setToast={setToast}
        />
      ) : null}
      {sub === "agent-created" ? (
        <AgentCreatedSkillsSection
          key={`agent-created-${resetNonce}`}
          agent={agent}
          onAfterChange={onAfterChange}
          setToast={setToast}
        />
      ) : null}
      {sub === "plugins-mcp" ? (
        <PluginsMcpSection agent={agent} setToast={setToast} />
      ) : null}
    </div>
  );
}

/* ── Section: KEMAMPUAN UTAMA (tools) ───────────────────────────── */

export function ToolsSection({
  agent,
  onAfterChange,
  setToast,
}: {
  agent: AgentRow;
  onAfterChange?: () => void;
  setToast: ToastSetter;
}) {
  const catalog = useToolsCatalog(agent.id);
  const data = catalog.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CapabilityBucket>("all");

  // Requirement data sources (used by capability readiness resolver).
  const modelsAuth = useModelsAuthStatus();
  const channels = useChannelsStatus();
  const mcp = useMcpList();
  const envList = useEnvList();
  const reqData = useMemo(
    () => ({
      models: modelsAuth.data ?? null,
      channels: channels.data ?? null,
      mcp: mcp.data ?? null,
      env: envList.data ?? null,
      // Per-agent paired channels so a channel paired for THIS agent (multi-
      // account plugin) reads as satisfied even when the global namespace is
      // empty. `agentChannels` rides along on the raw channels.status payload.
      agentChannels:
        (channels.data as { agentChannels?: Record<string, unknown> } | null)
          ?.agentChannels ?? null,
      agentId: agent.id,
    }),
    [modelsAuth.data, channels.data, mcp.data, envList.data, agent.id],
  );

  // Modal state — when user clicks the readiness badge, this opens with
  // the resolved checks so they can see exactly what's missing.
  const [reqModal, setReqModal] = useState<
    | { label: string; icon: string; readiness: CapabilityReadiness }
    | null
  >(null);

  // Which toolsets are LOCKED: a HARD (non-optional) requirement is unmet.
  // resolveReadiness returns "setup-needed"/"blocked" only when a required dep
  // is missing — optional deps + Gemini-satisfied ones stay "ready" (so
  // vision/image_gen/tts that run on the active model are NOT locked).
  // Essential toolsets are NEVER locked-off (they're always-on, see below).
  // 2026-06-03 (Chief: "hilangin aturan lock — skill/tool MURNI ngikut engine").
  // Nothing is locked-off anymore. Every toolset is freely toggleable; the panel
  // reflects the engine's real enabled/disabled state with no forcing. (Kept as
  // an always-empty set so the rest of the panel's tier/render logic still
  // compiles unchanged.)
  const lockedSet = useMemo(() => new Set<string>(), []);

  // ── 3-tier model (Chief 2026-05-31) ──────────────────────────────────────
  //   essential → always ON, locked-on (can't be turned off). Top.
  //   ready     → free to toggle. Middle.
  //   locked    → requirement unmet → OFF + locked-off. Bottom.
  const tierOf = (id: string): "essential" | "ready" | "locked" =>
    isEssentialToolset(id) ? "essential" : lockedSet.has(id) ? "locked" : "ready";

  // NOTE: the old "one-time per-agent toolset reconcile" (auto turn-on
  // essentials / auto turn-off requirement-locked) was REMOVED (chief
  // 2026-06-05, seamless audit). The tier sets are empty post lean-engine so it
  // was already inert — but we drop the dead auto-write entirely so NOTHING in
  // this panel mutates config without an explicit user click. Pure passthrough.

  // Group toolsets by mass-market bucket. Within each bucket: essential first,
  // then ready (free toggle), then locked (needs-setup) at the bottom.
  const grouped = useMemo(() => {
    if (!data) return new Map<CapabilityBucket, ToolCatalogGroup[]>();
    const out = new Map<CapabilityBucket, ToolCatalogGroup[]>();
    for (const g of data.groups) {
      // Hide niche/foreign channels + doc connectors from the mass-market
      // capability picker (Chief 2026-06-01). Engine config untouched.
      if (isHiddenToolset(g.id)) continue;
      const vocab = translateToolset(g.id);
      const bucket = vocab.bucket;
      const arr = out.get(bucket) ?? [];
      arr.push(g);
      out.set(bucket, arr);
    }
    const rank = (id: string) =>
      tierOf(id) === "essential" ? 0 : tierOf(id) === "ready" ? 1 : 2;
    for (const arr of out.values()) {
      arr.sort((a, b) => rank(a.id) - rank(b.id));
    }
    return out;
  }, [data, lockedSet]);

  const bucketKeys = useMemo(() => {
    const allBuckets: CapabilityBucket[] = [
      "data",
      "kreatif",
      "komunikasi",
      "agen-tools",
      "developer",
      "lain",
    ];
    return allBuckets.filter((b) => (grouped.get(b)?.length ?? 0) > 0);
  }, [grouped]);

  // Hero "Aktif / Total" reflect only VISIBLE (non-hidden) toolsets so the
  // numbers match what the user actually sees after hiding niche channels.
  const visibleCounts = useMemo(() => {
    const all = Array.from(grouped.values()).flat();
    return { total: all.length, enabled: all.filter((g) => g.enabled).length };
  }, [grouped]);

  const handleToggle = async (toolset: string, enable: boolean) => {
    setBusy(`ts:${toolset}`);
    const res = await toggleToolset(agent.id, toolset, enable);
    setBusy(null);
    if (res.ok) {
      const vocab = translateToolset(toolset);
      setToast({
        kind: "success",
        text: enable
          ? `${vocab.icon} ${vocab.label} enabled`
          : `${vocab.icon} ${vocab.label} disabled`,
      });
      void catalog.refetch();
      onAfterChange?.();
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
  };

  if (catalog.loading && !data) return <LoadingShell />;
  if (catalog.error || !data) return <ErrorBox error={catalog.error} onRetry={() => catalog.refetch()} />;

  const filteredBucketKeys = filter === "all" ? bucketKeys : bucketKeys.filter((b) => b === filter);

  return (
    <div className="space-y-4">
      <HeroBanner
        icon="⚡"
        title="Agent Core Abilities"
        subtitle="Built-in features your agent can perform. Enable what's needed, turn off what's not relevant."
        stats={[
          { label: "Active", value: visibleCounts.enabled, tone: "emerald" },
          { label: "Total", value: visibleCounts.total, tone: "white" },
        ]}
      />

      {/* Bucket filter chips */}
      <div className="flex flex-wrap gap-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterChip>
        {bucketKeys.map((b) => (
          <FilterChip key={b} active={filter === b} onClick={() => setFilter(b)}>
            {BUCKET_LABEL[b]}
          </FilterChip>
        ))}
      </div>

      {filteredBucketKeys.length === 0 ? (
        <EmptyState
          icon="🧩"
          title="No abilities in this category"
          subtitle="Try a different category or install a new plugin."
        />
      ) : (
        filteredBucketKeys.map((bucket) => (
          <section
            key={bucket}
            className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4"
          >
            <header className="mb-3 flex items-baseline gap-2">
              <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-white/85">
                {BUCKET_LABEL[bucket]}
              </h3>
              <span className="ml-auto font-mono text-[10px] text-white/35">
                {grouped.get(bucket)?.length ?? 0} abilities
              </span>
            </header>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(grouped.get(bucket) ?? []).map((g) => {
                const vocab = translateToolset(g.id);
                const isBusy = busy === `ts:${g.id}`;
                const readiness = resolveReadiness(vocab, reqData);
                const tier = tierOf(g.id);
                const isEssential = tier === "essential";
                const isLocked = tier === "locked";
                return (
                  <UnifiedCapabilityCard
                    key={g.id}
                    icon={vocab.icon}
                    label={vocab.label}
                    description={vocab.description}
                    // essential = always ON; locked = always OFF (reconcile
                    // makes both real in config). Only "ready" follows g.enabled.
                    enabled={isEssential ? true : g.enabled && !isLocked}
                    locked={isLocked}
                    essential={isEssential}
                    onToggle={() => void handleToggle(g.id, !g.enabled)}
                    busy={isBusy}
                    anyBusy={!!busy}
                    readiness={readiness}
                    onReadinessClick={() =>
                      setReqModal({
                        label: vocab.label,
                        icon: vocab.icon,
                        readiness,
                      })
                    }
                  />
                );
              })}
            </ul>
          </section>
        ))
      )}

      {reqModal ? (
        <RequirementsModal
          icon={reqModal.icon}
          label={reqModal.label}
          readiness={reqModal.readiness}
          onClose={() => setReqModal(null)}
        />
      ) : null}
    </div>
  );
}

/* ── Section: SKILL KHUSUS ─────────────────────────────────────── */

export function SkillsSection({
  agent,
  onAfterChange,
  setToast,
}: {
  agent: AgentRow;
  onAfterChange?: () => void;
  setToast: ToastSetter;
}) {
  const status = useSkillsStatus(agent.id);
  const skills = useMemo(
    () =>
      (status.data?.skills ?? []).filter(
        // Agent-authored skills live in their OWN "Buatan Agen" tab, not here.
        (s) => !isHiddenSkill(s.name) && !s.agentCreated,
      ),
    [status.data],
  );
  const envList = useEnvList();
  const envPresentKeys = useMemo(
    () => new Set(envList.data?.presentKeys ?? []),
    [envList.data],
  );

  const [allowlist, setAllowlist] = useState<string[]>(agent.skills ?? []);
  // H4 (2026-05-30): depend on agent.id, NOT the whole agent object. The
  // parent re-derives `agent` (a new object reference) on every list.refetch,
  // so a dep of [agent] re-ran this effect after every skill toggle and
  // clobbered the in-flight optimistic allowlist (flicker / stale set). The
  // allowlist only needs to resync when the user switches to a DIFFERENT agent.
  useEffect(() => {
    setAllowlist(agent.skills ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  const hasAllowlist = allowlist.length > 0;

  const [busy, setBusy] = useState<string | null>(null);

  // Effective enabled set the browser renders. Consistent baseline rule (chief
  // 2026-06-05): every DEFAULT skill is ON for a fresh agent/account — identical
  // for everyone — and the user is free to toggle afterwards. So we mirror the
  // engine exactly (empty allowlist = all non-disabled on) and do NOT force any
  // skill off for being "not configured". Skills that need setup still surface
  // a BUTUH SETUP badge (informational), but they stay ON.
  const enabledSet = useMemo(() => {
    const eff = hasAllowlist
      ? new Set(allowlist)
      : new Set(skills.filter((s) => !s.disabled).map((s) => s.name));
    // Essential skills are ALWAYS on (locked). (ESSENTIAL set is empty post
    // lean-engine, so this is a no-op today — kept for forward-compat.)
    for (const s of skills) if (isEssentialSkill(s.name)) eff.add(s.name);
    return eff;
  }, [hasAllowlist, allowlist, skills]);

  const assignedCount = useMemo(
    () => skills.filter((s) => enabledSet.has(s.name) && !s.disabled).length,
    [skills, enabledSet],
  );

  // NOTE: the old "one-time per-agent reconcile" that auto-disabled
  // not-configured skills was REMOVED (chief 2026-06-05). It made the baseline
  // inconsistent (depended on which env keys happened to be set) and silently
  // mutated config the user never touched. New agents/accounts now keep the
  // engine default (all default skills ON, identical for everyone); the user
  // changes things only by toggling explicitly.

  // Persist a brand-new allowlist. We MATERIALIZE the effective set on first
  // edit (so toggling ONE skill off from the all-on default removes just that
  // one, instead of no-op'ing against an empty list).
  const persistAllowlist = async (nextList: string[], toastText: string) => {
    const res = await setAgentSkillAllowlist(agent.id, nextList);
    if (res.ok) {
      setAllowlist(nextList);
      setToast({ kind: "success", text: toastText });
      onAfterChange?.();
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
  };

  const handleToggle = async (skillName: string, next: boolean) => {
    setBusy(skillName);
    const base = Array.from(enabledSet);
    const nextList = next
      ? Array.from(new Set([...base, skillName]))
      : base.filter((n) => n !== skillName);
    const v = translateSkill(skillName);
    await persistAllowlist(
      nextList,
      next ? `${v.icon} ${v.label} enabled` : `${v.icon} ${v.label} disabled`,
    );
    setBusy(null);
  };

  const handleBulkToggle = async (names: string[], next: boolean) => {
    setBusy("__bulk__");
    const base = new Set(enabledSet);
    if (next) names.forEach((n) => base.add(n));
    else names.forEach((n) => base.delete(n));
    await persistAllowlist(
      Array.from(base),
      next ? `${names.length} skills enabled` : `${names.length} skills disabled`,
    );
    setBusy(null);
  };

  // Rows for the browser. In the PER-AGENT panel every skill is toggleable:
  // skills.status `disabled` is this agent's OWN per-profile skills.disabled
  // (incl. the allowlist inversion from a template), NOT a container-wide lock.
  // Toggling re-computes the allowlist (setAgentSkillAllowlist) which un-disables
  // it — proven re-enableable. So we must NOT render per-agent-disabled skills as
  // the non-toggleable "NONAKTIF GLOBAL" state (that wrongly dead-locked template
  // agents at 2/73). The on/off comes from enabledSet; `disabled:false` here only
  // means "always clickable". (2026-06-08 fix.)
  const browserRows = useMemo(
    () => skills.map((s) => ({ ...s, disabled: false })),
    [skills],
  );

  if (status.loading && skills.length === 0) return <LoadingShell />;

  return (
    <div className="space-y-4">
      <HeroBanner
        icon="📖"
        title="Custom Skills"
        subtitle="Extra knowledge to make your agent great at specific tasks. Browse by category, toggle on/off as needed for this agent."
        stats={[
          { label: "Active", value: assignedCount, tone: "emerald" },
          { label: "Total", value: skills.length, tone: "cyan" },
        ]}
      />

      {skills.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No skills available yet"
          subtitle="Built-in skills are being prepared. Try refreshing in a moment."
        />
      ) : (
        <SkillCategoryBrowser
          skills={browserRows}
          enabledSet={enabledSet}
          onToggle={(name, next) => void handleToggle(name, next)}
          onBulkToggle={(names, next) => void handleBulkToggle(names, next)}
          busyName={busy === "__bulk__" ? null : busy}
          loading={status.loading}
          envPresentKeys={envPresentKeys}
        />
      )}
    </div>
  );
}

/* ── Section: BUATAN AGEN (agent-authored skills) ──────────────── */

function AgentCreatedSkillsSection({
  agent,
  onAfterChange,
  setToast,
}: {
  agent: AgentRow;
  onAfterChange?: () => void;
  setToast: ToastSetter;
}) {
  const status = useSkillsStatus(agent.id);
  const agentSkills = useMemo(
    () =>
      (status.data?.skills ?? []).filter(
        (s) => s.agentCreated && !isHiddenSkill(s.name),
      ),
    [status.data],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Agent-created skills are gated ONLY by the engine's skills.disabled list
  // (not the synthetic allowlist whitelist). So "enabled" = the real engine
  // state: a skill the agent just authored is ON by default (not disabled) and
  // immediately usable — matching "agen bikin skill, langsung kepake".
  const enabledOf = (s: SkillStatusEntry) => !s.disabled;
  const activeCount = useMemo(
    () => agentSkills.filter(enabledOf).length,
    [agentSkills],
  );

  const handleToggle = async (name: string, next: boolean) => {
    setBusy(name);
    // next=true means ENABLE → disabled=false, and vice-versa. Direct
    // skills.disabled toggle (engine-native), no allowlist round-trip.
    const res = await setAgentSkillDisabled(agent.id, name, !next);
    if (res.ok) {
      setToast({
        kind: "success",
        text: next ? `Skill "${name}" enabled` : `Skill "${name}" disabled`,
      });
      void status.refetch();
      onAfterChange?.();
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
    setBusy(null);
  };

  const handleDelete = async (name: string) => {
    setBusy(name);
    const res = await deleteAgentCreatedSkill(name);
    if (res.ok) {
      setToast({ kind: "success", text: `Skill "${name}" permanently deleted` });
      void status.refetch();
      onAfterChange?.();
    } else {
      setToast({ kind: "error", text: `Delete failed: ${res.error}` });
    }
    setBusy(null);
    setConfirmDelete(null);
  };

  if (status.loading && !status.data) return <LoadingShell />;

  return (
    <div className="space-y-4">
      <HeroBanner
        icon="✨"
        title="Agent-Created Skills"
        subtitle="Skills your agent built or refined on its own while working. Only shown here — you can toggle them per agent, or delete permanently."
        stats={[
          { label: "Active", value: activeCount, tone: "emerald" },
          { label: "Total", value: agentSkills.length, tone: "cyan" },
        ]}
      />

      {agentSkills.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-2xl">
            ✨
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
            No agent-created skills yet
          </p>
          <p className="mx-auto mt-2 max-w-md text-[12.5px] leading-relaxed text-white/55">
            When your agent builds or refines a skill from a conversation,
            it automatically appears here. Built-in engine skills stay in the
            other tabs and cannot be deleted.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {agentSkills.map((s) => (
            <AgentCreatedSkillRow
              key={s.name}
              skill={s}
              enabled={enabledOf(s)}
              busy={busy === s.name}
              confirming={confirmDelete === s.name}
              onToggle={(next) => void handleToggle(s.name, next)}
              onAskDelete={() => setConfirmDelete(s.name)}
              onCancelDelete={() => setConfirmDelete(null)}
              onConfirmDelete={() => void handleDelete(s.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentCreatedSkillRow({
  skill,
  enabled,
  busy,
  confirming,
  onToggle,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  skill: SkillStatusEntry;
  enabled: boolean;
  busy: boolean;
  confirming: boolean;
  onToggle: (next: boolean) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const created =
    skill.createdAtMs != null ? formatRelative(skill.createdAtMs) : null;
  const lastUsed =
    skill.lastUsedAtMs != null ? formatRelative(skill.lastUsedAtMs) : null;
  return (
    <li
      className={cn(
        "rounded-xl border p-3 transition-colors",
        enabled
          ? "border-fuchsia-400/25 bg-fuchsia-400/[0.04]"
          : "border-white/[0.07] bg-white/[0.02]",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-fuchsia-400/25 bg-fuchsia-400/10 text-base">
          {skill.emoji || "✨"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-white/90">
              {skill.name}
            </span>
            <span className="shrink-0 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-1.5 py-0 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-fuchsia-200">
              Agent-Created
            </span>
          </div>
          {skill.description ? (
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-white/55">
              {skill.description}
            </p>
          ) : null}
          {created || lastUsed ? (
            <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
              {created ? `Created ${created}` : ""}
              {created && lastUsed ? " · " : ""}
              {lastUsed ? `Used ${lastUsed}` : ""}
              {skill.useCount ? ` · ${skill.useCount}×` : ""}
            </p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {confirming ? (
            <div className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-1">
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={busy}
                className="rounded-md bg-red-500 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="rounded-md border border-white/15 bg-white/[0.04] px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-white/70 hover:text-white"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onToggle(!enabled)}
                disabled={busy}
                aria-pressed={enabled}
                title={enabled ? "Disable skill" : "Enable skill"}
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50",
                  enabled ? "bg-emerald-400/80" : "bg-white/15",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-4 transform rounded-full bg-white shadow transition-transform",
                    enabled ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
              <button
                type="button"
                onClick={onAskDelete}
                disabled={busy}
                title="Delete skill permanently"
                className="rounded-md p-1.5 text-white/40 transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/* ── Section: PLUGIN & CONNECTOR (MCP) ─────────────────────────── */

function PluginsMcpSection({
  agent,
  setToast,
}: {
  agent: AgentRow;
  setToast: ToastSetter;
}) {
  const plugins = usePluginsList();
  const mcp = useMcpList();
  const presets = useMcpPresets();

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  const handleTogglePlugin = async (key: string, enabled: boolean) => {
    setBusy(`pl:${key}`);
    const res = enabled ? await disablePlugin(key) : await enablePlugin(key);
    setBusy(null);
    if (res.ok) {
      setToast({
        kind: "success",
        text: enabled ? `Plugin "${key}" disabled` : `Plugin "${key}" enabled`,
      });
      void plugins.refetch();
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
  };

  const handleRemovePlugin = async (key: string) => {
    setBusy(`pl-rm:${key}`);
    const res = await removePlugin(key);
    setBusy(null);
    setConfirmRemove(null);
    if (res.ok) {
      setToast({ kind: "success", text: `Plugin "${key}" removed` });
      void plugins.refetch();
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
  };

  const handleRemoveMcp = async (name: string) => {
    setBusy(`mcp-rm:${name}`);
    const res = await removeMcpServer(name);
    setBusy(null);
    setConfirmRemove(null);
    if (res.ok) {
      setToast({ kind: "success", text: `Connector "${name}" removed` });
      void mcp.refetch();
    } else {
      setToast({ kind: "error", text: `Failed: ${res.error}` });
    }
  };

  const handleAddPreset = async (preset: McpPreset) => {
    // Check env vars — if any required env missing, open detail dialog
    const requiredEnv = preset.envVars.filter((e) => e.required);
    if (requiredEnv.length > 0) {
      // Open preset detail dialog (handles env input)
      setActivePreset(preset);
      return;
    }
    // No env required, install directly
    setBusy(`mcp-add:${preset.id}`);
    const res = await addMcpServer({
      name: preset.id,
      presetId: preset.id,
    });
    setBusy(null);
    if (res.ok) {
      setToast({ kind: "success", text: `Connector "${preset.label}" installed` });
      void mcp.refetch();
      setShowPresets(false);
    } else {
      setToast({ kind: "error", text: `Error: ${res.error}` });
    }
  };

  const [activePreset, setActivePreset] = useState<McpPreset | null>(null);

  return (
    <div className="space-y-4">
      {/* GLOBAL-scope warning — plugins/connectors are container-wide, not
          per-agent (engine loads them once per process). Highlighted so the
          user never thinks toggling here only affects the selected agent. */}
      <div className="flex items-start gap-3 rounded-2xl border border-amber-400/40 bg-amber-400/[0.08] px-4 py-3 shadow-[0_0_24px_-8px_rgba(251,191,36,0.45)]">
        <span aria-hidden className="mt-0.5 text-base">🌐</span>
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300">
            Global setting · all agents
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-amber-100/90">
            Unlike tools &amp; skills which are per-agent, <strong className="font-semibold text-amber-50">plugins &amp; connectors
            are GLOBAL</strong> — one setting applies to <strong className="font-semibold text-amber-50">all agents</strong>.
            Toggling here affects every agent you have, not just this one.
          </p>
        </div>
      </div>

      <HeroBanner
        icon="🔌"
        title="Plugins & Connectors"
        subtitle="Engine extensions (plugins) + third-party app integrations (MCP connectors)."
        stats={[
          { label: "Plugins active", value: plugins.data?.enabledCount ?? 0, tone: "emerald" },
          { label: "Connectors active", value: mcp.data?.enabledCount ?? 0, tone: "cyan" },
        ]}
      />

      {/* Plugin sub-section */}
      <section className="rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/[0.03] p-4">
        <header className="mb-3 flex items-baseline justify-between gap-2">
          <div>
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-fuchsia-200">
              🔌 Plugin Engine
            </h3>
            <p className="mt-0.5 text-[11.5px] text-white/55">
              Plugins add tools, skills, hooks, CLI commands, and dashboards all at once.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              void rediscoverPlugins()
                .then(() => plugins.refetch())
                .catch((e) =>
                  setToast({
                    kind: "error",
                    text: `Plugin rescan failed: ${e instanceof Error ? e.message : String(e)}`,
                  }),
                )
            }
            disabled={!!busy}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/65 hover:border-cyan-400/30 hover:text-cyan-100 disabled:opacity-50"
            title="Rescan plugin"
          >
            <RefreshCw className="size-3" aria-hidden />
            Rescan
          </button>
        </header>
        {plugins.loading && !plugins.data ? (
          <div className="h-20 animate-pulse rounded-xl bg-white/[0.02]" />
        ) : (plugins.data?.plugins.length ?? 0) === 0 ? (
          <EmptyState
            compact
            icon="🔌"
            title="No plugins installed"
            subtitle="Additional plugins can be installed directly from here with one click."
          />
        ) : (
          <ul className="space-y-2">
            {plugins.data?.plugins.map((p) => {
              const v = translatePlugin(p.key);
              const isBusy = busy === `pl:${p.key}` || busy === `pl-rm:${p.key}`;
              const isConfirming = confirmRemove === `pl:${p.key}`;
              // Chief 2026-05-31: lock connected plugins (can't off, can't
              // remove). AgentBuff's own bundled plugins (Multichannel /
              // Multimodal) are ALWAYS locked-on + "wajib" - they must never
              // die. Other enabled plugins lock too ("terkunci"); disabled
              // ones stay free to toggle on and remove.
              const isBundled = isProtectedPlugin(p.key);
              const lockedOn = isBundled || p.enabled;
              const canRemove = p.source === "user" && !lockedOn;
              return (
                <UnifiedCapabilityCard
                  key={p.key}
                  icon={v.icon}
                  label={v.label}
                  description={v.description || p.description}
                  enabled={isBundled ? true : p.enabled}
                  essential={lockedOn}
                  essentialLabel={isBundled ? "required" : "locked"}
                  onToggle={() => void handleTogglePlugin(p.key, p.enabled)}
                  busy={isBusy}
                  anyBusy={!!busy}
                  removeLabel={canRemove ? "Remove" : undefined}
                  onRequestRemove={
                    canRemove
                      ? () => setConfirmRemove(`pl:${p.key}`)
                      : undefined
                  }
                  showConfirmRemove={isConfirming}
                  onConfirmRemove={() => void handleRemovePlugin(p.key)}
                  onCancelRemove={() => setConfirmRemove(null)}
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* MCP sub-section */}
      <section className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.03] p-4">
        <header className="mb-3 flex items-baseline justify-between gap-2">
          <div>
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-200">
              🌐 Connector Aplikasi (MCP)
            </h3>
            <p className="mt-0.5 text-[11.5px] text-white/55">
              Connect your agent to Notion, GitHub, Google Drive, Slack, and more.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowPresets((v) => !v)}
              disabled={!!busy}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-100 hover:border-emerald-400/50 hover:bg-emerald-400/10 disabled:opacity-50"
            >
              <Sparkles className="size-3" aria-hidden />
              {showPresets ? "Close presets" : "Add connector"}
            </button>
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              disabled={!!busy}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:border-cyan-400/40 hover:text-white disabled:opacity-50"
              title="Connect your own app or website via URL"
            >
              <Plus className="size-3" aria-hidden />
              Custom
            </button>
          </div>
        </header>

        {showPresets ? (
          <McpPresetGrid
            presets={presets.data?.presets ?? []}
            loading={presets.loading}
            installedNames={new Set((mcp.data?.servers ?? []).map((s) => s.name))}
            onPick={(p) => void handleAddPreset(p)}
            busyId={busy?.startsWith("mcp-add:") ? busy.slice("mcp-add:".length) : null}
          />
        ) : null}

        {mcp.loading && !mcp.data ? (
          <div className="h-20 animate-pulse rounded-xl bg-white/[0.02]" />
        ) : (mcp.data?.servers.length ?? 0) === 0 ? (
          <EmptyState
            compact
            icon="🌐"
            title="No connectors installed"
            subtitle="Click 'Add connector' above to choose from popular presets."
          />
        ) : (
          <ul className="space-y-2">
            {mcp.data?.servers.map((s) => {
              const isBusy = busy === `mcp-rm:${s.name}`;
              const isConfirming = confirmRemove === `mcp:${s.name}`;
              const preset = presets.data?.presets.find((p) => p.id === s.name);
              const icon = preset?.icon ?? "🌐";
              const label = preset?.label ?? s.name;
              const description =
                preset?.description ??
                (s.url
                  ? `Web-based app connector — ${s.name}.`
                  : `Local tool connector — ${s.name}.`);
              return (
                <UnifiedCapabilityCard
                  key={s.name}
                  icon={icon}
                  label={label}
                  description={description}
                  enabled={s.enabled}
                  essential={s.enabled}
                  essentialLabel="locked"
                  busy={isBusy}
                  anyBusy={!!busy}
                  onToggle={async () => {
                    setBusy(`mcp-tog:${s.name}`);
                    const res = await configureMcpServer({ name: s.name, enabled: !s.enabled });
                    setBusy(null);
                    if (res.ok) {
                      setToast({ kind: "success", text: `Connector "${s.name}" ${s.enabled ? "disabled" : "enabled"}` });
                      void mcp.refetch();
                    } else {
                      setToast({ kind: "error", text: `Error: ${res.error}` });
                    }
                  }}
                  removeLabel={s.enabled ? undefined : "Remove"}
                  onRequestRemove={
                    s.enabled
                      ? undefined
                      : () => setConfirmRemove(`mcp:${s.name}`)
                  }
                  showConfirmRemove={isConfirming}
                  onConfirmRemove={() => void handleRemoveMcp(s.name)}
                  onCancelRemove={() => setConfirmRemove(null)}
                  extraActionLabel="Test connection"
                  onExtraAction={async () => {
                    setBusy(`mcp-test:${s.name}`);
                    const res = await testMcpServer(s.name);
                    setBusy(null);
                    if (res.ok && res.data.ok) {
                      setToast({
                        kind: "success",
                        text: `Test "${s.name}" OK · ${res.data.toolCount ?? "?"} tools available`,
                      });
                    } else {
                      setToast({
                        kind: "error",
                        text: `Test failed: ${res.ok ? res.data.error : res.error}`,
                      });
                    }
                  }}
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* Preset detail modal — collects env vars */}
      {activePreset ? (
        <McpPresetDetailModal
          preset={activePreset}
          installing={busy?.startsWith("mcp-add:") ?? false}
          onClose={() => setActivePreset(null)}
          onInstall={async (envValues) => {
            setBusy(`mcp-add:${activePreset.id}`);
            const res = await addMcpServer({
              name: activePreset.id,
              presetId: activePreset.id,
              env: envValues,
            });
            setBusy(null);
            if (res.ok) {
              setToast({
                kind: "success",
                text: `Connector "${activePreset.label}" installed`,
              });
              void mcp.refetch();
              setShowPresets(false);
              setActivePreset(null);
            } else {
              setToast({ kind: "error", text: `Error: ${res.error}` });
            }
          }}
        />
      ) : null}

      {/* Custom HTTP connector modal — connect any external web app via URL.
          Bridge mcp.add accepts { name, url, auth } natively (the "MCP HTTP +
          Skill" pattern from the marketplace architecture). */}
      {customOpen ? (
        <McpCustomModal
          installing={busy === "mcp-add-custom"}
          existingNames={new Set((mcp.data?.servers ?? []).map((s) => s.name))}
          onClose={() => setCustomOpen(false)}
          onInstall={async ({ name, url, token }) => {
            setBusy("mcp-add-custom");
            const res = await addMcpServer({
              name,
              url,
              auth: token ? "header" : null,
              ...(token ? { env: { AUTHORIZATION: `Bearer ${token}` } } : {}),
            });
            setBusy(null);
            if (res.ok) {
              setToast({ kind: "success", text: `Connector "${name}" installed` });
              void mcp.refetch();
              setCustomOpen(false);
            } else {
              setToast({ kind: "error", text: `Error: ${res.error}` });
            }
          }}
        />
      ) : null}
    </div>
  );
}

/* ── Custom HTTP connector modal ────────────────────────────────── */

function McpCustomModal({
  installing,
  existingNames,
  onClose,
  onInstall,
}: {
  installing: boolean;
  existingNames: Set<string>;
  onClose: () => void;
  onInstall: (v: { name: string; url: string; token: string }) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  // Connector id must be a clean slug (config key) — lowercase + dash.
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const urlOk = /^https?:\/\/.+/i.test(url.trim());
  const nameOk = slug.length >= 2 && !existingNames.has(slug);
  const canInstall = nameOk && urlOk && !installing;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0B0E14] p-5 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-2xl">
            🌐
          </div>
          <div className="flex-1">
            <h3 className="font-display text-base font-bold text-white">
              Custom Connector (HTTP)
            </h3>
            <p className="mt-0.5 text-[11.5px] text-white/65">
              Connect your own app or website. Your agent can use its functions
              automatically once connected.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
              Connector name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Store"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
            {slug && slug !== name.trim().toLowerCase() ? (
              <p className="mt-1 font-mono text-[10px] text-white/40">id: {slug}</p>
            ) : null}
            {name.trim() && !nameOk ? (
              <p className="mt-1 text-[10.5px] text-amber-300">
                {existingNames.has(slug)
                  ? "This name is already used by another connector."
                  : "Name must be at least 2 characters."}
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
              MCP Server URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-app.com/mcp"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
            {url.trim() && !urlOk ? (
              <p className="mt-1 text-[10.5px] text-amber-300">
                URL must start with http:// or https://
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
              Token (optional)
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bearer token if your server requires auth"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
            <p className="mt-1 text-[10.5px] text-white/45">
              💡 Sent as the <code className="text-white/60">Authorization: Bearer …</code> header
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onInstall({ name: slug, url: url.trim(), token: token.trim() })}
            disabled={!canInstall}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[12px] font-bold transition",
              canInstall
                ? "bg-gradient-to-r from-cyan-400 to-emerald-500 text-[#0B0E14] hover:brightness-110"
                : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
            )}
          >
            {installing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */

function HeroBanner({
  icon,
  title,
  subtitle,
  stats,
}: {
  icon: string;
  title: string;
  subtitle: string;
  stats: Array<{ label: string; value: number; tone: "white" | "emerald" | "cyan" }>;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.03] via-[#0B0E14]/40 to-white/[0.02] p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-xl">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-bold text-white">{title}</h3>
          <p className="mt-0.5 text-[12px] text-white/65">{subtitle}</p>
        </div>
        {stats.length > 0 ? (
          <div className="flex shrink-0 items-center gap-2">
            {stats.map((s) => (
              <div
                key={s.label}
                className={cn(
                  "rounded-lg border bg-white/[0.03] px-2.5 py-1.5 text-center",
                  s.tone === "emerald"
                    ? "border-emerald-400/30"
                    : s.tone === "cyan"
                      ? "border-cyan-400/30"
                      : "border-white/10",
                )}
              >
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/55">
                  {s.label}
                </div>
                <div className="font-display text-base font-bold text-white">{s.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function UnifiedCapabilityCard({
  icon,
  label,
  description,
  enabled,
  busy,
  anyBusy,
  variant = "default",
  onToggle,
  primaryActionLabel,
  onPrimaryAction,
  removeLabel,
  onRequestRemove,
  showConfirmRemove,
  onConfirmRemove,
  onCancelRemove,
  extraActionLabel,
  onExtraAction,
  readiness,
  onReadinessClick,
  locked,
  essential,
  essentialLabel,
}: {
  icon: string;
  label: string;
  description: string;
  enabled: boolean;
  busy?: boolean;
  anyBusy?: boolean;
  variant?: "default" | "outline";
  onToggle?: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  removeLabel?: string;
  onRequestRemove?: () => void;
  showConfirmRemove?: boolean;
  onConfirmRemove?: () => void;
  onCancelRemove?: () => void;
  extraActionLabel?: string;
  onExtraAction?: () => void;
  readiness?: CapabilityReadiness;
  onReadinessClick?: () => void;
  /** Needs setup that isn't satisfied yet → can't be turned on; shows a lock. */
  locked?: boolean;
  /** Core capability — always ON, locked-on (toggle disabled, shows "Wajib"). */
  essential?: boolean;
  /** Label shown on the lock badge when essential. Defaults to "wajib". */
  essentialLabel?: string;
}) {
  return (
    <li
      className={cn(
        "rounded-xl border p-3 transition",
        variant === "outline"
          ? "border-white/[0.06] bg-white/[0.01]"
          : enabled
            ? "border-emerald-400/25 bg-white/[0.02]"
            : "border-white/[0.06] bg-white/[0.02]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-xl">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="truncate text-[13px] font-semibold text-white/90">
              {label}
            </span>
            {essential ? (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-emerald-200">
                <Lock className="size-2.5" aria-hidden />
                {essentialLabel ?? "required"}
              </span>
            ) : null}
            {enabled ? (
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-emerald-100">
                active
              </span>
            ) : (
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-white/45">
                off
              </span>
            )}
            {readiness && readiness.status !== "internal" ? (
              <ReadinessBadge
                readiness={readiness}
                onClick={onReadinessClick}
              />
            ) : null}
          </div>
          {description ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-white/70">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onPrimaryAction ? (
            <button
              type="button"
              onClick={onPrimaryAction}
              disabled={anyBusy || busy}
              className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/[0.06] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-100 hover:border-cyan-400/50 hover:bg-cyan-400/10 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {primaryActionLabel}
            </button>
          ) : null}
          {onExtraAction ? (
            <button
              type="button"
              onClick={onExtraAction}
              disabled={anyBusy}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70 hover:border-white/25 hover:text-white disabled:opacity-50"
            >
              {extraActionLabel}
            </button>
          ) : null}
          {onRequestRemove && !showConfirmRemove ? (
            <button
              type="button"
              onClick={onRequestRemove}
              disabled={anyBusy || busy}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/[0.06] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-red-200 hover:border-red-500/50 disabled:opacity-50"
            >
              {removeLabel ?? "Remove"}
            </button>
          ) : null}
          {showConfirmRemove ? (
            <div className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/15 px-1.5 py-0.5">
              <button
                type="button"
                onClick={onConfirmRemove}
                className="inline-flex items-center gap-1 rounded bg-red-500 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110"
              >
                Confirm?
              </button>
              <button
                type="button"
                onClick={onCancelRemove}
                className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
              >
                <X className="size-2.5" aria-hidden />
              </button>
            </div>
          ) : null}
          {locked ? (
            // Needs setup that isn't satisfied → can't enable. Lock pill (click
            // the BUTUH SETUP badge above to see the tutorial / what's missing).
            <span
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/[0.06] px-2 text-amber-200/90"
              title="Setup required before this can be enabled"
              aria-label="Locked — setup required"
            >
              <Lock className="size-3" aria-hidden />
            </span>
          ) : onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              disabled={anyBusy || busy || essential}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50",
                enabled
                  ? "border-emerald-400/40 bg-emerald-400/15"
                  : "border-white/15 bg-white/[0.03]",
              )}
              aria-label={enabled ? "Disable" : "Enable"}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full bg-white shadow transition",
                  enabled ? "translate-x-[22px] bg-emerald-300" : "translate-x-0.5",
                )}
              >
                {busy ? <Loader2 className="size-3 animate-spin text-[#0B0E14]" aria-hidden /> : null}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition",
        active
          ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
          : "border-white/10 bg-white/[0.02] text-white/55 hover:border-white/25 hover:text-white/75",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
  compact,
}: {
  icon: string;
  title: string;
  subtitle: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] text-center",
        compact ? "px-3 py-4" : "px-4 py-8",
      )}
    >
      <div className={cn(compact ? "text-xl" : "mb-2 text-2xl")} aria-hidden>
        {icon}
      </div>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-white/65">
        {title}
      </div>
      <p className="mt-1 text-[11.5px] text-white/55">{subtitle}</p>
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="space-y-3">
      <div className="h-20 animate-pulse rounded-2xl bg-white/[0.02]" />
      <div className="h-32 animate-pulse rounded-2xl bg-white/[0.02]" />
      <div className="h-32 animate-pulse rounded-2xl bg-white/[0.02]" />
    </div>
  );
}

function ErrorBox({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-100">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-red-200">
        Failed to load
      </div>
      <p className="mt-1 text-[11.5px] text-red-100/85">{error ?? "No data"}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-red-100 hover:bg-red-500/20"
      >
        Try again
      </button>
    </div>
  );
}

/* ── MCP Preset Grid ────────────────────────────────────────────── */

function McpPresetGrid({
  presets,
  loading,
  installedNames,
  onPick,
  busyId,
}: {
  presets: McpPreset[];
  loading: boolean;
  installedNames: Set<string>;
  onPick: (preset: McpPreset) => void;
  busyId: string | null;
}) {
  if (loading && presets.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />
        ))}
      </div>
    );
  }
  const sorted = [...presets].sort((a, b) => b.popularity - a.popularity);
  return (
    <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        Popular connectors
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sorted.map((p) => {
          const installed = installedNames.has(p.id);
          const isBusy = busyId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => !installed && onPick(p)}
              disabled={installed || isBusy}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border p-3 text-left transition",
                installed
                  ? "border-emerald-400/30 bg-emerald-400/[0.06] opacity-60"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-cyan-400/40 hover:bg-cyan-400/[0.04]",
              )}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-lg">
                {p.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-white/90">
                    {p.label}
                  </span>
                  {installed ? (
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-emerald-300">
                      ✓ installed
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[10.5px] text-white/55">{p.description}</p>
                <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
                  {p.category}
                  {p.envVars.length > 0
                    ? ` · needs ${p.envVars.length} env var${p.envVars.length > 1 ? "s" : ""}`
                    : ""}
                </div>
              </div>
              {isBusy ? (
                <Loader2 className="size-4 animate-spin text-cyan-300" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── MCP Preset Detail Modal (collects env vars) ────────────────── */

function McpPresetDetailModal({
  preset,
  installing,
  onClose,
  onInstall,
}: {
  preset: McpPreset;
  installing: boolean;
  onClose: () => void;
  onInstall: (env: Record<string, string>) => void;
}) {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const canInstall = preset.envVars
    .filter((e) => e.required)
    .every((e) => (envValues[e.name] ?? "").trim().length > 0);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0B0E14] p-5 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-2xl">
            {preset.icon}
          </div>
          <div className="flex-1">
            <h3 className="font-display text-base font-bold text-white">
              Install: {preset.label}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-white/65">{preset.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {preset.envVars.length > 0 ? (
          <div className="space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              This connector requires:
            </div>
            {preset.envVars.map((e) => (
              <div key={e.name}>
                <label className="mb-1 flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
                  {e.name}
                  {e.required ? <span className="text-amber-300">*</span> : null}
                </label>
                <input
                  type="password"
                  value={envValues[e.name] ?? ""}
                  onChange={(ev) =>
                    setEnvValues({ ...envValues, [e.name]: ev.target.value })
                  }
                  placeholder="Paste your key/token here…"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
                />
                {e.hint ? (
                  <p className="mt-1 text-[10.5px] text-white/45">💡 {e.hint}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.04] px-3 py-2 text-[11.5px] text-emerald-100">
            ✓ No env vars required. Ready to install.
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onInstall(envValues)}
            disabled={!canInstall || installing}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[12px] font-bold transition",
              canInstall && !installing
                ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] hover:brightness-110"
                : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
            )}
          >
            {installing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            Install Connector
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Readiness badge + modal ─────────────────────────────────────── */

function ReadinessBadge({
  readiness,
  onClick,
}: {
  readiness: CapabilityReadiness;
  onClick?: () => void;
}) {
  const tone = readinessBadgeTone(readiness.status);
  return (
    <button
      type="button"
      onClick={onClick}
      title={readiness.summary}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] transition hover:brightness-110",
        tone.bg,
        tone.border,
        tone.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      {tone.label}
    </button>
  );
}

function RequirementsModal({
  icon,
  label,
  readiness,
  onClose,
}: {
  icon: string;
  label: string;
  readiness: CapabilityReadiness;
  onClose: () => void;
}) {
  const tone = readinessBadgeTone(readiness.status);
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0B0E14] p-5 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-2xl">
            {icon}
          </div>
          <div className="flex-1">
            <h3 className="font-display text-base font-bold text-white">
              {label}
            </h3>
            <div className="mt-1 flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em]",
                  tone.bg,
                  tone.border,
                  tone.text,
                )}
              >
                <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                {tone.label}
              </span>
              <span className="text-[11.5px] text-white/65">
                {readiness.summary}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            What's required:
          </div>
          {readiness.checks.length === 0 ? (
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.04] px-3 py-3 text-[11.5px] text-emerald-100">
              ✓ No special requirements. Ready to go.
            </div>
          ) : (
            readiness.checks.map((c, i) => (
              <RequirementRow key={i} check={c} />
            ))
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RequirementRow({ check }: { check: { requirement: Requirement; satisfied: boolean; note: string } }) {
  const r = check.requirement;
  const [guideOpen, setGuideOpen] = useState(false);
  const kindLabel = (() => {
    switch (r.kind) {
      case "llm-key":
        return "LLM Key";
      case "channel":
        return "Channel";
      case "env":
        return "Env var";
      case "external":
        return "External";
      case "mcp-server":
        return "Connector";
    }
  })();
  const guide = r.setupGuide;
  const hasGuide = !!guide && !check.satisfied;
  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition",
        check.satisfied
          ? "border-emerald-400/25 bg-emerald-400/[0.04]"
          : (r.kind === "external" && r.blocking)
            ? "border-red-500/30 bg-red-500/[0.05]"
            : "border-amber-400/25 bg-amber-400/[0.04]",
      )}
    >
      <div className="flex items-start gap-2">
        {check.satisfied ? (
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-400/30 text-[9px] font-bold text-emerald-100">
            ✓
          </span>
        ) : (r.kind === "external" && r.blocking) ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[12.5px] font-semibold text-white/90">
              {r.label}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
              {kindLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-white/65">{check.note}</p>
          {r.kind === "env" && r.hint ? (
            <p className="mt-0.5 text-[10.5px] text-white/45">💡 {r.hint}</p>
          ) : null}
          {r.kind === "env" ? (
            <p className="mt-0.5 font-mono text-[10px] text-white/40">
              {r.name}
            </p>
          ) : null}

          {hasGuide ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setGuideOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/[0.06] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-100 hover:border-cyan-400/50 hover:bg-cyan-400/10"
              >
                {guideOpen ? "▼ Close guide" : "▶ How to set up"}
              </button>
              {guideOpen ? <SetupGuideBody guide={guide!} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SetupGuideBody({
  guide,
}: {
  guide: NonNullable<Requirement["setupGuide"]>;
}) {
  const [promptCopied, setPromptCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    [],
  );
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-white/10 bg-[#0B0E14]/60 p-3">
      {guide.intro ? (
        <p className="text-[11.5px] leading-relaxed text-white/75">
          {guide.intro}
        </p>
      ) : null}

      <ol className="space-y-2 pl-4">
        {guide.steps.map((step, idx) => (
          <li key={idx} className="relative">
            <span className="absolute -left-4 flex size-3.5 items-center justify-center rounded-full bg-cyan-400/30 font-mono text-[9px] font-bold text-cyan-100">
              {idx + 1}
            </span>
            <div className="ml-1">
              <div className="text-[12px] font-semibold text-white/90">
                {step.title}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-white/65">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-1.5">
        {guide.getApiKeyUrl ? (
          <a
            href={guide.getApiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-100 hover:border-emerald-400/50 hover:bg-emerald-400/15"
          >
            🔑 Get your API key ↗
          </a>
        ) : null}
        {guide.docsUrl ? (
          <a
            href={guide.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:border-white/30 hover:text-white"
          >
            📖 Official docs ↗
          </a>
        ) : null}
      </div>

      {guide.chatPrompt ? (
        <div className="rounded-md border border-fuchsia-400/20 bg-fuchsia-400/[0.04] p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.18em] text-fuchsia-200">
              💬 Or just ask your agent:
            </div>
            <button
              type="button"
              onClick={() => {
                if (guide.chatPrompt) {
                  void navigator.clipboard.writeText(guide.chatPrompt);
                  setPromptCopied(true);
                  if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
                  copyTimerRef.current = setTimeout(() => setPromptCopied(false), 1500);
                }
              }}
              className="rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fuchsia-200 hover:bg-fuchsia-400/15"
            >
              {promptCopied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[11.5px] italic leading-relaxed text-white/80">
            &ldquo;{guide.chatPrompt}&rdquo;
          </p>
          <p className="mt-1 text-[10px] text-white/40">
            Paste this in your agent's chat — let the agent handle the setup for you.
          </p>
        </div>
      ) : null}
    </div>
  );
}
