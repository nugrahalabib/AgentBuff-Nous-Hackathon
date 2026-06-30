"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Hammer,
  KeyRound,
  Loader2,
  Lock,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { OnboardingAnswers } from "@/lib/onboarding/answers";
import { buildSoul, deriveArchetype } from "@/lib/onboarding/archetypes";
import { PersonaPreview } from "./persona-preview";
import {
  USER_TITLES,
  TONES,
  PERSONALITY_TRAITS,
  LANGUAGES,
  EMOJI_USAGE,
  RESPONSE_STYLES,
  getPersonaOption,
} from "@/lib/onboarding/persona-options";
import {
  BYOK_PROVIDERS,
  BYOK_TIERS,
  getByokProvider,
  type ByokProvider,
  type ByokTier,
} from "@/lib/onboarding/byok-providers";
import { tutorialForKey } from "@/components/app/tabs/provider-tutorials";
import {
  Chip,
  FieldLabel,
  FieldNote,
  PrimaryButton,
  StepHeader,
  TextField,
} from "./primitives";

export interface StepProps {
  answers: OnboardingAnswers;
  set: (patch: Partial<OnboardingAnswers>) => void;
}

const MAX_TITLES = 3;
const MAX_TRAITS = 4;

// Curated agent-avatar emojis for the picker (faces/creatures/symbols).
const EMOJI_CHOICES = [
  "🤖", "👾", "✨", "⚡", "🔥", "🌟", "💫", "💡", "🧠", "🎯",
  "🚀", "💎", "🦊", "🐱", "🐼", "🦉", "🐯", "🦁", "🐲", "🐧",
  "🐨", "🦅", "🦄", "🐶", "🦋", "🌈", "🍀", "🎨", "🎬", "💬",
  "📊", "✍️", "🛠️", "💰", "📚", "🫂", "🎩", "☀️", "🌙", "🐳",
] as const;

