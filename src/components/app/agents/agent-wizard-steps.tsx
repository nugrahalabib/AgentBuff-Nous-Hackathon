"use client";

/**
 * New "Bikin Agen Baru" wizard steps — adopts the onboarding approach (chief
 * 2026-06-16): purpose → auto-derived archetype → structured persona → buildSoul,
 * while preserving the wizard's non-negotiables (engine model + channel + skills).
 *
 *   Step 1 (Step1Purpose)  — "Untuk apa agen ini?" goal tiles → deriveArchetype.
 *   Step 2 (Step2Persona)  — name + emoji/theme + structured persona (tone/sapaan/
 *                            sifat) → buildSoul; raw SOUL behind a disclosure + AI gen.
 *   Step 3 (Step3Engine)   — engine model (primary + fallback) + channel targets.
 *
 * Steps 4 (pairing) + 5 (kemampuan) stay in the wizard file, untouched.
 */

import { Bot, ChevronDown, Sparkles, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SUGGESTED_EMOJIS, randomEmoji } from "./helpers";
import { GOALS } from "@/lib/onboarding/goals";
import type { Archetype } from "@/lib/onboarding/archetypes";
import {
  TONES,
  USER_TITLES,
  PERSONALITY_TRAITS,
  LANGUAGES,
  EMOJI_USAGE,
  RESPONSE_STYLES,
} from "@/lib/onboarding/persona-options";
import { CHANNEL_CATALOG } from "@/components/app/channels/channel-catalog";

// ── Caps (mirror onboarding so the SOUL stays focused) ──────────────────────
export const MAX_GOALS = 5;
export const MAX_TITLES = 3;
export const MAX_PERSONALITY = 4;

// Channel chips. Web is the mandatory base; the rest gate on CHANNEL_CATALOG.
export const CHANNEL_OPTIONS = [
  { id: "web", label: "Web only", icon: "💻", hint: "Only in /app, not connected to any external channel" },
  { id: "whatsapp", label: "WhatsApp", icon: "💚", hint: "WhatsApp bot for customer support / orders" },
  { id: "telegram", label: "Telegram", icon: "✈️", hint: "Telegram channel/group bot" },
  { id: "discord", label: "Discord", icon: "🎮", hint: "Discord guild bot" },
  { id: "slack", label: "Slack", icon: "🔔", hint: "Slack workspace bot" },
  { id: "google_chat", label: "Google Chat", icon: "📧", hint: "Google Workspace bot (enterprise)" },
] as const;

const THEME_HEX: Record<string, string> = {
  cyan: "#22d3ee",
  fuchsia: "#e879f9",
  indigo: "#818cf8",
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#fb7185",
};
export function themeColor(t: string): string {
  return THEME_HEX[t] ?? "#22d3ee";
}

export type FlatModelChoice = {
  providerSlug: string;
  providerName: string;
  model: string;
};

// ── Shared primitives ───────────────────────────────────────────────────────

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        {children}
      </label>
      {hint ? <p className="mt-0.5 text-[10.5px] text-white/40">{hint}</p> : null}
    </div>
  );
}

/** Preview strip of the agent being assembled.
 *  - `hasSignal=false` (Step 1, no goal yet) → empty placeholder.
 *  - `nameStep=false` (Step 1, goal picked) → show ONLY the auto-derived ROLE
 *    (specialization, varies per goal). The NAME is deliberately NOT shown —
 *    naming happens in the next step (chief: "nama kenapa udah muncul duluan
 *    padahal nama ada di langkah berikutnya").
 *  - `nameStep=true` (Step 2) → show the identity the user is filling in
 *    (typed name, or a neutral "Agen kamu" until they type — never the default
 *    archetype name auto-injected). */
