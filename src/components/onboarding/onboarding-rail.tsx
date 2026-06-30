"use client";

// The persistent LEFT RAIL of the desktop-first onboarding shell. Turns the
// dead side-space of the old 672px column into orientation + payoff: brand, the
// live PersonaPreview (the Buff assembling in real time), a NAMED vertical
// stepper, and an ETA. Rendered ONCE by wizard.tsx OUTSIDE the AnimatePresence
// step-swap (so it never animates out) and OUTSIDE GatewayProvider.
//
// Responsive: lg+ = full sticky rail; below lg = a slim brand+ETA strip (the
// pane's own StepProgress + eyebrow carry step detail on small screens — the
// full persona payoff is desktop-first per the Chief's "khususnya desktop").
//
// a11y: the named stepper is a real <nav> with aria-current; the PersonaPreview
// is decorative (aria-hidden inside the component). The thin role=progressbar
// lives on the pane (StepProgress), not here, so SR users get one progress
// signal + one nav.

import { Check } from "lucide-react";
import { siteConfig } from "@/lib/constants";
import { PersonaPreview } from "./persona-preview";
import type { OnboardingAnswers } from "@/lib/onboarding/answers";
import { cn } from "@/lib/utils";

function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[12px] font-bold text-[#0B0E14]">
        {siteConfig.name.charAt(0)}
      </div>
      <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/75">
        {siteConfig.name}
      </span>
    </div>
  );
}

function Stepper({
  step,
  total,
  stepLabels,
  navLabel,
}: {
  step: number;
  total: number;
  stepLabels: readonly string[];
  navLabel: string;
}) {
  return (
    <nav aria-label={navLabel} className="flex flex-col gap-0.5">
      {Array.from({ length: total }, (_, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div
            key={i}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
              active && "bg-white/[0.05]",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-all",
                done
                  ? "bg-cyan-400 text-[#0B0E14]"
                  : active
                    ? "border-2 border-cyan-400 text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.7)]"
                    : "border-2 border-white/20 text-white/40",
              )}
            >
              {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={cn(
                "text-[12px] transition-colors",
                active
                  ? "font-medium text-white"
                  : done
                    ? "text-white/55"
                    : "text-white/40",
              )}
            >
              {stepLabels[i]}
            </span>
          </div>
        );
      })}
    </nav>
  );
}

export function OnboardingRail({
  answers,
  step,
  total,
  stepLabels,
  stepsLeftLabel,
  lastStepLabel,
  stepperNavLabel,
}: {
  answers: OnboardingAnswers;
  step: number;
  total: number;
  stepLabels: readonly string[];
  stepsLeftLabel: string;
  lastStepLabel: string;
  stepperNavLabel: string;
}) {
  const stepsLeft = total - step - 1;
  const eta =
    stepsLeft <= 0
      ? lastStepLabel
      : stepsLeftLabel.replace("{n}", String(stepsLeft));

  return (
    <>
      {/* Mobile/tablet strip — brand + ETA. Pane carries step detail below. */}
      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-[#0B0E14]/80 px-4 py-2.5 backdrop-blur-2xl lg:hidden">
        <BrandMark />
        <span className="text-[10.5px] text-white/45">{eta}</span>
      </div>

      {/* Desktop full rail — sticky, never animates on step change. */}
      <aside className="hidden lg:sticky lg:top-8 lg:flex lg:flex-col lg:gap-6 lg:self-start lg:rounded-[1.5rem] lg:border lg:border-white/10 lg:bg-[#0B0E14]/80 lg:p-6 lg:backdrop-blur-2xl">
        <BrandMark />
        <div className="border-y border-white/[0.06] py-5">
          <PersonaPreview answers={answers} />
        </div>
        <Stepper
          step={step}
          total={total}
          stepLabels={stepLabels}
          navLabel={stepperNavLabel}
        />
        <p className="text-[11px] text-white/40">{eta}</p>
      </aside>
    </>
  );
}
