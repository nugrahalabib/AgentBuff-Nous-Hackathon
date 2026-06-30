"use client";

/**
 * AgentCapabilityWizard — full-screen modal for new agent creation.
 *
 * Every field written here is PROFILE-SCOPED to the NEW agent only — it never
 * mutates the root/global config or any existing agent (audited 2026-06-08:
 * create rejects id=='default', model/SOUL/skills go to profiles/<id>/, and the
 * only global write is channel routing which is agent-keyed + RFC-7396 merged).
 *
 * Step 1: Role picker (template OR "Mulai dari kosong")
 * Step 2: Identity + Persona + Engine Model + Channel target
 *   - nama, emoji, theme color
 *   - personaTagline / role (one-line description, profile sidecar)
 *   - engine model: main + fallback dropdowns (authenticated providers from
 *     model.options) — written to the new profile's config.yaml::model
 *   - channel target chips (web default, telegram/wa/discord/slack/google_chat)
 * Step 3: SOUL editor — editable textarea (template SOUL or AgentBuff default);
 *   optional brief→agents.soulGenerate. The primary button FINISHES (create).
 * Step 4 (only if non-web channels picked): create-then-pair — the agent is
 *   created first, then each channel pairs via PairingDialog bound to it.
 *
 * Tools/skills are intentionally NOT collected here — a new agent inherits the
 * container defaults and is fine-tuned post-create in the Kemampuan tab.
 *
 * Finish RPCs: blank -> agents.create (+ post-create model patch); template ->
 * agents.template.instantiate. Both carry name/emoji/theme/role/model/fallbacks/
 * soul as per-profile overrides.
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { pickDefaultModel } from "@/lib/models/pick-default-model";
import { type AgentRow, suggestAgentIdFromName } from "./helpers";
import { createAgent, useModelOptions } from "./use-agents-data";
import {
  CHANNEL_CATALOG,
  type ChannelCatalogEntry,
} from "@/components/app/channels/channel-catalog";
import {
  PairingDialog,
  type PairingSuccessInfo,
} from "@/components/app/channels/pairing-dialog";
import {
  patchConfigPath,
  getConfigSnapshot,
} from "@/components/app/channels/config-patch";
import {
  upsertRouteBinding,
  type AnyBinding,
} from "@/components/app/channels/bindings";
import { useChannelsDashboard, useProfile } from "@/hooks/use-api";
import { SkillsSection, ToolsSection } from "./agent-kemampuan-panel";
import {
  deriveArchetype,
  buildSoul,
  type SoulContext,
} from "@/lib/onboarding/archetypes";
import {
  Step1Purpose,
  Step2Persona,
  Step3Engine,
  MAX_GOALS,
  MAX_TITLES,
  MAX_PERSONALITY,
} from "./agent-wizard-steps";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

// Steps (2026-06-08): 1 Role · 2 Identity+Model+Channel · 3 SOUL (→ CREATE) ·
// 4 Channel pairing (post-create, only if non-web channels) · 5 Kemampuan
// (post-create tools+skills). Chief's order: build → channel → kemampuan →
// selesai. The Kemampuan step REUSES the verified per-agent ToolsSection +
// SkillsSection bound to the just-created agent id, so every toggle is
// profile-scoped (never global, never an existing agent). Plugins & connectors
// are GLOBAL and are deliberately NOT surfaced here. Steps 4 + 5 are reachable
// only AFTER a successful create (createdAgentId set) — never via Back-nav.
type WizardStep = 1 | 2 | 3 | 4 | 5;

export type WizardCreationContext = {
  kind: "wizard-blank";
  templateLabel?: string;
  channelTargets: string[];
};

export function AgentCapabilityWizard({
  open,
  existingAgents,
  onClose,
  onCreated,
  setToast,
}: {
  open: boolean;
  existingAgents: AgentRow[];
  onClose: () => void;
  onCreated: (agentId: string, welcome?: string, ctx?: WizardCreationContext) => void;
  setToast: ToastSetter;
}) {
  const modelOptions = useModelOptions();
  // Owner context (who the user is) — pulled from the SAME onboarding data so
  // every new agent knows its human: name + role + business/jurusan + city +
  // bidang. Fed into buildSoul's "Tentang {nickname}" section, exactly like the
  // onboarding flow does. No re-collection — just reuse what's already saved.
  const profileQ = useProfile();
  // Channels dashboard — used at the pairing step untuk detect channel yang udah
  // ter-pair (untuk agent lain). Agent baru yang pilih channel yang sama
  // TIDAK boleh re-pair (overwrite session — bug 2026-05-27 dari chief)
  // — harus cuma upsert binding biar agent baru ikut handle traffic.
  const channelsDashboard = useChannelsDashboard();

  // ── Wizard state
  const [step, setStep] = useState<WizardStep>(1);
  // Purpose → archetype (auto-derived, onboarding-style — replaces templates)
  const [goalIds, setGoalIds] = useState<string[]>([]);
  // Identity + structured persona (feeds buildSoul)
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [theme, setTheme] = useState<string>("cyan");
  const [tone, setTone] = useState<string>("santai");
  const [userTitles, setUserTitles] = useState<string[]>([]);
  const [personality, setPersonality] = useState<string[]>([]);
  const [language, setLanguage] = useState<string>("id");
  const [emojiUsage, setEmojiUsage] = useState<string>("some");
  const [responseStyle, setResponseStyle] = useState<string>("balanced");
  // Engine model
  const [modelPrimary, setModelPrimary] = useState<string>("");
  const [modelFallback, setModelFallback] = useState<string>("");
  // Channels
  const [channels, setChannels] = useState<Set<string>>(new Set(["web"]));
  // SOUL — auto-built from buildSoul(); soulDraft holds a manual/AI edit once
  // the user touches it (soulEdited=true), otherwise the live buildSoul output
  // is the source of truth.
  const [soulDraft, setSoulDraft] = useState<string>("");
  const [soulEdited, setSoulEdited] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // ── Auto-derived archetype + live SOUL.md (the onboarding pipeline, reused).
  const archetype = useMemo(() => deriveArchetype({ goals: goalIds }), [goalIds]);
  const owner = profileQ.data;
  const soulContext = useMemo<SoulContext>(() => {
    const p = owner?.profile ?? null;
    // Name: onboarding nickname first, then the account name, else "" (buildSoul
    // falls back to "partner kamu"). industryIds is a CSV column → split to array.
    const nickname = (p?.nickname || owner?.user?.name || "").trim();
    const industryIds = (p?.industryIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      agentName: name,
      nickname,
      userTitles,
      tone,
      personality,
      language,
      emojiUsage,
      responseStyle,
      goals: goalIds,
      // Owner context — pulled from onboarding so the agent knows its human.
      role: p?.role ?? null,
      jurusan: p?.jurusan ?? null,
      businessName: p?.businessName ?? null,
      city: p?.city ?? null,
      industryIds,
    };
  }, [
    owner,
    name,
    userTitles,
    tone,
    personality,
    language,
    emojiUsage,
    responseStyle,
    goalIds,
  ]);
  const generatedSoul = useMemo(
    () => buildSoul(archetype.id, soulContext),
    [archetype.id, soulContext],
  );
  // The effective SOUL the agent gets: a manual/AI edit if present, else live build.
  const soulContent = soulEdited ? soulDraft : generatedSoul;

  // Capped multi-toggle helpers for the structured persona pickers.
  const toggleGoal = (id: string) =>
    setGoalIds((prev) =>
      prev.includes(id)
        ? prev.filter((g) => g !== id)
        : prev.length >= MAX_GOALS
          ? prev
          : [...prev, id],
    );
  const toggleTitle = (id: string) =>
    setUserTitles((prev) =>
      prev.includes(id)
        ? prev.filter((t) => t !== id)
        : prev.length >= MAX_TITLES
          ? prev
          : [...prev, id],
    );
  const togglePersonality = (id: string) =>
    setPersonality((prev) =>
      prev.includes(id)
        ? prev.filter((t) => t !== id)
        : prev.length >= MAX_PERSONALITY
          ? prev
          : [...prev, id],
    );

  // ── Step 5 (in-wizard pairing) state
  // After step 4 Finish, if user picked non-web channel(s), wizard
  // creates the agent and advances to step 5 with these tracked:
  //   - createdAgentId: id of the newly-created agent
  //   - pairingChannel: which channel's PairingDialog is currently open
  //   - pairedChannels: which channels successfully paired (UI status)
  //   - finishCtx: ready-to-fire onCreated context (used at "Selesai")
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [pairingChannel, setPairingChannel] = useState<ChannelCatalogEntry | null>(null);
  const [pairedChannels, setPairedChannels] = useState<Set<string>>(new Set());
  const [finishCtx, setFinishCtx] = useState<WizardCreationContext | null>(null);
  const [finishMsg, setFinishMsg] = useState<string>("");

  // ── Reset state on close
  useEffect(() => {
    if (!open) {
      setStep(1);
      setGoalIds([]);
      setName("");
      setEmoji("");
      setTheme("cyan");
      setTone("santai");
      setUserTitles([]);
      setPersonality([]);
      setLanguage("id");
      setEmojiUsage("some");
      setResponseStyle("balanced");
      setModelPrimary("");
      setModelFallback("");
      setChannels(new Set(["web"]));
      setSoulDraft("");
      setSoulEdited(false);
      setSubmitting(false);
      setCreatedAgentId(null);
      setPairingChannel(null);
      setPairedChannels(new Set());
      setFinishCtx(null);
      setFinishMsg("");
    }
  }, [open]);

  // ── Build flat model choices for the picker.
  //
  // Source of truth = `model.options::providers[]` where `models.length > 0`.
  // Hermes server-side already filters providers by available keys when
  // building this list — provider with `models[].length > 0` means it
  // has a working API key + model catalog. Do NOT try to cross-match with
  // models.authStatus.provider because the slugs DIFFER (authStatus uses
  // `google`, model.options uses `gemini` for the same provider). Bug
  // 2026-05-27: wizard showed "no provider authed" even though Gemini
  // worked, because the cross-match always returned empty.
  const flatModelChoices = useMemo(() => {
    const rows = modelOptions.data?.providers ?? [];
    return rows
      .filter((r) => Array.isArray(r.models) && r.models.length > 0)
      .flatMap((r) =>
        r.models.map((m) => ({
          providerSlug: r.slug,
          providerName: r.name || r.slug,
          model: m,
        })),
      );
  }, [modelOptions.data]);
  // Smart default: pick the best model for the connected provider(s) via the
  // SHARED rule (NOUS free-tier ":free" preference, fast/cheap otherwise) so the
  // wizard agrees with onboarding's apply-to-container. Falls back to the first
  // listed model if the rule yields nothing.
  useEffect(() => {
    if (step === 3 && !modelPrimary && flatModelChoices.length > 0) {
      const rows = modelOptions.data?.providers ?? [];
      const provs = rows
        .filter((r) => Array.isArray(r.models) && r.models.length > 0)
        .map((r) => ({ slug: r.slug, models: r.models ?? [] }));
      setModelPrimary(
        pickDefaultModel(provs)?.model ?? flatModelChoices[0].model,
      );
    }
  }, [step, modelPrimary, flatModelChoices, modelOptions.data]);

  // NOTE: we deliberately do NOT auto-fill name/emoji. Naming is the user's job
  // in Step 2 (chief: "nama ga muncul sebelum diisi"). The name input shows the
  // archetype defaultName only as a PLACEHOLDER hint; emoji falls back to the
  // archetype default at create time if the user leaves it blank.

  // ── Validation per step
  const canAdvance = useMemo(() => {
    if (step === 1) return goalIds.length > 0; // at least one purpose picked
    if (step === 2) return name.trim().length > 0; // name required
    if (step === 3) return modelPrimary.trim().length > 0; // engine model required
    return false;
  }, [step, goalIds, name, modelPrimary]);

  // ── Channel targets derived
  const channelTargets = useMemo(
    () => Array.from(channels).filter((c) => c !== "web"),
    [channels],
  );

  // Progress display. Web-only flow skips step 4 (pairing), so its visible
  // sequence is 1,2,3,5 -> shown as 4 dots with step 5 mapped to position 4.
  const hasChannelStep = channelTargets.length > 0;
  const totalSteps = hasChannelStep ? 5 : 4;
  const displayStep =
    step <= 3 ? step : hasChannelStep ? step : step - 1;

  // ── Per-channel pre-existing pairing status (for step 5 branching)
  //
  // Engine reality (Hermes 0.14 + agentbuff-multichannel plugin):
  //   Native Hermes reads ONE bot token per channel via env. The
  //   agentbuff-multichannel plugin BYPASSES that by registering a synthetic
  //   platform per account (<base>__<account>) so N accounts of the same
  //   channel run in ONE gateway process — PROVEN live: 2 Telegram bots (R8)
  //   + 2 WhatsApp numbers (2026-05-29) running concurrently. Catalog.multiAccount
  //   is now true for telegram/whatsapp/discord/slack/google_chat.
  //   - Re-pair = overwrite the session for THAT account only. Bind-only path
  //     (update bindings[] without touching credentials) = safe, won't disturb
  //     other accounts' live sessions.
  //
  // Map shape: channelId → { paired, accountIds[], routedAgentId? }.
  // accountIds = list of all account_id under that channel namespace.
  // routedAgentId = the agent currently bound to channel's default
  // account (from connectedChannels.routedAgentId).
  const channelStatusMap = useMemo(() => {
    type Status = {
      paired: boolean;
      accountIds: string[];
      routedAgentId: string | null;
    };
    const map = new Map<string, Status>();
    const list = channelsDashboard.data?.connectedChannels ?? [];
    for (const entry of list) {
      const accountIds = entry.accounts
        .map((a) => a.accountId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      map.set(entry.channelId, {
        paired: accountIds.length > 0,
        accountIds,
        routedAgentId: entry.routedAgentId ?? null,
      });
    }
    return map;
  }, [channelsDashboard.data]);

  // ── Bind agent ke channel yang udah ter-pair (no re-pair). Step 5
  //    "Hubungkan agent ini" button entry point. Patches `bindings[]`
  //    only — doesn't touch channel credential config, so existing
  //    session (other agent's WA, etc.) stays intact.
  const handleBindOnly = async (channelId: string, accountId: string) => {
    if (!createdAgentId) {
      setToast({ kind: "error", text: "Agent has not been created yet." });
      return;
    }
    try {
      const snap = await getConfigSnapshot();
      const existingBindings =
        (snap.config?.bindings as AnyBinding[] | undefined) ?? [];
      const newBindings = upsertRouteBinding(existingBindings, {
        type: "route",
        agentId: createdAgentId,
        match: {
          channel: channelId,
          // Bridge convention: top-level (default) account uses
          // accountId="default" in bindings.match. Multi-account uses
          // the actual account_id slug.
          accountId: accountId || "default",
        },
      });
      await patchConfigPath([], { bindings: newBindings });
      // Refresh dashboard so subsequent step 5 reads see new binding
      void channelsDashboard.refetch?.();
      setPairedChannels((prev) => {
        const next = new Set(prev);
        next.add(channelId);
        return next;
      });
      const entry = CHANNEL_CATALOG.find((c) => c.id === channelId);
      setToast({
        kind: "success",
        text: `✓ Agent connected to ${entry?.label ?? channelId}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ kind: "error", text: `Failed to connect: ${msg}` });
    }
  };

  // ── Submit
  const handleFinish = async () => {
    setSubmitting(true);
    const friendlyName = name.trim();
    const idHint =
      suggestAgentIdFromName(friendlyName) ||
      `agen-${Math.random().toString(36).slice(2, 8)}`;
    const newId = uniquifyId(idHint, new Set(existingAgents.map((a) => a.id)));

    let agentId = newId;
    let welcomeMsg = "";
    let ok = false;
    let err = "";
    let ctx: WizardCreationContext;

    // Capabilities (skills/tools) are GLOBAL — never set per-agent here. New
    // agents inherit the container-wide set; nothing skill-related is passed.
    const fallbacks = modelFallback.trim() ? [modelFallback.trim()] : undefined;
    // Provider slug for the chosen model — disambiguates multi-provider model
    // ids so the bridge resolves the EXACT provider (e.g. gpt-5.5 → openai-codex
    // instead of guessing → gemini fallback). Without this the new agent's
    // model could land on the wrong provider at runtime.
    const modelProviderSlug = flatModelChoices.find(
      (c) => c.model === modelPrimary.trim(),
    )?.providerSlug;

    // Always createAgent — identity + the rich SOUL.md come from the structured
    // persona (deriveArchetype + buildSoul). `description` = the auto-derived
    // specialization (capitalized), mirroring onboarding's agents.update pattern
    // so the agent's "Peran" reads as a natural Bahasa noun phrase.
    const description =
      archetype.specialization.charAt(0).toUpperCase() +
      archetype.specialization.slice(1);
    const r = await createAgent({
      agentId: newId,
      name: friendlyName,
      // Fall back to the archetype's emoji if the user didn't pick one — the
      // emoji input is no longer auto-seeded, so the agent still gets a face.
      emoji: emoji.trim() || archetype.emoji || undefined,
      theme,
      model: modelPrimary.trim() || undefined,
      providerSlug: modelProviderSlug,
      fallbacks,
      description,
      soulContent: soulContent.trim(),
    });
    if (r.ok) {
      ok = true;
      agentId = r.data.id ?? newId;
      ctx = { kind: "wizard-blank", channelTargets };
      welcomeMsg = `${friendlyName} is ready — persona, brain & channels applied.`;
    } else {
      err = r.error;
    }

    if (!ok) {
      setSubmitting(false);
      setToast({ kind: "error", text: `Failed: ${err}` });
      return;
    }

    setSubmitting(false);

    setToast({ kind: "success", text: `🎉 ${friendlyName} created` });

    // Always advance to a post-create step. createdAgentId is set in BOTH
    // branches so the Kemampuan step (5) always has a valid profile id.
    setCreatedAgentId(agentId);
    setFinishCtx(ctx!);
    setFinishMsg(welcomeMsg);
    if (channelTargets.length > 0) {
      // Has non-web channels → pairing step (4) first, then Kemampuan (5).
      setStep(4);
    } else {
      // Web-only → skip pairing, straight to Kemampuan (5).
      setStep(5);
    }
  };

  // ── Called from step 5 "Selesai" — close wizard + notify parent
  const handleStep5Finish = () => {
    if (createdAgentId && finishCtx) {
      // Tweak welcome message based on how many channels paired
      const paired = pairedChannels.size;
      const total = channelTargets.length;
      const augmented = paired > 0
        ? `${finishMsg} ${paired} of ${total} channel(s) connected.`
        : finishMsg;
      onCreated(createdAgentId, augmented, finishCtx);
    }
    onClose();
  };

  // ── PairingDialog success handler — mark channel as paired in step 5
  const handlePairingSuccess = (info: PairingSuccessInfo) => {
    setPairedChannels((prev) => {
      const next = new Set(prev);
      next.add(info.channelId);
      return next;
    });
    setPairingChannel(null);
    // Refresh dashboard so card flips ke "already-paired" state kalau
    // user buka step 5 lagi nanti.
    void channelsDashboard.refetch?.();
    setToast({
      kind: "success",
      text: `✓ ${info.channelLabel} connected to ${info.agentLabel}`,
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex w-full max-w-3xl flex-col rounded-3xl border border-white/15 bg-[#0B0E14] shadow-[0_32px_96px_-16px_rgba(0,0,0,0.9)]">
        {/* Header */}
        <header className="flex shrink-0 items-center gap-4 border-b border-white/[0.08] px-6 py-4">
          <div className="flex-1">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
              ✦ Create New Agent — Step {displayStep}/{totalSteps}
            </div>
            <h2 className="mt-0.5 font-display text-lg font-bold text-white">
              {step === 1
                ? "What will this agent do?"
                : step === 2
                  ? "Name & persona"
                  : step === 3
                    ? "Choose model & channels"
                    : step === 4
                      ? "Connect your agent's channels"
                      : "Set agent capabilities (tools & skills)"}
            </h2>
          </div>
          <ProgressDots current={displayStep} total={totalSteps} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {/* Body */}
        <div className="scrollbar-slim min-h-[400px] max-h-[60vh] flex-1 overflow-y-auto px-6 py-5">
          {step === 1 ? (
            <Step1Purpose
              goalIds={goalIds}
              onToggle={toggleGoal}
              archetype={archetype}
            />
          ) : step === 2 ? (
            <Step2Persona
              archetype={archetype}
              name={name}
              emoji={emoji}
              theme={theme}
              tone={tone}
              userTitles={userTitles}
              personality={personality}
              language={language}
              emojiUsage={emojiUsage}
              responseStyle={responseStyle}
              soulContent={soulContent}
              soulEdited={soulEdited}
              onName={setName}
              onEmoji={setEmoji}
              onTheme={setTheme}
              onTone={setTone}
              onToggleTitle={toggleTitle}
              onTogglePersonality={togglePersonality}
              onLanguage={setLanguage}
              onEmojiUsage={setEmojiUsage}
              onResponseStyle={setResponseStyle}
              onSoulEdit={(v) => {
                setSoulDraft(v);
                setSoulEdited(true);
              }}
              onSoulReset={() => {
                setSoulEdited(false);
                setSoulDraft("");
              }}
            />
          ) : step === 3 ? (
            <Step3Engine
              modelPrimary={modelPrimary}
              modelFallback={modelFallback}
              channels={channels}
              flatModels={flatModelChoices}
              modelsLoading={modelOptions.loading}
              onModelPrimary={setModelPrimary}
              onModelFallback={setModelFallback}
              onChannels={setChannels}
            />
          ) : step === 4 ? (
            <Step5Pairings
              channelTargets={channelTargets}
              pairedChannels={pairedChannels}
              channelStatusMap={channelStatusMap}
              onSetup={(entry) => setPairingChannel(entry)}
              onBindOnly={(channelId, accountId) =>
                void handleBindOnly(channelId, accountId)
              }
              agentLabel={name.trim() || createdAgentId || "Agent"}
            />
          ) : (
            <Step6Kemampuan
              agentId={createdAgentId}
              agentLabel={name.trim() || createdAgentId || "Agent"}
              emoji={emoji.trim() || undefined}
              theme={theme}
              setToast={setToast}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.08] px-6 py-4">
          {step > 1 && step < 4 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, (s - 1)) as WizardStep)}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/70 hover:text-white disabled:opacity-50"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Back
            </button>
          ) : step >= 4 ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300/70">
              ✓ Agent created
            </span>
          ) : (
            <div className="w-[88px]" />
          )}

          {step < 3 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(3, (s + 1)) as WizardStep)}
              disabled={!canAdvance}
              title={
                !canAdvance
                  ? step === 1
                    ? "Pick at least one purpose first"
                    : "Enter an agent name first"
                  : undefined
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
                canAdvance
                  ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.55)] hover:brightness-110"
                  : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
              )}
            >
              Next
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : step === 3 ? (
            <button
              type="button"
              onClick={() => void handleFinish()}
              disabled={!canAdvance || submitting}
              title={
                channelTargets.length > 0
                  ? `Create agent, then pair ${channelTargets.length} channel(s) in the next step.`
                  : "Create agent — all wizard settings applied atomically."
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
                canAdvance && !submitting
                  ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                  : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
              )}
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-3.5" aria-hidden />
              )}
              {channelTargets.length > 0
                ? `Create & Pair ${channelTargets.length} channel(s)`
                : "Create Agent"}
            </button>
          ) : step === 4 ? (
            // Step 4 pairing done → proceed to capabilities (step 5).
            <button
              type="button"
              onClick={() => setStep(5)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-5 py-2 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.55)] hover:brightness-110"
            >
              Next — Set Capabilities
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : (
            // Step 5 — capabilities set live per-toggle; "Selesai" just closes.
            <button
              type="button"
              onClick={handleStep5Finish}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 px-5 py-2 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
            >
              <Check className="size-3.5" aria-hidden />
              Done — Agent Ready
            </button>
          )}
        </footer>
      </div>

      {/* Pairing dialog overlay — opens inside wizard for step 5.
          Higher z-index than wizard to stack properly. Pre-selects the
          newly-created agent so user doesn't have to manually re-pick
          (bug fix 2026-05-27 per chief — default agent was leaking).
          existingAccountIds reflects REAL state from channels.status —
          jadi PairingDialog tahu ini first-pair vs add-account. Empty
          array = first pair (writes top-level channels.<id>.<fields>);
          non-empty = add account (nests under accounts.<id>). */}
      {pairingChannel ? (
        <PairingDialog
          open={true}
          entry={pairingChannel}
          existingAccountIds={
            channelStatusMap.get(pairingChannel.id)?.accountIds ?? []
          }
          defaultAgentId={createdAgentId ?? undefined}
          onClose={() => setPairingChannel(null)}
          onSuccess={handlePairingSuccess}
        />
      ) : null}
    </div>
  );
}