function PersonaStrip({
  archetype,
  name,
  emoji,
  hasSignal,
  nameStep,
}: {
  archetype: Archetype;
  name: string;
  emoji: string;
  hasSignal: boolean;
  nameStep: boolean;
}) {
  if (!hasSignal) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-2.5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-white/30">
          <Bot className="size-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-white/45">Your agent</div>
          <div className="text-[11px] text-white/30">
            Pick a purpose below — the agent's role assembles automatically.
          </div>
        </div>
      </div>
    );
  }
  const shownEmoji = emoji || archetype.emoji;
  const spec =
    archetype.specialization.charAt(0).toUpperCase() +
    archetype.specialization.slice(1);
  // Step 1: role only (no name yet).
  if (!nameStep) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
        <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/15 bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/15 text-2xl">
          {shownEmoji || <Bot className="size-5 text-white/40" aria-hidden />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold text-white">{spec}</div>
          <div className="truncate text-[11px] text-white/35">
            Name &amp; style are set in the next step.
          </div>
        </div>
      </div>
    );
  }
  // Step 2: identity assembling — reflect what the user types (no auto-name).
  const shownName = name.trim() || "Your agent";
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
      <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/15 bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/15 text-2xl">
        {shownEmoji || <Bot className="size-5 text-white/40" aria-hidden />}
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            "truncate text-[13px] font-bold",
            name.trim() ? "text-white" : "text-white/45",
          )}
        >
          {shownName}
        </div>
        <div className="truncate text-[11px] text-cyan-200/80">{spec}</div>
      </div>
    </div>
  );
}

function ChipButton({
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1.5 text-[12px] transition",
        disabled
          ? "cursor-not-allowed border-white/[0.06] bg-white/[0.01] text-white/30"
          : active
            ? "border-cyan-400/55 bg-cyan-400/[0.10] text-white shadow-[0_0_10px_-3px_rgba(34,211,238,0.5)]"
            : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white/90",
      )}
    >
      {children}
    </button>
  );
}

// ── Step 1 — Untuk apa agen ini? ────────────────────────────────────────────

