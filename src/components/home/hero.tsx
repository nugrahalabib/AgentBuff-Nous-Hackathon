"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, animate } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useI18n } from "@/lib/i18n/context";

const roleImages = [
  "/images/roles/assistant.webp",
  "/images/roles/business.webp",
  "/images/roles/companion.webp",
  "/images/roles/creator.webp",
  "/images/roles/marketing.webp",
  "/images/roles/developer.webp",
  "/images/roles/researcher.webp",
  "/images/roles/finance.webp",
  "/images/roles/customer-service.webp",
  "/images/roles/study.webp",
  "/images/roles/analyst.webp",
  "/images/roles/design.webp",
  "/images/roles/manager.webp",
  "/images/roles/media.webp",
];

const roleColors = [
  "from-blue-400 to-cyan-400",
  "from-amber-400 to-orange-400",
  "from-pink-400 to-rose-400",
  "from-fuchsia-400 to-purple-400",
  "from-emerald-400 to-teal-400",
  "from-cyan-400 to-blue-400",
  "from-violet-400 to-indigo-400",
  "from-green-400 to-emerald-400",
  "from-teal-400 to-green-400",
  "from-orange-400 to-amber-400",
  "from-indigo-400 to-violet-400",
  "from-rose-400 to-pink-400",
  "from-sky-400 to-blue-400",
  "from-purple-400 to-fuchsia-400",
];

const roleGlowColors = [
  "bg-blue-500/25",
  "bg-amber-500/25",
  "bg-pink-500/25",
  "bg-fuchsia-500/25",
  "bg-emerald-500/25",
  "bg-cyan-500/25",
  "bg-violet-500/25",
  "bg-green-500/25",
  "bg-teal-500/25",
  "bg-orange-500/25",
  "bg-indigo-500/25",
  "bg-rose-500/25",
  "bg-sky-500/25",
  "bg-purple-500/25",
];

/* ─── Count-Up Animation ─── */
function CountUp({ value, delay = 0 }: { value: string; delay?: number }) {
  const [display, setDisplay] = useState("0");
  const hasAnimated = useRef(false);

  const parseValue = useCallback((v: string) => {
    // "2,000+" → { num: 2000, suffix: "+", decimals: 0, comma: true }
    // "100K+"  → { num: 100, suffix: "K+", decimals: 0, comma: false }
    // "1.5 Juta+" → { num: 1.5, suffix: " Juta+", decimals: 1, comma: false }
    // "1.5M+"  → { num: 1.5, suffix: "M+", decimals: 1, comma: false }
    // "4.9/5"  → { num: 4.9, suffix: "/5", decimals: 1, comma: false }
    const cleaned = v.replace(/,/g, "");
    const match = cleaned.match(/^([\d.]+)(.*)$/);
    if (!match) return { num: 0, suffix: v, decimals: 0, comma: false };
    const num = parseFloat(match[1]);
    const suffix = match[2];
    const decimals = match[1].includes(".") ? match[1].split(".")[1].length : 0;
    const comma = v.includes(",");
    return { num, suffix, decimals, comma };
  }, []);

  const formatNum = useCallback((n: number, decimals: number, comma: boolean) => {
    const fixed = n.toFixed(decimals);
    if (!comma) return fixed;
    const [int, dec] = fixed.split(".");
    const formatted = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return dec ? `${formatted}.${dec}` : formatted;
  }, []);

  useEffect(() => {
    const { num, suffix, decimals, comma } = parseValue(value);
    const controls = animate(0, num, {
      duration: hasAnimated.current ? 0.6 : 2.2,
      delay: hasAnimated.current ? 0 : delay,
      ease: [0.25, 0.46, 0.45, 0.94],
      onUpdate: (v) => setDisplay(formatNum(v, decimals, comma) + suffix),
    });
    hasAnimated.current = true;
    return () => controls.stop();
  }, [value, delay, parseValue, formatNum]);

  return <>{display}</>;
}

