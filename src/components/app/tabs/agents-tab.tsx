"use client";

/**
 * Agents tab — Two-pane orchestrator. Left: roster sidebar with search +
 * filter chips. Right: 6-tab detail (Profil / Persona / Senjata / Skill /
 * Saluran / Rutinitas). Centered modal for "Bikin agen baru". Toast bar
 * at the bottom for all flows.
 *
 * Engine RPC coverage (verified 2026-05-15):
 *   - agents.list (+ refetch on cron/channels broadcast)
 *   - agents.create / update / delete
 *   - agents.files.list/get/set (via Persona panel)
 *   - models.list / models.authStatus
 *   - tools.catalog (via Senjata panel)
 *   - skills.status (via Skill panel)
 *   - cron.list (via Rutinitas panel, filtered by agentId)
 *   - channels.status (via Saluran panel, reverse view)
 *   - config.patch (set default, skill/tool override)
 *
 * Pattern parity with /app/cron: centered modals, two-pane layout, mass-
 * market voice. NO slide-in drawer.
 */
import { AnimatePresence, motion } from "framer-motion";
import { Bot, RefreshCw, Sparkles, X as XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChannelsDashboard } from "@/hooks/use-api";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { cn } from "@/lib/utils";
import {
  AgentCapabilityWizard,
  type WizardCreationContext,
} from "@/components/app/agents/agent-capability-wizard";
import { AgentCreateChoice } from "@/components/app/agents/agent-create-choice";
import { AgentDetail } from "@/components/app/agents/agent-detail";
import { AgentImportDialog } from "@/components/app/agents/agent-import-dialog";
import { AgentRoster } from "@/components/app/agents/agent-roster";
import {
  useAgentsList,
  useModelsAuthStatus,
  useModelOptions,
} from "@/components/app/agents/use-agents-data";
import { useCapabilityPolicyHydration } from "@/components/app/agents/use-capability-policy";

type WelcomeKind = WizardCreationContext["kind"] | "clone" | "import";