export function Step1Purpose({
  goalIds,
  onToggle,
  archetype,
}: {
  goalIds: string[];
  onToggle: (id: string) => void;
  archetype: Archetype;
}) {
  const atCap = goalIds.length >= MAX_GOALS;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-bold text-white">What is this agent here to do?</h3>
        <p className="mt-1 text-[12px] text-white/55">
          Pick what fits best — AgentBuff will automatically design the personality + expertise
          from here. You can select multiple (max {MAX_GOALS}).
        </p>
      </div>

      <PersonaStrip
        archetype={archetype}
        name=""
        emoji=""
        hasSignal={goalIds.length > 0}
        nameStep={false}
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {GOALS.map((g) => {
          const active = goalIds.includes(g.id);
          const blockedByCap = atCap && !active;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                if (g.comingSoon || blockedByCap) return;
                onToggle(g.id);
              }}
              disabled={g.comingSoon || blockedByCap}
              aria-pressed={active}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition",
                g.comingSoon
                  ? "cursor-not-allowed border-white/[0.06] bg-white/[0.01] opacity-50"
                  : active
                    ? "border-cyan-400/55 bg-cyan-400/[0.08] shadow-[0_0_14px_-4px_rgba(34,211,238,0.45)]"
                    : blockedByCap
                      ? "cursor-not-allowed border-white/[0.06] bg-white/[0.01] opacity-45"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]",
              )}
            >
              <span className="text-xl leading-none" aria-hidden>
                {g.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold text-white/90">
                  {g.label}
                  {g.comingSoon ? (
                    <span className="ml-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.14em] text-amber-200/90">
                      Soon
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-white/45">
                  {g.mission.split(":").slice(1).join(":").trim() || g.mission}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 2 — Kenalan & Persona ──────────────────────────────────────────────

export function Step2Persona({
  archetype,
  name,
  emoji,
  theme,
  tone,
  userTitles,
  personality,
  language,
  emojiUsage,
  responseStyle,
  soulContent,
  soulEdited,
  onName,
  onEmoji,
  onTheme,
  onTone,
  onToggleTitle,
  onTogglePersonality,
  onLanguage,
  onEmojiUsage,
  onResponseStyle,
  onSoulEdit,
  onSoulReset,
}: {
  archetype: Archetype;
  name: string;
  emoji: string;
  theme: string;
  tone: string;
  userTitles: string[];
  personality: string[];
  language: string;
  emojiUsage: string;
  responseStyle: string;
  soulContent: string;
  soulEdited: boolean;
  onName: (v: string) => void;
  onEmoji: (v: string) => void;
  onTheme: (v: string) => void;
  onTone: (v: string) => void;
  onToggleTitle: (id: string) => void;
  onTogglePersonality: (id: string) => void;
  onLanguage: (v: string) => void;
  onEmojiUsage: (v: string) => void;
  onResponseStyle: (v: string) => void;
  onSoulEdit: (v: string) => void;
  onSoulReset: () => void;
}) {
  const themes = ["cyan", "fuchsia", "indigo", "emerald", "amber", "rose"] as const;
  const titlesAtCap = userTitles.length >= MAX_TITLES;
  const persAtCap = personality.length >= MAX_PERSONALITY;
  return (
    <div className="space-y-5">
      <PersonaStrip archetype={archetype} name={name} emoji={emoji} hasSignal nameStep />

      {/* Name */}
      <div className="flex items-center gap-3">
        <div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/15 bg-white/[0.04]">
          {emoji ? <span className="text-3xl">{emoji}</span> : <Bot className="size-7 text-white/35" aria-hidden />}
        </div>
        <div className="flex-1">
          <SectionLabel>Agent name <span className="text-amber-300">*</span></SectionLabel>
          <input
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder={archetype.defaultName}
            autoFocus
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
          />
        </div>
      </div>

      {/* Emoji + theme (cosmetics, compact) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
        <div>
          <SectionLabel>Avatar emoji</SectionLabel>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
            <div className="grid grid-cols-8 gap-1.5">
              {SUGGESTED_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => onEmoji(e)}
                  className={cn(
                    "rounded-md p-1 text-lg transition hover:bg-white/[0.06]",
                    emoji === e ? "bg-cyan-400/15 ring-1 ring-cyan-400/40" : "",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
            <div className="mt-2 flex justify-between border-t border-white/[0.06] pt-2">
              <button
                type="button"
                onClick={() => onEmoji(randomEmoji())}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/70 hover:text-white"
              >
                <Sparkles className="size-3" aria-hidden /> Random
              </button>
              <button
                type="button"
                onClick={() => onEmoji("")}
                className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/70 hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
        <div>
          <SectionLabel>Theme</SectionLabel>
          <div className="flex gap-2">
            {themes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTheme(t)}
                className={cn(
                  "size-8 rounded-lg border-2 transition",
                  t === theme ? "border-white/60 ring-2 ring-white/30" : "border-white/10",
                )}
                style={{ backgroundColor: themeColor(t) }}
                title={t}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Tone */}
      <div>
        <SectionLabel hint="The agent's default speaking style when talking to you.">How it talks</SectionLabel>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {TONES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTone(t.id)}
              aria-pressed={tone === t.id}
              className={cn(
                "rounded-xl border px-3 py-2 text-left transition",
                tone === t.id
                  ? "border-cyan-400/55 bg-cyan-400/[0.08]"
                  : "border-white/10 bg-white/[0.03] hover:border-white/25",
              )}
            >
              <div className="text-[12px] font-semibold text-white/90">{t.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-white/45">{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Sapaan */}
      <div>
        <SectionLabel hint={`How the agent addresses you (max ${MAX_TITLES}).`}>What should it call you?</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {USER_TITLES.map((u) => {
            const active = userTitles.includes(u.id);
            return (
              <ChipButton
                key={u.id}
                active={active}
                disabled={!active && titlesAtCap}
                onClick={() => onToggleTitle(u.id)}
              >
                {u.label}
              </ChipButton>
            );
          })}
        </div>
      </div>

      {/* Personality */}
      <div>
        <SectionLabel hint={`Personality traits baked into the agent (max ${MAX_PERSONALITY}).`}>What's its personality?</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {PERSONALITY_TRAITS.map((p) => {
            const active = personality.includes(p.id);
            return (
              <ChipButton
                key={p.id}
                active={active}
                disabled={!active && persAtCap}
                onClick={() => onTogglePersonality(p.id)}
                title={p.desc}
              >
                {p.label}
              </ChipButton>
            );
          })}
        </div>
      </div>

      {/* Advanced (language / emoji / response) */}
      <details className="group rounded-xl border border-white/[0.08] bg-white/[0.02]">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[12px] font-semibold text-white/70 transition hover:text-white">
          <span>Customize further (optional)</span>
          <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-3 border-t border-white/[0.06] px-3 py-3">
          <MiniRadio label="Language" options={LANGUAGES} value={language} onChange={onLanguage} />
          <MiniRadio label="Emoji usage" options={EMOJI_USAGE} value={emojiUsage} onChange={onEmojiUsage} />
          <MiniRadio label="Response length" options={RESPONSE_STYLES} value={responseStyle} onChange={onResponseStyle} />
        </div>
      </details>

      {/* SOUL.md — auto-built, editable behind a disclosure */}
      <details className="group rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/[0.03]">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[12px] font-semibold text-fuchsia-100/85 transition hover:text-white">
          <span className="inline-flex items-center gap-1.5">
            <Wand2 className="size-3.5" aria-hidden /> Lihat &amp; edit SOUL.md
            {soulEdited ? (
              <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.14em] text-fuchsia-200/90">
                edited
              </span>
            ) : null}
          </span>
          <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-2.5 border-t border-fuchsia-400/15 px-3 py-3">
          <p className="text-[10.5px] text-white/50">
            SOUL.md = the agent's personality instructions — like a job description for the AI.
            It's built automatically from your choices above; you can edit it here if you want.
            The engine reads this at the start of every chat.
          </p>
          <textarea
            value={soulContent}
            onChange={(e) => onSoulEdit(e.target.value)}
            rows={12}
            spellCheck={false}
            className="scrollbar-slim w-full resize-y rounded-lg border border-white/10 bg-[#0d1117] px-3 py-2 font-mono text-[11px] leading-relaxed text-white/85 focus:border-fuchsia-400/40 focus:outline-none"
          />
          <div className="flex items-center justify-between text-[10px] text-white/40">
            <span>{soulContent.length} characters</span>
            {soulEdited ? (
              <button
                type="button"
                onClick={onSoulReset}
                className="rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono uppercase tracking-[0.14em] text-white/60 hover:text-white"
              >
                Reset to auto
              </button>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}

function MiniRadio({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold text-white/60">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <ChipButton key={o.id} active={value === o.id} onClick={() => onChange(o.id)}>
            {o.label}
          </ChipButton>
        ))}
      </div>
    </div>
  );
}