/* ── ProgressDots ─────────────────────────────────────────────────── */

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          className={cn(
            "size-2 rounded-full transition",
            n === current
              ? "bg-gradient-to-br from-cyan-400 to-fuchsia-500 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
              : n < current
                ? "bg-emerald-400"
                : "bg-white/20",
          )}
        />
      ))}
    </div>
  );
}

/* ── Step 5 — In-wizard channel pairing ──────────────────────────── */

/**
 * Tutorial copy per channel — short, accurate, actionable. User reads
 * this BEFORE clicking "Setup sekarang" so they know what to prep
 * (bot token, QR scan, OAuth, etc.).
 */
const PAIRING_TUTORIALS: Record<string, { steps: string[]; pre?: string }> = {
  telegram: {
    pre: "Have your Telegram account and a browser ready.",
    steps: [
      "Open a chat with @BotFather on Telegram.",
      "Send /newbot → give it a name (e.g. \"Support Bot\") → give it a username (must end in _bot, e.g. support_bot).",
      "BotFather will give you a long token (xxxx:yyyy...). Copy it.",
      "Click \"Set up now\" below and paste the token in the dialog.",
    ],
  },
  whatsapp: {
    pre: "Use a phone number NOT already linked to WhatsApp Web/Desktop.",
    steps: [
      "Click \"Set up now\" — AgentBuff will generate a QR code.",
      "Open WhatsApp on your phone → Settings → Linked Devices → Link a Device.",
      "Scan the QR code. Done.",
    ],
  },
  discord: {
    pre: "Have a Discord account and a Discord server you admin ready.",
    steps: [
      "Go to discord.com/developers/applications and click New Application.",
      "Open the \"Bot\" tab → Reset Token → copy the token.",
      "\"Installation\" / \"OAuth2\" tab → set scope `bot` + desired permissions → copy the invite URL → open it → invite the bot to your server.",
      "Click \"Set up now\" and paste the token in the dialog.",
    ],
  },
  slack: {
    pre: "Have a Slack workspace you admin ready.",
    steps: [
      "Go to api.slack.com/apps → Create New App → From scratch.",
      "\"OAuth & Permissions\" tab → install to workspace → copy the Bot User OAuth Token (xoxb-...).",
      "\"Basic Information\" tab → copy the Signing Secret.",
      "Click \"Set up now\" and paste both into the dialog.",
    ],
  },
};