export function AgentsTab() {
  const list = useAgentsList();
  const models = useModelOptions();
  const auth = useModelsAuthStatus();
  const channels = useChannelsDashboard();
  // D13: hydrate the admin capability hide/lock policy once (default empty = no-op).
  useCapabilityPolicyHydration();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Single entry point: "+ Baru" opens the choice modal which delegates
  // to one of {wizard, clone, import}. Wizard and Import use their own
  // modals; clone is handled inline inside the choice modal (clone-pick
  // sub-step). Advanced manual form removed per chief 2026-05-27 — mass-
  // market UX doesn't need it.
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Welcome banner state — `kind` lets the banner render context-aware
  // CTAs (e.g. "Pair Telegram now" if user picked Telegram in wizard).
  const [welcomeBannerFor, setWelcomeBannerFor] = useState<{
    agentId: string;
    message: string;
    kind?: WelcomeKind;
    channelTarget?: string;
    templateLabel?: string;
  } | null>(null);
  const [toast, setToast] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const agents = list.data?.agents ?? [];
  const defaultId = list.data?.defaultId ?? "";
  const allAgentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  // Engine `model.options` returns provider-grouped rows ({slug,name,models[]}),
  // NOT a flat {models}. Flatten to ModelChoice[] (same shape the wizard uses)
  // so the Profil panel's model dropdown is actually populated. Reading
  // `.models` here was always undefined → empty dropdown (P0 bug, 2026-05-30).
  const modelsList = useMemo(() => {
    const rows = models.data?.providers ?? [];
    return rows
      .filter((r) => Array.isArray(r.models) && r.models.length > 0)
      .flatMap((r) =>
        r.models.map((m) => ({ id: m, name: m, provider: r.slug })),
      );
  }, [models.data]);
  const authProviders = auth.data?.providers ?? [];

  // Auto-select default agent (or first agent) on first load.
  useEffect(() => {
    if (!selectedId && agents.length > 0) {
      setSelectedId(defaultId || agents[0].id);
    }
  }, [selectedId, agents, defaultId]);

  // If the selected agent got deleted by another client, clear selection.
  useEffect(() => {
    if (selectedId && !agents.find((a) => a.id === selectedId) && !list.loading) {
      setSelectedId(agents[0]?.id ?? null);
    }
  }, [selectedId, agents, list.loading]);

  const selectedAgent = selectedId
    ? agents.find((a) => a.id === selectedId) ?? null
    : null;

  // Channel routing count per agent (for roster chip).
  const routedChannelCountByAgent = useMemo(() => {
    const m = new Map<string, number>();
    const dash = channels.data;
    if (!dash) return m;
    for (const ch of dash.connectedChannels) {
      for (const acc of ch.accounts) {
        const effective = acc.routedAgentId ?? defaultId;
        if (!effective) continue;
        m.set(effective, (m.get(effective) ?? 0) + 1);
      }
    }
    return m;
  }, [channels.data, defaultId]);

  const refreshAll = useCallback(() => {
    void list.refetch();
    void models.refetch();
    void auth.refetch();
  }, [list, models, auth]);

  const handleCreated = useCallback(
    (
      agentId: string,
      welcomeMessage?: string,
      context?: {
        kind?: WelcomeKind;
        channelTargets?: string[];
        templateLabel?: string;
      },
    ) => {
      setSelectedId(agentId);
      void list.refetch();
      const channelTarget = context?.channelTargets?.[0];
      if (welcomeMessage) {
        setWelcomeBannerFor({
          agentId,
          message: welcomeMessage,
          kind: context?.kind,
          channelTarget,
          templateLabel: context?.templateLabel,
        });
      }
      // NOTE 2026-05-27: channel pairing now happens INSIDE the wizard
      // (Step 5 — see agent-capability-wizard.tsx Step5Pairings).
      // NOTE 2026-06-08: the standalone /app/channels tab was deleted; channel
      // management is now per-agent (agent detail -> Saluran sub-tab). The
      // clone/import welcome banner's "Pair <channel>" CTA opens that sub-tab
      // via #tab=saluran (buildCtas), so no route redirect is needed here.
    },
    [list],
  );

  // Auto-dismiss welcome banner when user switches to a different agent
  useEffect(() => {
    if (welcomeBannerFor && selectedId !== welcomeBannerFor.agentId) {
      setWelcomeBannerFor(null);
    }
  }, [selectedId, welcomeBannerFor]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow="✦ AGENTS"
        title="Agent Roster"
        subtitle="Each agent = its own AI persona. Set identity, prompt, weapons, skills, and where they connect."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshAll}
              disabled={list.loading}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/70 transition hover:border-cyan-400/40 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  list.loading && "animate-spin",
                )}
                aria-hidden
              />
              Refresh
            </button>
          </div>
        }
      />

      {/* Two-pane layout */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_1fr] xl:grid-cols-[20rem_1fr]">
        <AgentRoster
          agents={agents}
          defaultId={defaultId}
          selectedId={selectedId}
          routedChannelCountByAgent={routedChannelCountByAgent}
          loading={list.loading}
          onSelect={setSelectedId}
          /* Single entry point: "+ Baru" opens choice modal that
             delegates to wizard / form lengkap / duplikat / import.
             Sidebar no longer has a separate Import button. */
          onCreate={() => setChoiceOpen(true)}
        />

        {selectedAgent ? (
          <div className="flex h-full min-h-0 flex-col">
            {welcomeBannerFor?.agentId === selectedAgent.id ? (
              <WelcomeBanner
                message={welcomeBannerFor.message}
                kind={welcomeBannerFor.kind}
                channelTarget={welcomeBannerFor.channelTarget}
                templateLabel={welcomeBannerFor.templateLabel}
                agentId={selectedAgent.id}
                onDismiss={() => setWelcomeBannerFor(null)}
              />
            ) : null}
            <AgentDetail
              key={selectedAgent.id}
              agent={selectedAgent}
              isDefault={selectedAgent.id === defaultId}
              allAgentIds={allAgentIds}
              defaultId={defaultId}
              modelsList={modelsList}
              authProviders={authProviders}
              modelsLoading={models.loading}
              onAfterChange={() => {
                void list.refetch();
              }}
              onAfterDelete={() => {
                setSelectedId(null);
                void list.refetch();
              }}
              setToast={setToast}
            />
          </div>
        ) : (
          <EmptyDetail
            onCreate={() => setChoiceOpen(true)}
            loading={list.loading}
            hasAgents={agents.length > 0}
          />
        )}
      </div>

      {/* Choice modal — single "+ Baru" entry point. 3 options upfront. */}
      <AgentCreateChoice
        open={choiceOpen}
        existingAgents={agents}
        onClose={() => setChoiceOpen(false)}
        onPickWizard={() => {
          setChoiceOpen(false);
          setWizardOpen(true);
        }}
        onPickImport={() => {
          setChoiceOpen(false);
          setImportOpen(true);
        }}
        onCloned={(id) => {
          setChoiceOpen(false);
          handleCreated(
            id,
            "Duplicated successfully. Adjust the name, persona, or capabilities in the tabs below.",
            { kind: "clone" },
          );
        }}
        setToast={setToast}
      />

      {/* Wizard — pilihan "Rancang sendiri" dari choice modal. */}
      <AgentCapabilityWizard
        open={wizardOpen}
        existingAgents={agents}
        onClose={() => setWizardOpen(false)}
        onCreated={(id, msg, ctx) =>
          handleCreated(id, msg, {
            kind: ctx?.kind,
            channelTargets: ctx?.channelTargets,
            templateLabel: ctx?.templateLabel,
          })
        }
        setToast={setToast}
      />

      {/* Import dialog */}
      <AgentImportDialog
        open={importOpen}
        existingAgents={agents}
        onClose={() => setImportOpen(false)}
        onImported={(id) =>
          handleCreated(
            id,
            "Imported successfully. Review the agent's Persona + Capabilities before use — make sure the SOUL, skills, and AI keys are correct.",
            { kind: "import" },
          )
        }
        setToast={setToast}
      />

      {/* Toast */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className={cn(
              "pointer-events-none fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg border px-4 py-2 text-[12px] shadow-lg backdrop-blur-xl",
              toast.kind === "success"
                ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                : toast.kind === "error"
                  ? "border-red-500/40 bg-red-500/15 text-red-100"
                  : "border-cyan-400/40 bg-cyan-400/15 text-cyan-100",
            )}
            role="status"
            aria-live="polite"
          >
            {toast.text}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function EmptyDetail({
  onCreate,
  loading,
  hasAgents,
}: {
  onCreate: () => void;
  loading: boolean;
  hasAgents: boolean;
}) {
  if (loading && !hasAgents) {
    return (
      <div className="flex items-center justify-center px-6 py-10 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
        <RefreshCw className="mr-2 size-4 animate-spin" aria-hidden />
        Loading agents…
      </div>
    );
  }
  return (
    <section className="flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-3 inline-flex size-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03]">
          <Bot className="size-7 text-white/40" aria-hidden />
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
          ✦ Roster empty
        </div>
        <h2 className="mt-1 font-display text-xl font-bold text-white">
          Create your first agent
        </h2>
        <p className="mt-1 text-[13px] text-white/65">
          Each agent has its own persona, prompt, weapons, and skills.
          Start with one, scale as your guild grows.
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-2 text-[13px] font-bold text-[#0B0E14] shadow-[0_12px_32px_-12px_rgba(99,102,241,0.6)] transition hover:brightness-110"
        >
          + Create your first agent
        </button>
      </div>
    </section>
  );
}

/* ── Welcome banner — adaptive based on how agent was created ────── */

const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  slack: "Slack",
};

/**
 * Context-aware banner. Copy + CTA differ based on `kind`:
 *
 *   wizard-blank    → "Cek persona + atur kemampuan" (persona/model set in-wizard)
 *   wizard (with channelTarget) → "Lanjut pair WhatsApp di tab Saluran"
 *   clone           → "Sesuaiin nama / persona / kemampuan agar gak persis"
 *   import          → "Cek SOUL + kunci AI sebelum dipakai"
 */
function WelcomeBanner({
  message,
  kind,
  channelTarget,
  templateLabel,
  agentId,
  onDismiss,
}: {
  message: string;
  kind?: WelcomeKind;
  channelTarget?: string;
  templateLabel?: string;
  agentId: string;
  onDismiss: () => void;
}) {
  const ctas = buildCtas({ kind, channelTarget, templateLabel, agentId });

  return (
    <div className="m-4 mb-0 rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-400/[0.08] via-cyan-400/[0.04] to-fuchsia-400/[0.05] px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-400/15">
          <Sparkles className="size-4 text-emerald-200" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-200">
            🎉 New agent created!
          </div>
          <p className="mt-0.5 text-[12.5px] text-white/85">{message}</p>
          {ctas.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ctas.map((c) => (
                <a
                  key={c.label}
                  href={c.href}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition",
                    c.primary
                      ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-100 hover:bg-cyan-400/25"
                      : "border-white/10 bg-white/[0.04] text-white/70 hover:border-white/25 hover:text-white",
                  )}
                >
                  {c.label} →
                </a>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
          aria-label="Dismiss welcome"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function buildCtas(opts: {
  kind?: WelcomeKind;
  channelTarget?: string;
  templateLabel?: string;
  agentId: string;
}): Array<{ label: string; href: string; primary?: boolean }> {
  const out: Array<{ label: string; href: string; primary?: boolean }> = [];

  // Channel CTA always primary if user picked one — that's THE next step.
  if (opts.channelTarget && CHANNEL_LABEL[opts.channelTarget]) {
    // The welcome banner only shows while THIS agent is selected, so the
    // channel CTA jumps to its Saluran sub-tab (agent-detail honors #tab=).
    out.push({
      label: `Pair ${CHANNEL_LABEL[opts.channelTarget]}`,
      href: `#tab=saluran`,
      primary: true,
    });
  }

  if (opts.kind === "wizard-blank") {
    // New flow already wrote the persona + set the model in-wizard, so nudge to
    // review/refine rather than to write-from-scratch.
    out.push({
      label: "Review Persona",
      href: "#tab=persona",
      primary: !opts.channelTarget,
    });
    out.push({ label: "Configure Capabilities", href: "#tab=kemampuan" });
  } else if (opts.kind === "clone") {
    out.push({
      label: "Customize Identity",
      href: "#tab=profil",
      primary: true,
    });
    out.push({ label: "Edit Persona", href: "#tab=persona" });
  } else if (opts.kind === "import") {
    out.push({
      label: "Review Persona",
      href: "#tab=persona",
      primary: true,
    });
    out.push({ label: "Verify Capabilities", href: "#tab=kemampuan" });
    out.push({ label: "Connect AI Keys", href: "/app/providers" });
  }
  return out;
}