// ── Step 3 — Otak & Saluran (engine model + channels) ───────────────────────

export function Step3Engine({
  modelPrimary,
  modelFallback,
  channels,
  flatModels,
  modelsLoading,
  onModelPrimary,
  onModelFallback,
  onChannels,
}: {
  modelPrimary: string;
  modelFallback: string;
  channels: Set<string>;
  flatModels: FlatModelChoice[];
  modelsLoading: boolean;
  onModelPrimary: (v: string) => void;
  onModelFallback: (v: string) => void;
  onChannels: (next: Set<string>) => void;
}) {
  const toggleChannel = (id: string) => {
    if (id === "web") return; // mandatory base
    const cat = CHANNEL_CATALOG.find((c) => c.id === id);
    if (cat?.comingSoon) return;
    const next = new Set(channels);
    next.add("web");
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChannels(next);
  };
  return (
    <div className="space-y-5">
      {/* Engine model */}
      <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.03] p-3.5">
        <SectionLabel hint="Populated automatically from providers with an active API key. The primary model is used by default; the fallback kicks in if the primary errors.">
          Agent AI brain <span className="text-amber-300">*</span>
        </SectionLabel>
        {modelsLoading && flatModels.length === 0 ? (
          <div className="mt-2 h-9 animate-pulse rounded-lg bg-white/[0.04]" />
        ) : flatModels.length === 0 ? (
          <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-[11.5px] text-amber-100/90">
            ⚠️ No provider has an active API key yet. Open the{" "}
            <a
              href="/app/providers"
              className="font-semibold text-cyan-200 underline decoration-cyan-400/40 underline-offset-2 transition hover:text-cyan-100"
            >
              AI Providers tab
            </a>{" "}
            to add at least 1 key (Gemini free tier is the easiest to start with).
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <div>
              <label className="mb-1 block text-[10.5px] font-semibold text-white/65">Primary model</label>
              <ModelSelect value={modelPrimary} onChange={onModelPrimary} options={flatModels} />
            </div>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-[10.5px] font-semibold text-white/55 hover:text-white/80">
                <ChevronDown className="size-3.5 transition group-open:rotate-180" aria-hidden />
                Add fallback model (optional)
              </summary>
              <div className="mt-1.5">
                <ModelSelect value={modelFallback} onChange={onModelFallback} options={flatModels} allowEmpty />
              </div>
            </details>
            <div className="text-[10px] text-white/40">
              Available providers: {Array.from(new Set(flatModels.map((m) => m.providerName))).join(" · ")}
            </div>
          </div>
        )}
      </div>

      {/* Channels */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5">
        <SectionLabel hint="Web only = base channel, the agent is always reachable in /app. Add messaging channels if you want the agent to respond to users outside of AgentBuff.">
          Where should it show up?
        </SectionLabel>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CHANNEL_OPTIONS.map((c) => {
            const active = channels.has(c.id);
            const isWeb = c.id === "web";
            const cat = CHANNEL_CATALOG.find((cc) => cc.id === c.id);
            const isComingSoon = !isWeb && cat?.comingSoon === true;
            const disabled = isWeb || isComingSoon;
            const titleText = isWeb
              ? "Always active — the agent is always reachable via /app"
              : isComingSoon
                ? "Coming soon — this channel can't be paired yet"
                : c.hint;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleChannel(c.id)}
                disabled={disabled}
                title={titleText}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] transition",
                  isWeb
                    ? "cursor-default border-emerald-400/50 bg-emerald-400/[0.12] text-emerald-100 shadow-[0_0_12px_-2px_rgba(16,185,129,0.55)]"
                    : isComingSoon
                      ? "cursor-not-allowed border-white/[0.06] bg-white/[0.01] text-white/35"
                      : active
                        ? "border-emerald-400/40 bg-emerald-400/[0.10] text-emerald-100 shadow-[0_0_10px_-2px_rgba(16,185,129,0.45)]"
                        : "border-white/[0.10] bg-white/[0.02] text-white/55 hover:border-white/25 hover:text-white/80",
                )}
              >
                <span aria-hidden className={isComingSoon ? "opacity-50" : undefined}>{c.icon}</span>
                {c.label}
                {isWeb ? (
                  <span className="ml-0.5 font-bold tracking-[0.12em] text-emerald-300/90">· REQUIRED</span>
                ) : isComingSoon ? (
                  <span className="ml-0.5 rounded-full border border-white/15 bg-white/[0.04] px-1.5 text-[8.5px] font-bold tracking-[0.18em] text-white/50">
                    SOON
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ModelSelect({
  value,
  onChange,
  options,
  allowEmpty,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FlatModelChoice[];
  allowEmpty?: boolean;
}) {
  const byProvider = new Map<string, FlatModelChoice[]>();
  for (const o of options) {
    const arr = byProvider.get(o.providerName) ?? [];
    arr.push(o);
    byProvider.set(o.providerName, arr);
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-white/10 bg-[#0d1117] px-3 py-2 text-[12.5px] text-white focus:border-cyan-400/50 focus:outline-none"
    >
      {allowEmpty ? <option value="">— none —</option> : null}
      {Array.from(byProvider.entries()).map(([provider, models]) => (
        <optgroup key={provider} label={provider}>
          {models.map((m) => (
            <option key={`${m.providerSlug}:${m.model}`} value={m.model}>
              {m.model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
