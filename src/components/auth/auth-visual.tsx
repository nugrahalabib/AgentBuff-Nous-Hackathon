"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Clock, Zap, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// NOTE: do not use lucide's `Infinity` icon here — it shadows the global
// `Infinity` used by framer-motion `repeat: Infinity` in this file.
const perkIcons = [Zap, Clock, ShieldCheck];

const CHIP_POSITIONS = [
  "top-[12%] right-[4%] sm:right-[8%]",
  "top-[46%] left-[0%] sm:left-[2%]",
  "bottom-[18%] right-[10%] sm:right-[14%]",
];

export function AuthVisual() {
  const { t } = useI18n();
  const pathname = usePathname();
  const isLogin = pathname?.includes("/login");

  const badge = isLogin ? t.auth.badgeLogin : t.auth.badge;
  const caption = isLogin ? t.auth.mascotCaptionLogin : t.auth.mascotCaption;
  const subCaption = isLogin
    ? t.auth.mascotSubCaptionLogin
    : t.auth.mascotSubCaption;
  const chips = isLogin ? t.auth.chipsLogin : t.auth.chips;
  const mascotSrc = isLogin
    ? "/images/roles/creator.webp"
    : "/images/roles/assistant.webp";

  return (
    <div className="relative flex h-full min-h-[520px] flex-col justify-between py-2 pr-0 sm:py-4 lg:min-h-[680px] lg:pr-4">
      {/* Top badge */}
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 flex items-center gap-2"
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
          <span className="relative inline-flex size-2 rounded-full bg-cyan-400" />
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-cyan-300/85">
          {badge}
        </span>
      </motion.div>

      {/* Mascot — dominant, borderless, bleeds into space */}
      <div className="relative z-10 flex flex-1 items-center justify-center">
        <RingPulse />

        <motion.div
          initial={{ y: 0 }}
          animate={{ y: [-10, 8, -10] }}
          transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
          className="relative"
        >
          {/* Rim glow — bleeds edge */}
          <div
            aria-hidden
            className="absolute inset-[-8%] rounded-full bg-gradient-to-br from-cyan-400/50 via-indigo-500/25 to-fuchsia-500/50 blur-[80px]"
          />

          <div className="relative size-[340px] sm:size-[420px] lg:size-[480px] xl:size-[540px]">
            <Image
              src={mascotSrc}
              alt="AgentBuff mascot"
              fill
              priority
              sizes="540px"
              className="object-contain drop-shadow-[0_20px_60px_rgba(34,211,238,0.55)]"
            />
          </div>

          {/* Floating chips */}
          {chips.map((chip, i) => (
            <FloatingChip
              key={`${chip.label}-${i}`}
              className={CHIP_POSITIONS[i]}
              delay={0.4 + i * 0.5}
              icon={chip.icon}
              label={chip.label}
            />
          ))}
        </motion.div>

        {/* Particles floating across whole area */}
        {Array.from({ length: 18 }).map((_, i) => (
          <Particle key={i} index={i} />
        ))}
      </div>

      {/* Caption — left-aligned, borderless */}
      <div className="relative z-10 mt-4 max-w-[440px]">
        <motion.h2
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.5 }}
          className="font-display text-2xl font-bold leading-tight sm:text-3xl lg:text-[2rem]"
        >
          {caption}
        </motion.h2>
        <motion.p
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className="mt-1.5 text-sm text-white/60 sm:text-base"
        >
          {subCaption}
        </motion.p>
      </div>

      {/* Perks row — left-aligned, 3 small floating cards */}
      <div className="relative z-10 mt-5 grid grid-cols-3 gap-2.5 sm:gap-3">
        {t.auth.perks.map((perk, i) => {
          const Icon = perkIcons[i];
          return (
            <motion.div
              key={perk.title}
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35 + i * 0.08, duration: 0.45 }}
              className="rounded-xl border border-white/10 bg-white/[0.035] p-3 backdrop-blur-md transition-colors hover:border-cyan-400/30"
            >
              <Icon className="size-4 text-cyan-300" />
              <p className="mt-2 text-xs font-semibold leading-tight">
                {perk.title}
              </p>
              <p className="mt-1 text-[10px] leading-snug text-white/50">
                {perk.desc}
              </p>
            </motion.div>
          );
        })}
      </div>

      {/* Live stat — floating pill, left-aligned */}
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
        className="relative z-10 mt-4 inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3.5 py-1.5 text-xs font-medium text-cyan-100 backdrop-blur-md"
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
        </span>
        {t.auth.liveStat}
      </motion.div>
    </div>
  );
}

function RingPulse() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          aria-hidden
          className="absolute rounded-full border border-cyan-400/15"
          style={{
            width: 420 + i * 110,
            height: 420 + i * 110,
          }}
          animate={{
            scale: [1, 1.06, 1],
            opacity: [0.2, 0.45, 0.2],
          }}
          transition={{
            duration: 5 + i,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.7,
          }}
        />
      ))}
    </>
  );
}

function FloatingChip({
  className,
  delay = 0,
  icon,
  label,
}: {
  className?: string;
  delay?: number;
  icon: string;
  label: string;
}) {
  return (
    <motion.div
      initial={{ y: 8 }}
      animate={{ opacity: 1, y: [0, -8, 0] }}
      transition={{
        opacity: { delay, duration: 0.5 },
        y: { delay, duration: 4, repeat: Infinity, ease: "easeInOut" },
      }}
      className={`absolute flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-3 py-1.5 text-[11px] font-medium shadow-[0_8px_24px_-6px_rgba(34,211,238,0.35)] backdrop-blur-md ${className}`}
    >
      <span>{icon}</span>
      <span className="text-white/90">{label}</span>
    </motion.div>
  );
}

function Particle({ index }: { index: number }) {
  const left = (index * 73) % 100;
  const top = (index * 41) % 100;
  const duration = 5 + (index % 4);
  const delay = (index % 5) * 0.4;
  return (
    <motion.span
      aria-hidden
      className="absolute size-1 rounded-full bg-cyan-300/70"
      style={{ left: `${left}%`, top: `${top}%` }}
      animate={{
        y: [0, -24, 0],
        opacity: [0, 0.85, 0],
      }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}
