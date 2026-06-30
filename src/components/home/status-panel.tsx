"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useI18n } from "@/lib/i18n/context";

/* ═══════════════════════════════════════════════════
   SVG ICONS — Visceral Chaos & Triumph
   ═══════════════════════════════════════════════════ */

/* ── Cracked Hourglass (50% Waktu Terbuang) ── */
function CrackedHourglass() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <motion.div
        animate={{ rotate: [0, 5, -3, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
          <path
            d="M20 8h40v4c0 12-14 20-14 28s14 16 14 28v4H20v-4c0-12 14-16 14-28S20 24 20 12V8z"
            stroke="url(#hourGrad)" strokeWidth="2.5" strokeLinecap="round"
          />
          <path d="M35 30l-3 8 5 4-4 10" stroke="#FF4444" strokeWidth="1.5" opacity="0.7" />
          <path d="M48 25l2 6-3 5 4 8" stroke="#FF6633" strokeWidth="1.2" opacity="0.5" />
          <motion.circle
            cx="40" cy="55" r="2" fill="#FF4444"
            animate={{ cy: [50, 65, 50], opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <motion.circle
            cx="37" cy="60" r="1.5" fill="#FF6633"
            animate={{ cy: [55, 68, 55], opacity: [0.8, 0.2, 0.8] }}
            transition={{ duration: 2, repeat: Infinity, delay: 0.5 }}
          />
          <defs>
            <linearGradient id="hourGrad" x1="20" y1="8" x2="60" y2="72">
              <stop offset="0%" stopColor="#FF4444" />
              <stop offset="100%" stopColor="#FF8800" />
            </linearGradient>
          </defs>
        </svg>
      </motion.div>
      <div className="absolute inset-0 rounded-full bg-red-500/10 blur-xl" />
    </div>
  );
}

/* ── Fractured Brain (30% Kreativitas Hilang) ── */
function FracturedBrain() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <motion.div
        animate={{ scale: [1, 0.97, 1.02, 1] }}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
          <path
            d="M40 12c-14 0-22 10-22 22 0 8 4 15 10 19l2 15h20l2-15c6-4 10-11 10-19 0-12-8-22-22-22z"
            stroke="url(#brainGrad)" strokeWidth="2.5" strokeLinecap="round"
          />
          <path d="M32 28c4-2 8 2 8 2s4-4 8-2" stroke="#FF4444" strokeWidth="1.5" opacity="0.6" />
          <path d="M30 38c3-1 6 2 10 1s7-3 10-1" stroke="#FF6633" strokeWidth="1.5" opacity="0.5" />
          <motion.path
            d="M40 15v12l-4 6 6 4-3 10"
            stroke="#FF4444" strokeWidth="1.5"
            animate={{ opacity: [0.4, 0.9, 0.4] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
          <path d="M48 22l-2 8 3 5" stroke="#FF6633" strokeWidth="1" opacity="0.5" />
          <motion.circle
            cx="35" cy="32" r="1.5" fill="#FF4444"
            animate={{ opacity: [0, 1, 0], scale: [0.5, 1.5, 0.5] }}
            transition={{ duration: 0.8, repeat: Infinity, delay: 0.2 }}
          />
          <motion.circle
            cx="46" cy="28" r="1" fill="#FF8800"
            animate={{ opacity: [0, 1, 0], scale: [0.5, 1.5, 0.5] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.6 }}
          />
          <defs>
            <linearGradient id="brainGrad" x1="18" y1="12" x2="62" y2="68">
              <stop offset="0%" stopColor="#FF4444" />
              <stop offset="100%" stopColor="#FF6633" />
            </linearGradient>
          </defs>
        </svg>
      </motion.div>
      <div className="absolute inset-0 rounded-full bg-orange-500/10 blur-xl" />
    </div>
  );
}

/* ── Burning Coins (20% Profit Melayang) ── */
function BurningCoins() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <motion.div
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
          <ellipse cx="35" cy="50" rx="12" ry="6" stroke="#FF8800" strokeWidth="2" opacity="0.8" />
          <ellipse cx="45" cy="45" rx="12" ry="6" stroke="#FFAA00" strokeWidth="2" opacity="0.6" />
          <text x="33" y="53" fontSize="8" fill="#FF8800" fontWeight="bold" opacity="0.8">$</text>
          <text x="43" y="48" fontSize="8" fill="#FFAA00" fontWeight="bold" opacity="0.6">$</text>
          <motion.path
            d="M30 42c2-8 5-10 8-14 3 4 4 6 6 14"
            stroke="#FF4444" strokeWidth="1.5" fill="none"
            animate={{ d: ["M30 42c2-8 5-10 8-14 3 4 4 6 6 14", "M30 42c3-10 4-12 8-16 2 5 5 8 6 16", "M30 42c2-8 5-10 8-14 3 4 4 6 6 14"] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
          <motion.path
            d="M38 38c1-6 3-8 5-10 2 3 3 5 4 10"
            stroke="#FF8800" strokeWidth="1.5" fill="none"
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 0.8, repeat: Infinity }}
          />
          <motion.circle
            cx="36" cy="25" r="1.5" fill="#666"
            animate={{ cy: [28, 15], opacity: [0.6, 0], scale: [1, 2] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <motion.circle
            cx="42" cy="22" r="1" fill="#555"
            animate={{ cy: [25, 12], opacity: [0.5, 0], scale: [1, 1.8] }}
            transition={{ duration: 2.5, repeat: Infinity, delay: 0.7 }}
          />
        </svg>
      </motion.div>
      <div className="absolute inset-0 rounded-full bg-red-600/10 blur-xl" />
    </div>
  );
}

/* ── Perfect Gears (100% Efisiensi) ── */
function PerfectGears() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
        <motion.g
          animate={{ rotate: 360 }}
          transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "30px 40px" }}
        >
          <circle cx="30" cy="40" r="10" stroke="url(#gearGrad)" strokeWidth="2" />
          {[0, 60, 120, 180, 240, 300].map((angle) => (
            <rect key={angle} x="28" y="27" width="4" height="6" rx="1" fill="url(#gearGrad)" transform={`rotate(${angle} 30 40)`} />
          ))}
        </motion.g>
        <motion.g
          animate={{ rotate: -360 }}
          transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "52px 36px" }}
        >
          <circle cx="52" cy="36" r="8" stroke="url(#gearGrad)" strokeWidth="2" />
          {[0, 72, 144, 216, 288].map((angle) => (
            <rect key={angle} x="50.5" y="25.5" width="3" height="5" rx="1" fill="url(#gearGrad)" transform={`rotate(${angle} 52 36)`} />
          ))}
        </motion.g>
        <defs>
          <linearGradient id="gearGrad" x1="0" y1="0" x2="80" y2="80">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#818CF8" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 rounded-full bg-cyan-500/10 blur-xl" />
    </div>
  );
}