type ChannelStatus = {
  paired: boolean;
  accountIds: string[];
  routedAgentId: string | null;
};

/**
 * Step6Kemampuan — POST-create capabilities step (tools + skills). Reuses the
 * already-verified per-agent ToolsSection + SkillsSection bound to the just-
 * created agent id, so EVERY toggle is profile-scoped (writes profiles/<id>/
 * config.yaml only — never global, never an existing agent). Writes are live
 * per-toggle; "Selesai" just closes.
 *
 * The `if (!agentId) return null` guard is REQUIRED defense-in-depth: a
 * tools.toggle with a falsy agentId would (pre the bridge fix) fall through to
 * the GLOBAL config. We never render the toggles without a real createdAgentId.
 * Plugins / MCP / reset-to-factory are GLOBAL/destructive and deliberately NOT
 * surfaced here — those stay in the full Kemampuan tab.
 */
function Step6Kemampuan({
  agentId,
  agentLabel,
  emoji,
  theme,
  setToast,
}: {
  agentId: string | null;
  agentLabel: string;
  emoji?: string;
  theme: string;
  setToast: ToastSetter;
}) {
  if (!agentId) return null;
  const agentRow: AgentRow = {
    id: agentId,
    name: agentLabel,
    identity: { name: agentLabel, emoji, theme },
    // Empty seed → SkillsSection derives the enabled set from the engine's real
    // per-agent skill status (blank = all-on; template = its preset on).
    skills: [],
  };
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-3">
        <p className="text-[13px] leading-relaxed text-white/85">
          <span className="font-semibold text-emerald-300">
            {agentLabel} is live!
          </span>{" "}
          Configure the tools &amp; skills this agent can use — every toggle saves
          instantly for <span className="font-semibold text-white/90">this agent
          only</span>. You can skip this (click Done) and configure everything later in the Capabilities tab.
        </p>
      </div>
      <ToolsSection agent={agentRow} setToast={setToast} />
      <SkillsSection agent={agentRow} setToast={setToast} />
    </div>
  );
}