export function HomeHero() {
  const { t } = useI18n();
  const [currentRole, setCurrentRole] = useState(0);

  const roles = t.hero.rotatingRoles;
  const audiences = t.hero.audiences;
  const trustItems = [
    t.hero.trustNoCreditCard,
    t.hero.trustSetup,
    t.hero.trustCancel,
  ].filter(Boolean);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentRole((prev) => (prev + 1) % roles.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [roles.length]);

  return (
    <section className="relative min-h-screen overflow-hidden bg-slate-50 dark:bg-[#030014]">
      {/* Noise/grain texture overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.02] dark:opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ghost watermark text */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <span
          className="select-none whitespace-nowrap text-[clamp(150px,20vw,300px)] font-black uppercase tracking-tighter text-slate-900/[0.03] dark:text-white/[0.03]"
          style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
        >
          AGENTBUFF
        </span>
      </div>

      {/* Large positioned glows */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute -right-[100px] top-[10%] h-[700px] w-[700px] rounded-full bg-indigo-400/10 blur-[180px] dark:bg-indigo-600/20"
          animate={{ scale: [1, 1.1, 1], opacity: [0.15, 0.25, 0.15] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute -left-[200px] -top-[150px] h-[500px] w-[500px] rounded-full bg-violet-400/10 blur-[150px] dark:bg-violet-600/15"
          animate={{ x: [0, 40, 0], y: [0, 30, 0] }}
          transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute -bottom-[100px] left-[20%] h-[400px] w-[400px] rounded-full bg-cyan-400/8 blur-[140px] dark:bg-cyan-600/10"
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* Floating particles */}
      <div className="pointer-events-none absolute inset-0 hidden dark:block">
        {[...Array(25)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute size-[2px] rounded-full bg-white/20"
            style={{
              left: `${5 + ((i * 3.7) % 90)}%`,
              top: `${5 + ((i * 4.3) % 85)}%`,
            }}
            animate={{ opacity: [0, 0.6, 0], y: [0, -20, 0] }}
            transition={{
              duration: 3 + (i % 5),
              repeat: Infinity,
              delay: i * 0.25,
            }}
          />
        ))}
      </div>

      {/* Content */}
      <div className="relative z-10 mx-auto flex min-h-screen max-w-7xl flex-col justify-center px-4 pt-24 pb-20 sm:px-6 lg:px-8">
        <div className="relative">
          {/* Left — Copy */}
          <div className="relative z-20 max-w-2xl">
            {/* Badge */}
            <motion.div
              initial={{ y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/60 px-5 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04]">
                <div className="size-2 animate-pulse rounded-full bg-emerald-500 dark:bg-emerald-400" />
                <span className="text-sm font-medium text-slate-500 dark:text-white/60">
                  {t.hero.badge}
                </span>
              </div>
            </motion.div>

            {/* Heading — massive, tight tracking */}
            <motion.div
              initial={{ y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
            >
              <h1
                className="text-[clamp(1.5rem,5vw,4.5rem)] leading-[1.1] tracking-[-0.03em] text-slate-900 dark:text-white"
                style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
              >
                <span className="block whitespace-nowrap font-black">{t.hero.titleLine1}</span>
                <span className="relative block h-[1.15em] whitespace-nowrap">
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={currentRole}
                      initial={{ opacity: 0, y: 40, filter: "blur(8px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: -40, filter: "blur(8px)" }}
                      transition={{ duration: 0.5, ease: "easeInOut" }}
                      className={`absolute left-0 bg-gradient-to-r ${roleColors[currentRole]} bg-clip-text font-black text-transparent`}
                    >
                      {roles[currentRole].text}
                    </motion.span>
                  </AnimatePresence>
                </span>
                <span className="block whitespace-nowrap font-black">{t.hero.titleLine3}</span>
                <span className="block whitespace-nowrap font-black">{t.hero.titleLine4}</span>
              </h1>
            </motion.div>

            {/* Subtitle */}
            <motion.p
              className="mt-6 max-w-lg text-base leading-relaxed text-slate-500 sm:text-lg dark:text-white/50"
              initial={{ y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.25 }}
            >
              {t.hero.subtitle}
            </motion.p>

            {/* ── Mobile-only hero visual (lg:hidden) ──
                The desktop persona is the absolute block further down (lg:block)
                and is left 100% untouched, so the >=1024px layout stays
                pixel-identical. This is the in-flow persona for phones/tablets,
                where the desktop image is hidden. */}
            <div className="relative mx-auto mt-9 h-[260px] w-[230px] sm:h-[300px] sm:w-[260px] lg:hidden">
              {/* Rim glow — colour follows the active role */}
              <div
                aria-hidden
                className={`pointer-events-none absolute bottom-[6%] left-1/2 h-[68%] w-[80%] -translate-x-1/2 rounded-full ${roleGlowColors[currentRole]} blur-[60px] transition-colors duration-500`}
              />

              {/* Persona — plain render (no opacity/transform gate) so it ALWAYS
                  shows + loads, even if the page first mounted at desktop width
                  with this block display:none. Rotates via currentRole. */}
              <div className="relative h-full w-full">
                <Image
                  key={`m-img-${currentRole}`}
                  src={roleImages[currentRole]}
                  alt={roles[currentRole].text}
                  fill
                  sizes="260px"
                  className="object-contain object-bottom drop-shadow-[0_12px_40px_rgba(0,0,0,0.4)]"
                />
              </div>

              {/* Two floating badges (no opacity gate — always visible) */}
              {roles[currentRole].badges.slice(0, 2).map((badge, bi) => {
                const pos = ["left-0 top-[14%]", "right-0 bottom-[20%]"];
                const accent = [
                  `bg-gradient-to-r ${roleColors[currentRole]} bg-clip-text text-transparent`,
                  "text-cyan-600 dark:text-cyan-400",
                ];
                return (
                  <motion.div
                    key={bi}
                    className={`absolute z-10 ${pos[bi]}`}
                    animate={{ y: [0, bi === 0 ? -8 : -11, 0] }}
                    transition={{
                      duration: 4 + bi,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: bi * 0.6,
                    }}
                  >
                    <div className="rounded-xl border border-slate-200/60 bg-white/80 px-3 py-2 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                      <div className={`text-base font-black ${accent[bi]}`}>
                        {badge.value}
                      </div>
                      <div className="text-[9px] font-medium text-slate-400 dark:text-white/40">
                        {badge.label}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* CTAs */}
            <motion.div
              className="mt-8 flex flex-col gap-3 sm:mt-10 sm:flex-row sm:gap-4"
              initial={{ y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
            >
              {/* Primary CTA — solid gradient with glow */}
              <Link
                href="/register"
                className="group relative inline-flex items-center justify-center overflow-hidden rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 px-6 py-3.5 text-[15px] font-bold text-white shadow-[0_0_30px_rgba(99,102,241,0.3)] transition-all hover:shadow-[0_0_50px_rgba(99,102,241,0.5)] hover:brightness-110 sm:px-8 sm:py-4 sm:text-base dark:shadow-[0_0_30px_rgba(99,102,241,0.4)] dark:hover:shadow-[0_0_50px_rgba(99,102,241,0.6)]"
              >
                <span className="relative z-10 flex items-center gap-2">
                  {t.hero.ctaPrimary}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>

              {/* Secondary CTA — glass → scroll to the skill showcase (#fitur). */}
              <Link
                href="#fitur"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/60 px-6 py-3.5 text-[15px] font-medium text-slate-600 backdrop-blur-xl transition-all hover:border-slate-300 hover:bg-white/80 hover:text-slate-900 sm:px-8 sm:py-4 sm:text-base dark:border-white/10 dark:bg-white/[0.04] dark:text-white/70 dark:hover:border-white/20 dark:hover:bg-white/[0.08] dark:hover:text-white"
              >
                {t.hero.ctaSecondary}
              </Link>
            </motion.div>

            {/* Trust */}
            <motion.div
              className="mt-8 flex items-center gap-6"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.55 }}
            >
              {trustItems.map((item) => (
                <span
                  key={item}
                  className="flex items-center gap-1.5 text-sm text-slate-400 dark:text-white/40"
                >
                  <Check className="size-3.5 text-emerald-500 dark:text-emerald-400/80" />
                  {item}
                </span>
              ))}
            </motion.div>
          </div>

          {/* Right — Person image with rim-light glow */}
          <motion.div
            className="pointer-events-none absolute -right-16 bottom-0 hidden h-full w-[55%] lg:block"
            initial={{ x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.3, type: "spring", stiffness: 60 }}
          >
            {/* Rim-light glow behind figure */}
            <AnimatePresence mode="wait">
              <motion.div
                key={`glow-${currentRole}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeInOut" }}
                className="absolute inset-0 flex items-end justify-center"
              >
                <div
                  className={`absolute bottom-[10%] h-[70%] w-[60%] rounded-full ${roleGlowColors[currentRole]} blur-[100px]`}
                />
              </motion.div>
            </AnimatePresence>

            {/* Dynamic floating badges — change per role */}
            <AnimatePresence mode="wait">
              <motion.div
                key={`badges-${currentRole}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeInOut" }}
                className="absolute inset-0 z-30"
              >
                {roles[currentRole].badges.map((badge, bi) => {
                  const positions = [
                    "left-0 top-[22%]",
                    "right-[3%] top-[15%]",
                    "left-[-5%] bottom-[22%]",
                  ];
                  const floatConfigs = [
                    { y: [0, -10, 0], duration: 4, delay: 0 },
                    { y: [0, -7, 0], duration: 3.5, delay: 0.8 },
                    { y: [0, -12, 0], duration: 5, delay: 0.4 },
                  ];
                  const accentColors = [
                    `bg-gradient-to-r ${roleColors[currentRole]} bg-clip-text text-transparent`,
                    "text-emerald-600 dark:text-emerald-400",
                    "text-cyan-600 dark:text-cyan-400",
                  ];
                  return (
                    <motion.div
                      key={bi}
                      className={`absolute ${positions[bi]}`}
                      initial={{ opacity: 0, scale: 0.8, y: 10 }}
                      animate={{
                        opacity: 1,
                        scale: 1,
                        y: floatConfigs[bi].y,
                      }}
                      transition={{
                        opacity: { duration: 0.3, delay: bi * 0.12 },
                        scale: { duration: 0.3, delay: bi * 0.12 },
                        y: {
                          duration: floatConfigs[bi].duration,
                          repeat: Infinity,
                          ease: "easeInOut",
                          delay: floatConfigs[bi].delay,
                        },
                      }}
                    >
                      <div className="rounded-2xl border border-slate-200/60 bg-white/70 px-4 py-3 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06] dark:shadow-none">
                        <div className={`text-xl font-black sm:text-2xl ${accentColors[bi]}`}>
                          {badge.value}
                        </div>
                        <div className="text-[10px] font-medium text-slate-400 sm:text-xs dark:text-white/40">
                          {badge.label}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            </AnimatePresence>

            {/* Person image */}
            <AnimatePresence mode="wait">
              <motion.div
                key={currentRole}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.6, ease: "easeInOut" }}
                className="relative h-full w-full"
              >
                <Image
                  src={roleImages[currentRole]}
                  alt={roles[currentRole].text}
                  fill
                  priority={currentRole === 0}
                  className="object-contain object-bottom"
                  sizes="(min-width: 1024px) 55vw, 0"
                />
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>

        {/* ══ FUTURISTIC LIVE STATS BAR ══ */}
        <motion.div
          className="relative z-20 mx-auto mt-12 w-full max-w-3xl"
          initial={{ y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.8 }}
        >
          <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-2xl dark:border-white/[0.08] dark:bg-slate-900/70 sm:rounded-3xl">
            {/* Neon top border glow */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />

            {/* Scan-line sweep animation */}
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background: "linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.08) 50%, transparent 100%)",
                animation: "scanSweep 4s ease-in-out infinite",
              }}
            />

            {/* Header — pulsing live dot */}
            <div className="flex items-center justify-center gap-2 px-4 py-2">
              <motion.div
                className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                animate={{ scale: [1, 1.5, 1], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400/60">
                Live Stats
              </span>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-4 divide-x divide-slate-200 dark:divide-white/[0.06]">
              {t.wallOfFame.stats.map((stat, i) => (
                <motion.div
                  key={i}
                  className="group relative px-3 py-4 text-center sm:px-5 sm:py-5"
                  initial={{ y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.9 + i * 0.12 }}
                >
                  {/* Hover glow */}
                  <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                    <div className="absolute inset-x-0 bottom-0 h-full bg-gradient-to-t from-cyan-500/[0.04] to-transparent" />
                  </div>

                  <div
                    className="relative text-lg font-black tracking-tight text-slate-900 sm:text-2xl lg:text-3xl dark:text-white"
                    style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                  >
                    <span className="bg-gradient-to-b from-slate-900 to-slate-600 bg-clip-text text-transparent dark:from-white dark:to-white/60">
                      <CountUp value={stat.value} delay={0.9 + i * 0.15} />
                    </span>
                  </div>
                  <div className="relative mt-0.5 text-[10px] font-medium text-slate-500 sm:text-xs dark:text-white/30">
                    {stat.label}
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Neon bottom border glow */}
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent" />
          </div>
        </motion.div>

      </div>

      {/* Scan-line keyframe */}
      <style>{`
        @keyframes scanSweep {
          0%, 100% { transform: translateX(-100%); }
          50% { transform: translateX(100%); }
        }
      `}</style>

      {/* Bottom fade */}
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-slate-50 to-transparent dark:from-[#030014]" />

    </section>
  );
}
