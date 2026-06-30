"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Sparkles, UserPlus, Settings2, Rocket } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

const STEPS = [
  {
    icon: UserPlus,
    gradient: "from-cyan-400 to-blue-500",
    glow: "rgba(6,182,212,0.3)",
    border: "border-cyan-500/30",
    accent: "text-cyan-400",
    bg: "bg-cyan-500/10",
  },
  {
    icon: Settings2,
    gradient: "from-violet-400 to-indigo-500",
    glow: "rgba(139,92,246,0.3)",
    border: "border-violet-500/30",
    accent: "text-violet-400",
    bg: "bg-violet-500/10",
  },
  {
    icon: Rocket,
    gradient: "from-emerald-400 to-teal-500",
    glow: "rgba(16,185,129,0.3)",
    border: "border-emerald-500/30",
    accent: "text-emerald-400",
    bg: "bg-emerald-500/10",
  },
];

export function HomeCustomAgent() {
  const { t } = useI18n();
  const s = t.customAgent;
  const [activeStep, setActiveStep] = useState(0);

  /* Auto-cycle steps */
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveStep((p) => (p + 1) % 3);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="relative overflow-hidden bg-slate-50 py-16 dark:bg-[#030014] sm:py-20 lg:py-24">
      {/* Grid bg */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ambient glow */}
      <div className="pointer-events-none absolute left-1/4 top-1/2 h-[500px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/10 blur-[200px]" />

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-12 lg:flex-row lg:gap-16">

          {/* ── Left: Character image ── */}
          <motion.div
            className="relative flex-shrink-0"
            initial={{ x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="relative h-[350px] w-[300px] sm:h-[450px] sm:w-[380px] lg:h-[520px] lg:w-[440px]">
              {/* Glow behind character */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/20 via-cyan-500/10 to-transparent blur-[80px]" />
              <Image
                src="/images/roles/custom.webp"
                alt="The Forge Architect"
                fill
                className="object-contain drop-shadow-[0_15px_40px_rgba(0,0,0,0.5)]"
                sizes="440px"
                priority
              />
            </div>
          </motion.div>

          {/* ── Right: Content ── */}
          <motion.div
            className="flex flex-1 flex-col lg:max-w-xl"
            initial={{ x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.15 }}
          >
            {/* Heading */}
            <h2
              className="text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-[2.75rem]"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {s.headingTop}
              <br />
              <span className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
                {s.headingHighlight}
              </span>
            </h2>

            {/* Subtitle */}
            <p className="mt-4 text-sm leading-relaxed text-slate-500 dark:text-white/40 sm:text-base">
              {s.subtitle}{" "}
              <span className="font-semibold bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
                {s.subtitleHighlight}
              </span>
            </p>

            {/* ── Step flow ── */}
            <div className="mt-8 flex flex-col gap-4 sm:mt-10">
              {s.steps.map((step: { title: string; desc: string }, i: number) => {
                const visual = STEPS[i];
                const isActive = activeStep === i;
                const Icon = visual.icon;

                return (
                  <motion.div
                    key={i}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    aria-label={`${step.title} — Step ${i + 1}`}
                    className={`group relative cursor-pointer rounded-xl border p-4 backdrop-blur-md transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 sm:p-5 ${
                      isActive
                        ? `${visual.border} bg-white dark:bg-white/[0.04]`
                        : "border-slate-200 bg-white/60 hover:border-slate-300 hover:bg-white dark:border-white/[0.04] dark:bg-transparent dark:hover:border-white/[0.08] dark:hover:bg-white/[0.02]"
                    }`}
                    onClick={() => setActiveStep(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveStep(i);
                      }
                    }}
                    animate={isActive ? { scale: 1 } : { scale: 0.98 }}
                    transition={{ duration: 0.25 }}
                    style={{
                      // Active emphasis = a soft accent-colored glow (fades via
                      // the card's transition-all), not a hard left bar. Reads
                      // as an intentionally lit card, not a template accent strip.
                      boxShadow: isActive ? `0 14px 44px -14px ${visual.glow}` : undefined,
                    }}
                  >
                    <div className="flex items-start gap-4">
                      {/* Step number + icon */}
                      <div
                        className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition-all duration-300 sm:size-12 ${
                          isActive
                            ? `${visual.bg} shadow-[0_0_20px_-5px] shadow-current ${visual.accent}`
                            : "bg-slate-100 text-slate-400 dark:bg-white/[0.04] dark:text-white/30"
                        }`}
                      >
                        <Icon className="size-5 sm:size-6" />
                      </div>

                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-bold uppercase tracking-widest transition-colors duration-300 ${
                              isActive ? visual.accent : "text-slate-400 dark:text-white/20"
                            }`}
                          >
                            Step {i + 1}
                          </span>
                        </div>
                        <h3
                          className={`mt-0.5 text-sm font-bold transition-colors duration-300 sm:text-base ${
                            isActive ? "text-slate-900 dark:text-white" : "text-slate-500 dark:text-white/40"
                          }`}
                        >
                          {step.title}
                        </h3>
                        {/* Description is ALWAYS rendered (space reserved) so the
                            auto-cycle only moves emphasis (color + glow + scale),
                            never the layout height — the section below never
                            jumps. Active = brighter, inactive = dimmed. */}
                        <p
                          className={`mt-1.5 text-xs leading-relaxed transition-colors duration-300 sm:text-sm ${
                            isActive
                              ? "text-slate-600 dark:text-white/45"
                              : "text-slate-400 dark:text-white/20"
                          }`}
                        >
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Progress dots */}
            <div className="mt-5 flex items-center gap-2">
              {[0, 1, 2].map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Langkah ${i + 1}`}
                  aria-current={i === activeStep}
                  onClick={() => setActiveStep(i)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === activeStep ? "w-6 bg-violet-500 dark:bg-violet-400" : "w-1.5 bg-slate-300 hover:bg-slate-500 dark:bg-white/15 dark:hover:bg-white/30"
                  }`}
                />
              ))}
            </div>

            {/* CTA */}
            <Link
              href="/register"
              className="mt-6 inline-flex w-fit items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 px-7 py-3 text-sm font-bold text-white shadow-[0_0_25px_rgba(139,92,246,0.3)] transition-all hover:shadow-[0_0_40px_rgba(139,92,246,0.5)] hover:brightness-110 active:scale-[0.97]"
            >
              <Sparkles className="size-3.5" />
              {s.cta}
              <ArrowRight className="size-4" />
            </Link>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