function Step5Pairings({
  channelTargets,
  pairedChannels,
  channelStatusMap,
  onSetup,
  onBindOnly,
  agentLabel,
}: {
  channelTargets: string[];
  pairedChannels: Set<string>;
  channelStatusMap: Map<string, ChannelStatus>;
  onSetup: (entry: ChannelCatalogEntry) => void;
  onBindOnly: (channelId: string, accountId: string) => void;
  agentLabel: string;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.04] px-3 py-3">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />
          <div className="text-[12px] leading-relaxed text-white/85">
            <strong className="text-emerald-200">{agentLabel}</strong> was
            created successfully. Connect it to your chosen channels so the agent
            can reply there right away — or click <strong>Done</strong>{" "}
            to pair later in the Channels tab.
          </div>
        </div>
      </div>

      <p className="text-[11.5px] text-white/55">
        Channels already used by another agent are marked{" "}
        <span className="rounded-md border border-indigo-400/30 bg-indigo-400/10 px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.16em] text-indigo-200">
          already active
        </span>{" "}
        — this agent will simply attach to the same routing (the engine supports
        1 session per channel per AgentBuff account). The tutorial only appears
        for channels that have never been set up before.
      </p>

      {channelTargets.map((channelId) => {
        const entry = CHANNEL_CATALOG.find((c) => c.id === channelId);
        const finishedHere = pairedChannels.has(channelId);
        const tutorial = PAIRING_TUTORIALS[channelId];
        const status = channelStatusMap.get(channelId) ?? {
          paired: false,
          accountIds: [],
          routedAgentId: null,
        };
        return (
          <ChannelPairingCard
            key={channelId}
            channelId={channelId}
            entry={entry}
            finishedHere={finishedHere}
            status={status}
            tutorial={tutorial}
            onSetup={() => entry && onSetup(entry)}
            onBindOnly={(accountId) => onBindOnly(channelId, accountId)}
          />
        );
      })}
    </div>
  );
}