/* ── Glowing Brain (100% Inspirasi) ── */
function GlowingBrain() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <motion.div
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
          <path
            d="M40 12c-14 0-22 10-22 22 0 8 4 15 10 19l2 15h20l2-15c6-4 10-11 10-19 0-12-8-22-22-22z"
            stroke="url(#brainGlow)" strokeWidth="2.5" strokeLinecap="round"
          />
          <path d="M32 28c4-2 8 2 8 2s4-4 8-2" stroke="#22D3EE" strokeWidth="1.5" opacity="0.7" />
          <path d="M30 38c3-1 6 2 10 1s7-3 10-1" stroke="#818CF8" strokeWidth="1.5" opacity="0.7" />
          <motion.circle
            cx="40" cy="30" r="3" fill="none" stroke="#22D3EE" strokeWidth="1"
            animate={{ r: [3, 12, 3], opacity: [0.8, 0, 0.8] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <defs>
            <linearGradient id="brainGlow" x1="18" y1="12" x2="62" y2="68">
              <stop offset="0%" stopColor="#22D3EE" />
              <stop offset="100%" stopColor="#A855F7" />
            </linearGradient>
          </defs>
        </svg>
      </motion.div>
      <div className="absolute inset-0 rounded-full bg-cyan-400/15 blur-xl" />
    </div>
  );
}