// ── Step 4: Atur Buff (identity + persona) ───────────────────────────────
// No more archetype picker — the specialization is auto-derived from the user's
// goals (step 3) + role (step 2). This step customizes IDENTITY: name, how the
// user wants to be addressed (with live preview), tone, personality, language,
// emoji + response style. Every choice updates the SOUL.md preview live.
export function StepForge({ answers, set }: StepProps) {
  const { t } = useI18n();
  const c = t.onboarding.forge;
  const [customTitle, setCustomTitle] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const derived = useMemo(
    () => deriveArchetype({ goals: answers.interestIds, role: answers.role }),
    [answers.interestIds, answers.role],
  );

  // Sync the auto-derived archetype id + seed default name/emoji into the blanks.
  // Runs when the derived specialization changes; never overwrites a custom name.
  useEffect(() => {
    const patch: Partial<OnboardingAnswers> = {};
    if (answers.archetype !== derived.id) patch.archetype = derived.id;
    if (!answers.agentName.trim()) patch.agentName = derived.defaultName;
    if (!answers.agentEmoji.trim()) patch.agentEmoji = derived.emoji;
    if (Object.keys(patch).length > 0) set(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived.id]);

  const titles = answers.userTitles;
  const knownTitleIds = useMemo(() => new Set(USER_TITLES.map((o) => o.id)), []);
  const customTitles = titles.filter((id) => !knownTitleIds.has(id));
  const titleDisplay = (id: string) =>
    getPersonaOption(USER_TITLES, id)?.label ?? id;
  const atTitleMax = titles.length >= MAX_TITLES;

  const toggleTitle = (id: string) => {
    if (titles.includes(id)) {
      set({ userTitles: titles.filter((x) => x !== id) });
    } else if (!atTitleMax) {
      set({ userTitles: [...titles, id] });
    }
  };
  const addCustomTitle = () => {
    const v = customTitle.trim();
    setCustomTitle("");
    if (!v || atTitleMax) return;
    if (titles.some((x) => titleDisplay(x).toLowerCase() === v.toLowerCase())) return;
    set({ userTitles: [...titles, v] });
  };
  const removeTitle = (id: string) =>
    set({ userTitles: titles.filter((x) => x !== id) });

  const toggleTrait = (id: string) => {
    const p = answers.personality;
    if (p.includes(id)) {
      set({ personality: p.filter((x) => x !== id) });
    } else if (p.length < MAX_TRAITS) {
      set({ personality: [...p, id] });
    }
  };

  const nick = answers.nickname.trim() || "kamu";
  // Show EVERY chosen sapaan, not just the first — e.g. "Mas Nugi · Bos Nugi".
  const addressExamples =
    titles.length > 0
      ? titles.map((id) => `${titleDisplay(id)} ${nick}`).join("  ·  ")
      : nick;

  // nickname passed raw — buildSoul applies its own "partner kamu" fallback, so
  // the preview can never show a value the server-built SOUL won't.
  const soulPreview = useMemo(
    () =>
      buildSoul(derived.id, {
        agentName: answers.agentName || derived.defaultName,
        nickname: answers.nickname,
        userTitles: answers.userTitles,
        tone: answers.tone,
        personality: answers.personality,
        language: answers.language,
        emojiUsage: answers.emojiUsage,
        responseStyle: answers.responseStyle,
        role: answers.role,
        jurusan: answers.jurusan,
        businessName: answers.businessName,
        city: answers.city,
        industryIds: answers.industryIds,
        goals: answers.interestIds,
      }),
    [derived.id, answers],
  );

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<Hammer className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />

      {/* The live persona payoff lives in the desktop rail; on mobile (no rail)
          surface it here on Step 4 — the most relevant step — so editing name /
          emoji / sapaan reflects into the Buff in real time. */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 lg:hidden">
        <PersonaPreview answers={answers} />
      </div>

      <SectionEyebrow>{c.sectionWho}</SectionEyebrow>

      {/* Name */}
      <TextField
        label={c.nameLabel}
        icon={<Sparkles className="size-4" />}
        placeholder={c.namePlaceholder}
        value={answers.agentName}
        onChange={(v) => set({ agentName: v })}
        maxLength={60}
      />

      {/* Emoji picker — pick the Buff's face */}
      <div>
        <FieldLabel>
          {c.emojiLabel}{" "}
          {answers.agentEmoji ? (
            <span className="ml-1 align-middle text-base" aria-hidden>
              {answers.agentEmoji}
            </span>
          ) : null}
        </FieldLabel>
        <div
          role="radiogroup"
          aria-label={c.emojiLabel}
          className="flex flex-wrap gap-1.5"
        >
          {EMOJI_CHOICES.map((e) => {
            const active = answers.agentEmoji === e;
            return (
              <button
                key={e}
                type="button"
                role="radio"
                onClick={() => set({ agentEmoji: e })}
                aria-checked={active}
                aria-label={c.emojiPickAria.replace("{e}", e)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border text-lg transition-all",
                  active
                    ? "border-cyan-400/70 bg-cyan-400/15 shadow-[0_0_0_3px_rgba(34,211,238,0.2)]"
                    : "border-white/10 bg-white/[0.03] hover:border-white/30 hover:bg-white/[0.06]",
                )}
              >
                {e}
              </button>
            );
          })}
        </div>
      </div>

      {/* Panggilan — how the agent addresses the user */}
      <div>
        <FieldLabel>{c.titlesLabel}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {USER_TITLES.map((o) => (
            <Chip
              key={o.id}
              active={titles.includes(o.id)}
              disabled={!titles.includes(o.id) && atTitleMax}
              onClick={() => toggleTitle(o.id)}
            >
              {o.label}
            </Chip>
          ))}
        </div>

        {customTitles.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {customTitles.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/50 bg-cyan-400/10 px-3 py-1 text-[12px] font-medium text-cyan-100"
              >
                {id}
                <button
                  type="button"
                  onClick={() => removeTitle(id)}
                  className="text-cyan-300/70 hover:text-white"
                  aria-label={c.removeTitleAria.replace("{title}", id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-2 flex gap-2">
          <input
            value={customTitle}
            // Strip commas — userTitles is persisted as a CSV; a comma would
            // split one custom title into two bogus ones on the server.
            onChange={(e) =>
              setCustomTitle(e.target.value.replace(/,/g, " ").slice(0, 24))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomTitle();
              }
            }}
            placeholder={c.titlesCustomPlaceholder}
            disabled={atTitleMax}
            className="h-10 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/70 focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={addCustomTitle}
            disabled={atTitleMax || customTitle.trim().length === 0}
            className="rounded-xl border border-white/15 bg-white/[0.04] px-3.5 text-sm font-medium text-white/80 transition-colors hover:border-cyan-400/40 disabled:opacity-40"
          >
            {c.addLabel}
          </button>
        </div>

        <p className="mt-2 text-[12px] text-white/50">
          {c.addressPreviewLabel}:{" "}
          <span className="font-semibold text-cyan-200">{addressExamples}</span>
        </p>
        <FieldNote>{c.titlesNote}</FieldNote>
      </div>

      <SectionEyebrow>{c.sectionStyle}</SectionEyebrow>

      {/* Tone */}
      <div>
        <FieldLabel>{c.toneLabel}</FieldLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TONES.map((tone) => {
            const active = answers.tone === tone.id;
            return (
              <button
                key={tone.id}
                type="button"
                onClick={() => set({ tone: tone.id })}
                aria-pressed={active}
                className={cn(
                  "rounded-xl border p-3 text-left transition-all",
                  active
                    ? "border-cyan-400/60 bg-cyan-400/[0.08]"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25",
                )}
              >
                <p className="text-[13px] font-semibold text-white">{tone.label}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-white/55">
                  {tone.desc}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Personality */}
      <div>
        <FieldLabel>{c.personalityLabel}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {PERSONALITY_TRAITS.map((tr) => {
            const active = answers.personality.includes(tr.id);
            return (
              <Chip
                key={tr.id}
                active={active}
                disabled={!active && answers.personality.length >= MAX_TRAITS}
                onClick={() => toggleTrait(tr.id)}
              >
                {tr.label}
              </Chip>
            );
          })}
        </div>
        <FieldNote>{c.personalityNote}</FieldNote>
      </div>

      {/* Advanced (optional) — collapsed so the form stays light & inviting */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={showAdvanced}
          aria-controls="forge-advanced-panel"
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-[13px] font-semibold text-white/80">
            {c.advancedLabel}
          </span>
          <ChevronDown
            className={cn(
              "size-4 text-white/40 transition-transform",
              showAdvanced && "rotate-180",
            )}
          />
        </button>
        {showAdvanced ? (
          <div
            id="forge-advanced-panel"
            className="flex flex-col gap-4 border-t border-white/[0.06] p-4 pt-4"
          >
            <SegmentedRow
              label={c.languageLabel}
              options={LANGUAGES}
              value={answers.language}
              onPick={(v) => set({ language: v })}
            />
            <SegmentedRow
              label={c.emojiUsageLabel}
              options={EMOJI_USAGE}
              value={answers.emojiUsage}
              onPick={(v) => set({ emojiUsage: v })}
            />
            <SegmentedRow
              label={c.responseStyleLabel}
              options={RESPONSE_STYLES}
              value={answers.responseStyle}
              onPick={(v) => set({ responseStyle: v })}
            />
          </div>
        ) : null}
      </div>

      {/* Full SOUL.md behind a disclosure — power users can inspect it, but it
          no longer dumps ~60 lines into the step. The live persona is the rail. */}
      <details className="group rounded-xl border border-white/10 bg-white/[0.02]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-[12px] font-medium text-white/65 transition-colors hover:text-white/90 [&::-webkit-details-marker]:hidden">
          {c.previewLabel}
          <ChevronDown className="size-4 shrink-0 text-white/40 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-white/[0.06] px-4 pb-3 pt-2">
          <pre
            tabIndex={0}
            role="region"
            aria-label={c.previewLabel}
            className="max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-white/75 focus:outline-none"
          >
            {soulPreview}
          </pre>
          <FieldNote>{c.previewHint}</FieldNote>
        </div>
      </details>
    </div>
  );
}

// A small eyebrow + hairline that chunks the step into "who" / "style" groups,
// so the long form reads as sections instead of one undifferentiated wall.
function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/60">
        {children}
      </span>
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

function SegmentedRow({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o.id} active={value === o.id} onClick={() => onPick(o.id)}>
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export function isForgeValid(a: OnboardingAnswers): boolean {
  return a.agentName.trim().length > 0;
}

// ── Step 5: BYOK ─────────────────────────────────────────────────────────
type ConnState = "idle" | "connecting" | "connected" | "error";

export function StepByok({ answers, set }: StepProps) {
  const { t } = useI18n();
  const c = t.onboarding.byok;

  const initialEnvKey =
    BYOK_PROVIDERS.find((p) => p.id === answers.modelProvider)?.envKey ??
    BYOK_PROVIDERS[0].envKey;

  const [envKey, setEnvKey] = useState(initialEnvKey);
  const [keyInput, setKeyInput] = useState("");
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState<ConnState>(
    answers.modelProvider ? "connected" : "idle",
  );
  const [modelCount, setModelCount] = useState<number | undefined>(undefined);

  const provider = getByokProvider(envKey) ?? BYOK_PROVIDERS[0];
  const tutorial = useMemo(
    () => tutorialForKey(provider.envKey, provider.label),
    [provider.envKey, provider.label],
  );

  const selectProvider = (p: ByokProvider) => {
    setEnvKey(p.envKey);
    setState("idle");
    setKeyInput("");
  };

  const connect = async () => {
    if (keyInput.trim().length < 8) return;
    setState("connecting");
    try {
      const res = await fetch("/api/users/me/onboarding/stage-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: provider.envKey, key: keyInput.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { modelCount?: number };
        setModelCount(data.modelCount);
        setState("connected");
        set({ modelProvider: provider.id, modelDefault: provider.defaultModel });
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  };

  const reset = () => {
    setState("idle");
    setKeyInput("");
    setModelCount(undefined);
    set({ modelProvider: "", modelDefault: "" });
  };

  if (state === "connected") {
    const cp =
      getByokProvider(
        BYOK_PROVIDERS.find((p) => p.id === answers.modelProvider)?.envKey ??
          provider.envKey,
      ) ?? provider;
    return (
      <div className="flex flex-col gap-5">
        <StepHeader
          icon={<KeyRound className="size-5 text-cyan-300" />}
          headline={c.headline}
          subheadline={c.subheadline}
        />
        <div className="flex items-center justify-between rounded-xl border border-emerald-400/40 bg-emerald-400/[0.06] p-4">
          <div className="flex items-center gap-3">
            <ProviderLogo slug={cp.logoSlug} size={36} />
            <div>
              <p className="text-sm font-semibold text-white">
                {cp.label} · {c.connectedLabel}
              </p>
              <p className="text-[11px] text-emerald-300/80">
                {modelCount
                  ? c.modelsLabel.replace("{n}", String(modelCount))
                  : c.connectedHint}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            className="text-[12px] font-medium text-white/45 hover:text-white/80"
          >
            {c.changeLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<KeyRound className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />

      {/* Security reassurance */}
      <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300/80" />
        <p className="text-[11.5px] leading-relaxed text-white/55">{c.securityNote}</p>
      </div>

      {/* Provider cards grouped by tier (gratis -> murah -> premium) */}
      {BYOK_TIERS.map((group) =>
        group.providers.length > 0 ? (
          <div key={group.id} className="flex flex-col gap-2.5">
            <SectionEyebrow>{tierLabel(group.id, c)}</SectionEyebrow>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {group.providers.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  c={c}
                  active={p.envKey === envKey}
                  onSelect={() => selectProvider(p)}
                />
              ))}
            </div>
          </div>
        ) : null,
      )}

      {/* Selected provider: guidance + key input */}
      <div className="flex flex-col gap-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-4">
        <div className="flex items-center gap-2.5">
          <ProviderLogo slug={provider.logoSlug} size={28} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">{provider.label}</p>
            <p className="truncate text-[11px] text-white/50">{provider.tagline}</p>
          </div>
        </div>

        {tutorial ? <TutorialPanel t={tutorial} /> : null}

        <div>
          <FieldLabel>{c.keyLabel}</FieldLabel>
          <div className="relative">
            <input
              type={reveal ? "text" : "password"}
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                if (state === "error") setState("idle");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") connect();
              }}
              placeholder={c.keyPlaceholder}
              maxLength={400}
              className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-3.5 pr-11 text-sm text-white placeholder:text-white/30 transition-all focus:border-cyan-400/70 focus:bg-white/[0.05] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? c.hideKeyAria : c.showKeyAria}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-white/40 hover:text-white/80"
            >
              {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        {state === "error" ? (
          <p className="text-[12px] text-red-300">{c.invalidKeyLabel}</p>
        ) : null}

        <PrimaryButton
          onClick={connect}
          disabled={keyInput.trim().length < 8}
          loading={state === "connecting"}
          icon={<ShieldCheck className="size-4" />}
        >
          {state === "connecting" ? c.connectingLabel : c.connectCta}
        </PrimaryButton>

        {provider.oauth ? (
          <p className="flex items-center gap-1.5 text-[11px] text-white/45">
            <Lock className="size-3 shrink-0" />
            {c.oauthSoon.replace("{p}", provider.oauth.label)}
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
        <p className="text-[12px] font-semibold text-white/70">{c.whyTitle}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-white/55">{c.whyBody}</p>
      </div>
    </div>
  );
}

function tierLabel(
  tier: ByokTier,
  c: { tierFree: string; tierCheap: string; tierPaid: string },
): string {
  return tier === "free" ? c.tierFree : tier === "cheap" ? c.tierCheap : c.tierPaid;
}

function ProviderLogo({ slug, size }: { slug: string; size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/images/providers/${slug}.webp`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 rounded-md object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function ByokBadge({
  tone,
  children,
}: {
  tone: "cyan" | "emerald" | "amber";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
        tone === "cyan" && "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
        tone === "emerald" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
        tone === "amber" && "border-amber-400/30 bg-amber-400/10 text-amber-200",
      )}
    >
      {children}
    </span>
  );
}

function ProviderCard({
  provider,
  active,
  onSelect,
  c,
}: {
  provider: ByokProvider;
  active: boolean;
  onSelect: () => void;
  c: { recommendedBadge: string; freeBadge: string; cheapBadge: string };
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all",
        active
          ? "border-cyan-400/60 bg-cyan-400/[0.07] shadow-[0_0_0_2px_rgba(34,211,238,0.12)]"
          : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]",
      )}
    >
      <ProviderLogo slug={provider.logoSlug} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-white">{provider.label}</span>
          {provider.recommended ? (
            <ByokBadge tone="cyan">{c.recommendedBadge}</ByokBadge>
          ) : provider.tier === "free" ? (
            <ByokBadge tone="emerald">{c.freeBadge}</ByokBadge>
          ) : provider.tier === "cheap" ? (
            <ByokBadge tone="amber">{c.cheapBadge}</ByokBadge>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-white/50">{provider.tagline}</p>
      </div>
      {active ? <Check className="size-4 shrink-0 text-cyan-300" strokeWidth={3} /> : null}
    </button>
  );
}

function TutorialPanel({ t }: { t: NonNullable<ReturnType<typeof tutorialForKey>> }) {
  return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
      <p className="mb-2 text-[11.5px] font-semibold text-cyan-200/90">{t.title}</p>
      <ol className="space-y-1.5">
        {t.steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-[11.5px] leading-snug text-white/70">
            <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-cyan-400/20 font-mono text-[9px] font-bold text-cyan-200">
              {i + 1}
            </span>
            <span className="break-words">{s}</span>
          </li>
        ))}
      </ol>
      {t.url ? (
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/15"
        >
          <ExternalLink className="size-3" /> {t.urlLabel ?? t.url}
        </a>
      ) : null}
      {t.note ? (
        <p className="mt-2 text-[10.5px] italic leading-snug text-white/45">{t.note}</p>
      ) : null}
    </div>
  );
}

export function isByokValid(_a: OnboardingAnswers): boolean {
  // BYOK is now SKIPPABLE ("kasih otak nanti") — the user can proceed without
  // connecting a provider. In production BYOK (no operator-seeded default key)
  // the container then has NO usable brain, so the /app needsBrain gate disables
  // chat and guides them to the Providers tab. NOTE: in dev a default GEMINI key
  // is seeded into every container, so chat still works after skip there — the
  // gate is honest about "can it chat right now", and only fires when the
  // container genuinely cannot. A connected provider always flows through.
  return true;
}

// ── Step 6: Aktivasi ─────────────────────────────────────────────────────
// Resolve what the user connected on the BYOK step into a display label. The
// stored modelProvider is a curated BYOK id, OR "oauth:<id>" (live OAuth login),
// OR a raw envKey (a provider outside the curated list) — all real, working
// connections, so an unmapped-but-present value shows a generic "connected"
// label, never "—" (which would lie that nothing is attached).
function resolveProviderLabel(modelProvider: string, genericLabel: string): string {
  const v = modelProvider.trim();
  if (!v) return "—";
  if (v.startsWith("oauth:")) {
    const oid = v.slice("oauth:".length);
    return BYOK_PROVIDERS.find((p) => p.oauth?.id === oid)?.label ?? genericLabel;
  }
  return (
    (BYOK_PROVIDERS.find((p) => p.id === v) ?? getByokProvider(v))?.label ??
    genericLabel
  );
}

export function StepActivate({
  answers,
  status,
  errorText,
  onLaunch,
}: {
  answers: OnboardingAnswers;
  status: "idle" | "submitting" | "error";
  errorText?: string;
  onLaunch: () => void;
}) {
  const { t } = useI18n();
  const c = t.onboarding.activate;
  const providerLabel = resolveProviderLabel(
    answers.modelProvider,
    c.connectedGeneric,
  );
  const submitting = status === "submitting";

  if (submitting) {
    // "Agent waking up" — the persona card lights up (full hero) behind a soft
    // pulse while provisioning runs, then the wizard redirects to /app. Moderate
    // per the Chief's Q4 (light-up + the agent's greeting, which PersonaPreview
    // already renders) — no layout-animating cinematics. Pulse + spinner respect
    // reduced-motion via Tailwind's motion-reduce variant.
    return (
      <div className="flex flex-col items-center gap-5 py-8 text-center">
        <div className="relative">
          <div
            aria-hidden
            className="absolute -inset-6 animate-pulse rounded-full bg-cyan-400/15 blur-2xl motion-reduce:animate-none"
          />
          <PersonaPreview answers={answers} variant="hero" className="relative" />
        </div>
        <div>
          <h1 className="font-display text-lg font-bold">{c.provisioningTitle}</h1>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-white/55">
            {c.provisioningBody}
          </p>
        </div>
        <Loader2 className="size-5 animate-spin text-cyan-300/70 motion-reduce:hidden" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<Rocket className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />

      {/* Character card — meet the Buff you built. The shared PersonaPreview
          (hero) mirrors the effort spent, so launch feels like meeting a buddy,
          not submitting a form. */}
      <div className="rounded-xl border border-cyan-400/20 bg-white/[0.03] p-5">
        <PersonaPreview answers={answers} variant="hero" />
        <div className="mt-4 flex items-center justify-center gap-2 border-t border-white/[0.06] pt-3 text-[12px]">
          <span className="text-white/50">{c.providerSummaryLabel}:</span>
          <span className="font-semibold text-white">{providerLabel}</span>
        </div>
      </div>

      {/* Free-trial highlight — the activation hook. Promoted from a flat muted
          card (Chief flagged it as near-invisible): emerald success wash + glow
          ring + icon badge + larger type so the eye lands on "14 hari gratis"
          right before the CTA. Emerald (brand success) keeps it distinct from
          the cyan->fuchsia launch button directly below. */}
      <div className="relative overflow-hidden rounded-2xl border border-emerald-400/40 bg-gradient-to-br from-emerald-400/[0.16] via-cyan-400/[0.08] to-fuchsia-500/[0.07] p-5 shadow-[0_0_34px_-10px_rgba(16,185,129,0.45)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-10 size-32 rounded-full bg-emerald-400/25 blur-3xl"
        />
        <div className="relative flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-emerald-400/40 bg-emerald-400/15 text-emerald-300 shadow-[0_0_18px_-4px_rgba(16,185,129,0.7)]">
            <Sparkles className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold text-white sm:text-lg">{c.trialTitle}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-white/70">{c.trialBody}</p>
          </div>
        </div>
      </div>

      {status === "error" ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/[0.08] p-3.5">
          <p className="text-[12px] font-semibold text-red-200">{c.errorTitle}</p>
          {errorText ? (
            <p className="mt-1 text-[11px] text-red-300/80">{errorText}</p>
          ) : null}
        </div>
      ) : null}

      <PrimaryButton onClick={onLaunch} icon={<Rocket className="size-4" />}>
        {status === "error" ? c.retryLabel : c.launchCta}
      </PrimaryButton>
    </div>
  );
}
