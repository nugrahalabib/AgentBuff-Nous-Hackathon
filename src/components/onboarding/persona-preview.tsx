"use client";

// The live persona payoff for /onboarding. Renders THE Buff the user is
// building — emoji + name + one-line specialization + first greeting + goal
// chips — derived PURELY from the in-memory `answers` (deriveArchetype +
// validGoalIds + getGoalLabel + USER_TITLES). No fetch, no RPC. Each datum pops
// in as its answer lands (the continuity object the flow used to lack), so every
// step visibly advances the same artifact.
//
// Reused by the rail (compact "rail" variant) AND the Step-6 finale ("hero").
// Persona content is Bahasa by nature — the archetype/goal data modules are
// Bahasa-only (like the existing Step-4 SOUL preview), independent of UI locale.

import { motion, useReducedMotion } from "framer-motion";
import { deriveArchetype } from "@/lib/onboarding/archetypes";
import { validGoalIds, getGoalLabel } from "@/lib/onboarding/goals";
import { USER_TITLES, getPersonaOption } from "@/lib/onboarding/persona-options";
import type { OnboardingAnswers } from "@/lib/onboarding/answers";
import { cn } from "@/lib/utils";

const PLACEHOLDER_EMOJI = "🤖";
const MAX_CHIPS = 4;

function titleDisplay(id: string): string {
  // Known title id → its label ("mas" → "Mas"); a free-typed title is itself.
  return getPersonaOption(USER_TITLES, id)?.label ?? id;
}

export function PersonaPreview({
  answers,
  variant = "rail",
  className,
}: {
  answers: OnboardingAnswers;
  variant?: "rail" | "hero";
  className?: string;
}) {
  const reduce = useReducedMotion();
  const hero = variant === "hero";

  // The archetype is only meaningful once role/goals exist — before that,
  // deriveArchetype falls back to ARCHETYPES[0], so we must NOT show its emoji /
  // name / specialization yet or the preview would lie about an empty form.
  const goals = validGoalIds(answers.interestIds);
  const hasSignal = goals.length > 0 || answers.role.trim().length > 0;
  const derived = deriveArchetype({ goals: answers.interestIds, role: answers.role });

  const nickname = answers.nickname.trim();
  const emoji = answers.agentEmoji || (hasSignal ? derived.emoji : PLACEHOLDER_EMOJI);
  const name = answers.agentName.trim() || (hasSignal ? derived.defaultName : "");
  const specialization = hasSignal ? derived.specialization : "";
  const firstTitle = answers.userTitles[0];
  const greeting = nickname
    ? `Halo, ${firstTitle ? `${titleDisplay(firstTitle)} ` : ""}${nickname}!`
    : "";
  const goalLabels = goals
    .map((id) => getGoalLabel(id))
    .filter((v): v is string => Boolean(v));

  // Pop a datum in when its VALUE changes (re-key) — the "it reacts to my pick"
  // delight. Reduced-motion: render settled, no pop.
  const pop = reduce
    ? {}
    : { initial: { opacity: 0, scale: 0.92 }, animate: { opacity: 1, scale: 1 } };

  return (
    <div
      aria-hidden
      className={cn(
        "flex flex-col items-center text-center",
        hero ? "gap-3" : "gap-2",
        className,
      )}
    >
      <motion.div
        key={emoji}
        {...pop}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="relative shrink-0"
      >
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 blur-md transition-opacity",
            name ? "opacity-50" : "opacity-25",
          )}
        />
        <div
          className={cn(
            "relative flex items-center justify-center rounded-full border bg-[#0B0E14]",
            name ? "border-cyan-400/50" : "border-white/15",
            hero ? "size-24 text-5xl" : "size-16 text-3xl",
          )}
        >
          <span className={name ? "" : "opacity-60 grayscale"}>{emoji}</span>
        </div>
      </motion.div>

      <div className="min-w-0">
        {name ? (
          <motion.p
            key={name}
            {...pop}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={cn("font-semibold text-white", hero ? "text-2xl" : "text-[15px]")}
          >
            {name}
          </motion.p>
        ) : (
          <p className={cn("font-semibold text-white/40", hero ? "text-2xl" : "text-[15px]")}>
            Buff kamu
          </p>
        )}

        <motion.p
          key={specialization || "forming"}
          {...pop}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className={cn(
            "mt-0.5 leading-snug",
            hero ? "text-[13px]" : "text-[11.5px]",
            specialization ? "text-white/60" : "text-white/35",
          )}
        >
          {specialization || "Lagi dibentuk dari pilihanmu…"}
        </motion.p>
      </div>

      {greeting ? (
        <motion.span
          key={greeting}
          {...pop}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className={cn(
            "inline-block rounded-full border border-cyan-400/25 bg-cyan-400/10 font-medium text-cyan-100",
            hero ? "px-3.5 py-1.5 text-[13px]" : "px-3 py-1 text-[11px]",
          )}
        >
          {greeting} 👋
        </motion.span>
      ) : null}

      {goalLabels.length > 0 ? (
        <div className="mt-0.5 flex flex-wrap justify-center gap-1.5">
          {goalLabels.slice(0, MAX_CHIPS).map((label) => (
            <motion.span
              key={label}
              {...pop}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/65"
            >
              {label}
            </motion.span>
          ))}
          {goalLabels.length > MAX_CHIPS ? (
            <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/45">
              +{goalLabels.length - MAX_CHIPS}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