/* ── Digital Tapestry (One-Stop Ecosystem) ── */
function DigitalTapestry() {
  return (
    <div className="relative flex size-28 items-center justify-center sm:size-36">
      <svg viewBox="0 0 80 80" className="size-24 sm:size-32" fill="none">
        {[[25, 25], [55, 20], [15, 50], [45, 45], [65, 55], [35, 65]].map(([cx, cy], i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r="4"
            fill="url(#nodeGrad)"
            opacity="0.9"
            className="animate-pulse"
            style={{ animationDelay: `${i * 0.3}s` }}
          />
        ))}
        {["M25 25L55 20", "M25 25L15 50", "M25 25L45 45", "M55 20L45 45", "M55 20L65 55", "M15 50L35 65", "M45 45L65 55", "M45 45L35 65"].map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="url(#nodeGrad)"
            strokeWidth="1"
            opacity="0.4"
            className="animate-pulse"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
        <defs>
          <linearGradient id="nodeGrad" x1="0" y1="0" x2="80" y2="80">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#C084FC" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 rounded-full bg-violet-500/10 blur-xl" />
    </div>
  );
}

/* ── AgentBuff Logo Icon ── */
function LogoIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/images/logo.png"
      alt="AgentBuff"
      width={28}
      height={28}
      className={`rounded-md ${className ?? ""}`}
    />
  );
}

