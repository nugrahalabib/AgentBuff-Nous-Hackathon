"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/* ─── Agent card data (images, colors mapped to i18n agent index) ─── */
const AGENT_VISUALS = [
  { image: "/images/roles/marketing.webp", gradient: "from-emerald-400 to-teal-400", glow: "bg-emerald-500/20", glowColor: "rgba(16,185,129,0.25)", border: "border-emerald-500/30", accent: "text-emerald-400", accentBg: "bg-emerald-500/15" },
  { image: "/images/roles/developer.webp", gradient: "from-cyan-400 to-blue-400", glow: "bg-cyan-500/20", glowColor: "rgba(6,182,212,0.25)", border: "border-cyan-500/30", accent: "text-cyan-400", accentBg: "bg-cyan-500/15" },
  { image: "/images/roles/analyst.webp", gradient: "from-violet-400 to-indigo-400", glow: "bg-violet-500/20", glowColor: "rgba(139,92,246,0.25)", border: "border-violet-500/30", accent: "text-violet-400", accentBg: "bg-violet-500/15" },
  { image: "/images/roles/customer-service.webp", gradient: "from-teal-400 to-green-400", glow: "bg-teal-500/20", glowColor: "rgba(20,184,166,0.25)", border: "border-teal-500/30", accent: "text-teal-400", accentBg: "bg-teal-500/15" },
  { image: "/images/roles/creator.webp", gradient: "from-fuchsia-400 to-purple-400", glow: "bg-fuchsia-500/20", glowColor: "rgba(217,70,239,0.25)", border: "border-fuchsia-500/30", accent: "text-fuchsia-400", accentBg: "bg-fuchsia-500/15" },
  { image: "/images/roles/finance.webp", gradient: "from-green-400 to-emerald-400", glow: "bg-green-500/20", glowColor: "rgba(34,197,94,0.25)", border: "border-green-500/30", accent: "text-green-400", accentBg: "bg-green-500/15" },
  { image: "/images/roles/study.webp", gradient: "from-orange-400 to-amber-400", glow: "bg-orange-500/20", glowColor: "rgba(249,115,22,0.25)", border: "border-orange-500/30", accent: "text-orange-400", accentBg: "bg-orange-500/15" },
  { image: "/images/roles/manager.webp", gradient: "from-sky-400 to-blue-400", glow: "bg-sky-500/20", glowColor: "rgba(56,189,248,0.25)", border: "border-sky-500/30", accent: "text-sky-400", accentBg: "bg-sky-500/15" },
];

const AUTO_ROTATE_MS = 3500;
const VISIBLE_RANGE = 3;