function ChannelPairingCard({
  channelId,
  entry,
  finishedHere,
  status,
  tutorial,
  onSetup,
  onBindOnly,
}: {
  channelId: string;
  entry: ChannelCatalogEntry | undefined;
  /** True kalau pairing/bind di wizard ini barusan berhasil. */
  finishedHere: boolean;
  /** Pre-existing pairing status (dari channels.status, before wizard ran). */
  status: ChannelStatus;
  tutorial?: { steps: string[]; pre?: string };
  onSetup: () => void;
  onBindOnly: (accountId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!entry) {
    return (
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.04] px-3 py-2 text-[11.5px] text-amber-100">
        ⚠️ Channel <code>{channelId}</code> is not in the catalog. Skip it.
      </div>
    );
  }

  // Branching states (Fase 9 rewrite — plugin-aware per-agen):
  //   - finishedHere=true: success state, tunjukin badge "Ter-sambung".
  //   - status.paired=true: channel udah dipakai agent LAIN — TIDAK lagi
  //     menjadi limitation. Plugin agentbuff-multichannel kasih tiap agen
  //     channel + token SENDIRI yang terpisah. Show info card "agen lain
  //     juga pakai channel ini, agen kamu bakal dapet token sendiri".
  //   - status.paired=false: first pair untuk channel ini di kontainer
  //     kamu — normal flow.
  //
  // Multi-account at runtime — ENGINE realitas (post-plugin):
  //   plugin agentbuff-multichannel mendukung N library client (token)
  //   per channel di 1 process. SETIAP agen yang pair channel = dapet
  //   token + nomor SENDIRI, gak overlapping dengan agen lain.
  const showOtherAgentInfo = !finishedHere && status.paired;
  const showSetupFirst = !finishedHere;  // selalu show setup setelah Fase 9

  return (
    <div
      className={cn(
        "rounded-2xl border p-3 transition",
        finishedHere
          ? "border-emerald-400/40 bg-emerald-400/[0.06]"
          : status.paired
            ? "border-indigo-400/30 bg-indigo-400/[0.04]"
            : "border-white/[0.10] bg-white/[0.02]",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-2xl">
          {entry.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[14px] font-semibold text-white/95">
              {entry.label}
            </span>
            {finishedHere ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/15 px-2 py-0 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-100">
                <Check className="size-3" aria-hidden /> Connected
              </span>
            ) : status.paired ? (
              <span className="rounded-full border border-indigo-400/30 bg-indigo-400/10 px-2 py-0 font-mono text-[10px] uppercase tracking-[0.16em] text-indigo-200">
                Already active
              </span>
            ) : (
              <span className="rounded-full border border-amber-400/30 bg-amber-400/[0.06] px-2 py-0 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">
                Not paired yet
              </span>
            )}
          </div>
          {entry.tagline ? (
            <p className="mt-0.5 text-[11px] text-white/55">{entry.tagline}</p>
          ) : null}

          {/* Info: channel udah dipakai agen lain — TAPI tiap agen tetap
              punya channel + token SENDIRI yang terpisah (Fase 9). */}
          {showOtherAgentInfo ? (
            <div className="mt-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.05] p-2.5 text-[11px] leading-relaxed text-cyan-100/90">
              💡 {entry.label} is also used by another agent
              {status.routedAgentId ? (
                <>
                  {" "}(agent <strong className="font-mono">{status.routedAgentId}</strong>)
                </>
              ) : null}
              . Your agent will have its <strong>own</strong>{" "}
              {entry.label.toLowerCase()} — independent number/token and conversations,
              completely separate from other agents.
            </div>
          ) : null}

          {/* Tutorial — only when first-pair flow */}
          {tutorial && showSetupFirst ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200 hover:text-cyan-100"
              >
                {expanded ? "▼ Hide tutorial" : "▶ How to set up"}
              </button>
              {expanded ? (
                <div className="mt-2 rounded-lg border border-white/10 bg-[#0B0E14]/60 p-2.5">
                  {tutorial.pre ? (
                    <p className="mb-1.5 text-[11px] text-white/75">
                      💡 <strong>Before you start:</strong> {tutorial.pre}
                    </p>
                  ) : null}
                  <ol className="space-y-1 pl-4 text-[11px] leading-relaxed text-white/75">
                    {tutorial.steps.map((s, i) => (
                      <li key={i} className="list-decimal">
                        {s}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Right-rail actions — Fase 9: plugin makes per-agen pairing truly
            independent. Always show "Setup sekarang" (no bind-only path). */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {finishedHere ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300/75">
              ✓ Done
            </span>
          ) : (
            <button
              type="button"
              onClick={onSetup}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.6)] hover:brightness-110"
            >
              <Sparkles className="size-3" aria-hidden />
              Set up now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function uniquifyId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