/* ── Parses **bold** markers into highlighted spans ── */
function HighlightedText({ text, highlightClass }: { text: string; highlightClass: string }) {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className={highlightClass}>
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════
   CHAOS CARD
   ═══════════════════════════════════════════════════ */
function ChaosCard({
  icon,
  label,
  desc,
  index,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  index: number;
}) {
  return (
    <motion.div
      className="flex flex-col items-center text-center"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 * index, ease: "easeOut" }}
    >
      {icon}
      <h3 className="mt-4 text-base font-black text-red-500 sm:text-lg dark:text-red-400">{label}</h3>
      <p className="mt-1.5 max-w-[260px] text-xs leading-relaxed text-slate-600 sm:text-sm dark:text-white/55">
        <HighlightedText text={desc} highlightClass="font-semibold text-orange-600 dark:text-orange-300/80" />
      </p>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════
   TRIUMPH CARD
   ═══════════════════════════════════════════════════ */
function TriumphCard({
  icon,
  label,
  desc,
  index,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  index: number;
}) {
  return (
    <motion.div
      className="flex flex-col items-center text-center"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 * index, ease: "easeOut" }}
    >
      {icon}
      <h3 className="mt-4 text-base font-black text-cyan-600 sm:text-lg dark:text-cyan-400">{label}</h3>
      <p className="mt-1.5 max-w-[240px] text-xs leading-relaxed text-slate-600 sm:text-sm dark:text-white/40">{desc}</p>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Toggle-driven Chaos vs Triumph
   ═══════════════════════════════════════════════════ */

const DEBUFF_DURATION = 5000;
const BUFF_DURATION = 5000;

type Phase = "debuff" | "buff";

export function HomeStatusPanel() {
  const { t } = useI18n();
  const s = t.statusPanel;

  const [phase, setPhase] = useState<Phase>("debuff");
  const [userPaused, setUserPaused] = useState(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cycleNext = useCallback(() => {
    setPhase((prev) => (prev === "debuff" ? "buff" : "debuff"));
  }, []);

  useEffect(() => {
    if (userPaused) return;
    const dur = phase === "debuff" ? DEBUFF_DURATION : BUFF_DURATION;
    const timeout = setTimeout(cycleNext, dur);
    return () => clearTimeout(timeout);
  }, [phase, userPaused, cycleNext]);

  // Clear the manual-pause resume timer on unmount so it can't fire a state
  // update after the component is gone.
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const switchTo = (target: "debuff" | "buff") => {
    setUserPaused(true);
    setPhase(target);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setUserPaused(false), 6000);
  };

  const isBuff = phase === "buff";
  const isDebuff = phase === "debuff";

  const chaosIcons = [<CrackedHourglass key="h" />, <FracturedBrain key="b" />, <BurningCoins key="c" />];
  const triumphIcons = [<PerfectGears key="g" />, <GlowingBrain key="gb" />, <DigitalTapestry key="t" />];

  return (
    <section className="relative overflow-hidden bg-slate-50 py-20 dark:bg-[#030014] sm:py-28 lg:py-32">
      {/* Grid background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ambient glow — switches with phase */}
      <AnimatePresence mode="wait">
        {isDebuff ? (
          <motion.div
            key="red-glow"
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.15 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          >
            <div className="absolute left-1/2 top-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600/30 blur-[200px]" />
            <div className="absolute right-[15%] top-[20%] h-[300px] w-[300px] rounded-full bg-orange-500/15 blur-[150px]" />
          </motion.div>
        ) : (
          <motion.div
            key="cyan-glow"
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.15 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          >
            <div className="absolute left-1/2 top-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/25 blur-[200px]" />
            <div className="absolute left-[15%] bottom-[20%] h-[300px] w-[300px] rounded-full bg-violet-500/15 blur-[150px]" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating particles */}
      <div className="pointer-events-none absolute inset-0">
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className={`absolute size-1 rounded-full ${isDebuff ? "bg-red-500/25" : "bg-cyan-400/25"}`}
            style={{
              left: `${8 + ((i * 7.1) % 84)}%`,
              top: `${12 + ((i * 8.3) % 76)}%`,
            }}
            animate={{
              y: [0, -15, 0],
              opacity: [0, 0.5, 0],
            }}
            transition={{
              duration: 2.5 + (i % 3),
              repeat: Infinity,
              delay: i * 0.3,
            }}
          />
        ))}
      </div>

      {/* ── CONTENT ── */}
      <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        {/* Dynamic headline */}
        <div className="mb-10 text-center sm:mb-12">
          <AnimatePresence mode="wait">
            {isDebuff ? (
              <motion.div
                key="headline-debuff"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.5, ease: "easeInOut" }}
              >
                <h2
                  className="text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-4xl lg:text-5xl dark:text-white"
                  style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                >
                  {s.debuffTitle}{" "}
                  <span className="bg-gradient-to-r from-red-500 to-orange-500 bg-clip-text text-transparent dark:from-red-400 dark:to-orange-400">
                    {s.debuffTitleHighlight}
                  </span>
                  <br />
                  <span className="text-slate-500 dark:text-white/50">
                    {s.debuffSubtitle}
                  </span>
                </h2>
              </motion.div>
            ) : (
              <motion.div
                key="headline-buff"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.5, ease: "easeInOut" }}
              >
                <h2
                  className="text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-4xl lg:text-5xl dark:text-white"
                  style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                >
                  {s.buffTitlePrefix}{" "}
                  <span className="bg-gradient-to-r from-cyan-500 to-indigo-500 bg-clip-text text-transparent dark:from-cyan-400 dark:to-indigo-400">
                    AgentBuff
                  </span>{" "}
                  {s.buffTitle}
                  <br />
                  <span className="text-slate-500 dark:text-white/50">
                    {s.buffSubtitle.replace("Level Up.", "")}
                    <span className="bg-gradient-to-r from-emerald-500 to-cyan-500 bg-clip-text text-transparent dark:from-emerald-400 dark:to-cyan-400">
                      Level Up.
                    </span>
                  </span>
                </h2>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Toggle tabs (exact same as before) ── */}
        <div className="mx-auto mb-10 flex w-fit items-center gap-1 rounded-full border border-slate-200 bg-white/80 p-1 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] sm:mb-14">
          <button
            type="button"
            aria-pressed={isDebuff}
            onClick={() => switchTo("debuff")}
            className={`relative rounded-full px-5 py-2 text-sm font-bold transition-all sm:px-6 ${
              isDebuff
                ? "text-red-500 dark:text-red-400"
                : "text-slate-500 hover:text-slate-700 dark:text-white/40 dark:hover:text-white/60"
            }`}
          >
            {isDebuff && (
              <motion.div
                layoutId="status-tab-bg"
                className="absolute inset-0 rounded-full border border-red-500/20 bg-red-500/15"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <span className="text-base">⚠️</span>
              {s.tabDebuff}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={isBuff}
            onClick={() => switchTo("buff")}
            className={`relative rounded-full px-5 py-2 text-sm font-bold transition-all sm:px-6 ${
              isBuff
                ? "text-cyan-600 dark:text-cyan-400"
                : "text-slate-500 hover:text-slate-700 dark:text-white/40 dark:hover:text-white/60"
            }`}
          >
            {isBuff && (
              <motion.div
                layoutId="status-tab-bg"
                className="absolute inset-0 rounded-full border border-cyan-500/20 bg-cyan-500/15"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <LogoIcon className="size-5" />
              {s.tabBuff}
            </span>
          </button>
        </div>

        {/* ── Panel area — cinematic cards ── */}
        <div className="relative mx-auto min-h-[280px] sm:min-h-[260px]">
          <AnimatePresence mode="wait">
            {isDebuff ? (
              <motion.div
                key="chaos-panel"
                className="grid grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-6"
                initial={{ opacity: 0, x: -30, filter: "blur(8px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 30, filter: "blur(4px)" }}
                transition={{ duration: 0.55, ease: "easeInOut" }}
              >
                {s.debuffStats.map((stat, i) => (
                  <ChaosCard key={i} icon={chaosIcons[i]} label={stat.label} desc={stat.desc} index={i} />
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="triumph-panel"
                className="grid grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-6"
                initial={{ opacity: 0, x: 30, filter: "blur(8px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: -30, filter: "blur(4px)" }}
                transition={{ duration: 0.55, ease: "easeInOut" }}
              >
                {s.buffStats.map((stat, i) => (
                  <TriumphCard key={i} icon={triumphIcons[i]} label={stat.label} desc={stat.desc} index={i} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Auto-play progress bar ── */}
        <div className="mx-auto mt-10 flex max-w-xs items-center justify-center gap-3 sm:mt-12">
          <div className="flex items-center gap-2">
            <div
              className={`h-1 w-8 overflow-hidden rounded-full ${
                isDebuff ? "bg-red-500/30" : "bg-slate-200 dark:bg-white/10"
              }`}
            >
              {isDebuff && !userPaused && (
                <motion.div
                  className="h-full w-full origin-left rounded-full bg-red-400"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: DEBUFF_DURATION / 1000, ease: "linear" }}
                  key={`debuff-progress-${phase}`}
                />
              )}
              {isDebuff && userPaused && (
                <div className="h-full w-full rounded-full bg-red-400" />
              )}
            </div>
            <div
              className={`h-1 w-8 overflow-hidden rounded-full ${
                isBuff ? "bg-cyan-500/30" : "bg-slate-200 dark:bg-white/10"
              }`}
            >
              {isBuff && !userPaused && (
                <motion.div
                  className="h-full w-full origin-left rounded-full bg-cyan-400"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: BUFF_DURATION / 1000, ease: "linear" }}
                  key={`buff-progress-${phase}`}
                />
              )}
              {isBuff && userPaused && (
                <div className="h-full w-full rounded-full bg-cyan-400" />
              )}
            </div>
          </div>
          {userPaused && (
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => setUserPaused(false)}
              className="text-[10px] font-semibold tracking-wider text-slate-500 transition-colors hover:text-slate-700 dark:text-white/30 dark:hover:text-white/50"
            >
              ▶ {s.autoLabel}
            </motion.button>
          )}
        </div>
      </div>
    </section>
  );
}