/* ─── Star rating ─── */
function Stars({ count }: { count: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className={`size-3 ${i < count ? "text-cyan-400" : "text-slate-300 dark:text-white/10"}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Coverflow Spotlight Carousel
   ═══════════════════════════════════════════════════ */
export function HomeSkillTree() {
  const { t } = useI18n();
  const s = t.skillTree;

  const total = s.agents.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  /* Track each card's previous offset to detect wrap-arounds */
  const prevOffsetsRef = useRef<number[]>(Array(8).fill(0).map((_, i) => i));

  /* Resume-after-interaction timer, tracked so we can clear it on unmount and
   * never leak a setPaused call after the carousel is gone. */
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseThenResume = useCallback(() => {
    setPaused(true);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setPaused(false), 8000);
  }, []);
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  /* Auto-rotate */
  const next = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % total);
  }, [total]);

  const prev = useCallback(() => {
    setActiveIndex((p) => (p - 1 + total) % total);
  }, [total]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(next, AUTO_ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, next]);

  const goTo = (idx: number) => {
    setActiveIndex(idx);
    pauseThenResume();
  };

  const handlePrev = () => {
    prev();
    pauseThenResume();
  };

  const handleNext = () => {
    next();
    pauseThenResume();
  };

  /* Calculate offset from center, wrapping around */
  const getOffset = (idx: number) => {
    let diff = idx - activeIndex;
    if (diff > total / 2) diff -= total;
    if (diff < -total / 2) diff += total;
    return diff;
  };

  /* Build per-card offsets and detect wraps */
  const cardStates = s.agents.map((_, i) => {
    const offset = getOffset(i);
    const prevOffset = prevOffsetsRef.current[i];
    // A card "wrapped" if its offset jumped more than 2 steps at once
    const wrapped = Math.abs(offset - prevOffset) > 2;
    return { offset, wrapped };
  });

  /* Update prevOffsets after computing (runs every render, intentionally) */
  useEffect(() => {
    prevOffsetsRef.current = cardStates.map((c) => c.offset);
  });

  const activeVisual = AGENT_VISUALS[activeIndex];

  return (
    <section id="fitur" className="relative overflow-hidden bg-slate-50 pb-20 pt-10 dark:bg-[#030014] sm:pb-28 sm:pt-14 lg:pb-32 lg:pt-16">
      {/* Grid background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ambient glow — follows active card color */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        key={activeIndex}
        initial={{ opacity: 1 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <div
          className="absolute left-1/2 top-[40%] h-[500px] w-[700px] -translate-x-1/2 rounded-full blur-[200px]"
          style={{ backgroundColor: activeVisual.glowColor }}
        />
      </motion.div>

      <div className="relative z-10">
        {/* ── Header ── */}
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div
            className="mb-14 text-center sm:mb-16"
            initial={{ y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            {s.badge && (
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/[0.06] px-4 py-1.5 backdrop-blur-xl">
                <Sparkles className="size-3.5 text-indigo-500 dark:text-indigo-400" />
                <span className="text-xs font-bold tracking-wider text-indigo-600/70 dark:text-indigo-400/70">
                  {s.badge}
                </span>
              </div>
            )}
            <h2
              className="text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {s.title}
              <br />
              {s.titleMid}{" "}
              <span className="bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
                {s.titleMidHighlight}
              </span>
              <br />
              <span className="bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent dark:from-indigo-400 dark:to-violet-400">
                {s.titleHighlight}
              </span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-white/40 sm:text-base">
              {s.subtitle}
            </p>
          </motion.div>
        </div>

        {/* ── Coverflow Carousel ── */}
        <div className="relative mx-auto h-[520px] max-w-7xl sm:h-[550px]">
          {/* Fade edges */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-30 w-16 bg-gradient-to-r from-slate-50 to-transparent dark:from-[#030014] sm:w-28" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-30 w-16 bg-gradient-to-l from-slate-50 to-transparent dark:from-[#030014] sm:w-28" />

          {/* Cards container */}
          <div className="relative h-full w-full">
            {s.agents.map((agent, i) => {
              const { offset, wrapped } = cardStates[i];
              const absOffset = Math.abs(offset);
              const visual = AGENT_VISUALS[i];
              const isActive = offset === 0;
              const isVisible = absOffset <= VISIBLE_RANGE;

              // All cards stay mounted — hidden ones get opacity 0
              const scale = isActive ? 1 : absOffset === 1 ? 0.78 : 0.65;
              const xPos = offset * 260;
              const zIndex = isVisible ? 20 - absOffset : 0;
              const opacity = !isVisible ? 0 : isActive ? 1 : absOffset === 1 ? 0.5 : 0.3;
              const brightness = isActive ? 1 : 0.4;

              return (
                <motion.div
                  key={i}
                  className="absolute left-1/2 top-0"
                  initial={false}
                  animate={{
                    x: xPos - 130,
                    scale,
                    opacity,
                    filter: `brightness(${brightness})`,
                  }}
                  transition={
                    wrapped
                      ? { duration: 0 }
                      : { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }
                  }
                  style={{
                    zIndex,
                    width: 260,
                    pointerEvents: isVisible ? "auto" : "none",
                  }}
                  onClick={() => !isActive && isVisible && goTo(i)}
                  onMouseEnter={() => { if (!isActive && isVisible) setPaused(true); }}
                  onMouseLeave={() => { if (!isActive && isVisible) setPaused(false); }}
                  whileHover={!isActive && isVisible ? { filter: "brightness(0.7)", scale: scale * 1.03 } : {}}
                >
                  <div className={`relative flex flex-col overflow-visible rounded-2xl border bg-white/90 shadow-md backdrop-blur-xl transition-colors duration-300 dark:bg-[#0a0a1a]/80 dark:shadow-none ${isActive ? visual.border : "border-slate-200 dark:border-white/[0.04]"} ${!isActive && isVisible ? "cursor-pointer" : ""}`}>

                    {/* Character image area */}
                    <div className="relative h-[220px] overflow-visible sm:h-[240px]">
                      <div
                        className={`absolute inset-0 rounded-t-2xl ${visual.glow} transition-opacity duration-300 ${isActive ? "opacity-50" : "opacity-0"}`}
                      />
                      <div
                        className="absolute inset-0 rounded-t-2xl"
                        style={{ background: "radial-gradient(ellipse at center bottom, rgba(255,255,255,0.04) 0%, transparent 70%)" }}
                      />

                      {/* Character — breaks out above card */}
                      <div className="absolute -top-20 left-1/2 h-[320px] w-[220px] -translate-x-1/2 z-10 sm:h-[340px] sm:w-[240px]">
                        {/* Only fetch the image for cards within the visible
                            carousel range; off-screen cards skip the request. */}
                        {isVisible && (
                          <Image
                            src={visual.image}
                            alt={agent.name}
                            fill
                            className="object-contain object-bottom drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
                            sizes="240px"
                          />
                        )}
                      </div>
                    </div>

                    {/* Info area */}
                    <div className="relative bg-gradient-to-b from-white/[0.03] to-transparent px-4 pb-4 pt-4">
                      {/* Glowing class badge — only on active */}
                      <AnimatePresence>
                        {isActive && (
                          <motion.div
                            className="absolute -top-3.5 left-1/2 z-20 -translate-x-1/2"
                            initial={{ y: 5, scale: 0.9 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ y: 5, scale: 0.9 }}
                            transition={{ duration: 0.3 }}
                          >
                            <div className={`whitespace-nowrap rounded-full border ${visual.border} ${visual.accentBg} px-3.5 py-1 text-[9px] font-bold uppercase tracking-wider backdrop-blur-md ${visual.accent} shadow-[0_0_15px_-3px] ${visual.glow}`}>
                              {agent.class}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <h3
                        className={`mt-1 text-center text-lg font-black tracking-tight transition-colors duration-300 ${isActive ? "text-slate-900 dark:text-white" : "text-slate-500 dark:text-white/50"}`}
                        style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                      >
                        {agent.name}
                      </h3>

                      <div className="mt-1.5 flex justify-center">
                        <Stars count={5} />
                      </div>



                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                        <div>
                          <span className={`font-bold ${visual.accent}`}>Type:</span>
                          <p className="text-slate-600 dark:text-white/40">{agent.class.split(" & ")[0]}</p>
                        </div>
                        <div>
                          <span className={`font-bold ${visual.accent}`}>Rating:</span>
                          <p className="text-slate-600 dark:text-white/40">5.0 / 5.0</p>
                        </div>
                        <div className="col-span-2">
                          <span className={`font-bold ${visual.accent}`}>Skill:</span>
                          <p className="text-white/40 line-clamp-2">{agent.description}</p>
                        </div>
                      </div>

                      {isActive && (
                        <motion.button
                          type="button"
                          className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-gradient-to-r ${visual.gradient} px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-lg transition-shadow hover:shadow-xl`}
                          initial={{ y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: 0.1 }}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.97 }}
                        >
                          <Sparkles className="size-3.5" />
                          {s.ctaEquip}
                        </motion.button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* ── Nav arrows + dot indicators (below center card) ── */}
          <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-4">
            <button
              type="button"
              aria-label="Agen sebelumnya"
              onClick={handlePrev}
              className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 backdrop-blur-md transition-all hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 dark:border-white/10 dark:bg-white/[0.05] dark:text-white/50 dark:hover:border-white/20 dark:hover:bg-white/[0.1] dark:hover:text-white/80"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>

            <div className="flex items-center gap-2">
              {s.agents.map((agent, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Lihat ${agent.name}`}
                  aria-current={i === activeIndex}
                  onClick={() => goTo(i)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === activeIndex
                      ? "w-6 bg-slate-700 dark:bg-white/70"
                      : "w-1.5 bg-slate-300 hover:bg-slate-500 dark:bg-white/20 dark:hover:bg-white/40"
                  }`}
                />
              ))}
            </div>

            <button
              type="button"
              aria-label="Agen berikutnya"
              onClick={handleNext}
              className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 backdrop-blur-md transition-all hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 dark:border-white/10 dark:bg-white/[0.05] dark:text-white/50 dark:hover:border-white/20 dark:hover:bg-white/[0.1] dark:hover:text-white/80"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* ── Bottom CTA — two buttons ── */}
        <motion.div
          className="mx-auto mt-10 flex max-w-xl flex-col items-center justify-center gap-3 px-4 sm:mt-12 sm:flex-row sm:gap-4 sm:px-6"
          initial={{ y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 px-7 py-3 text-sm font-bold text-white shadow-[0_0_25px_rgba(99,102,241,0.3)] transition-all hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] hover:brightness-110 active:scale-[0.97]"
          >
            {s.ctaBrowseAll}
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-7 py-3 text-sm font-bold text-slate-700 shadow-sm backdrop-blur-md transition-all hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 active:scale-[0.97] dark:border-white/15 dark:bg-white/[0.04] dark:text-white/80 dark:shadow-none dark:hover:border-white/25 dark:hover:bg-white/[0.08] dark:hover:text-white"
          >
            <Sparkles className="size-3.5 text-cyan-400" />
            {s.ctaTrial}
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
