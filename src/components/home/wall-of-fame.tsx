"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import {
  Trophy,
  Star,
  Shield,
  ChevronLeft,
  ChevronRight,
  Swords,
  Zap,
  ArrowRight,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/* ═══════════════════════════════════════════════════
   CARD VISUAL CONFIG — rank, colors, glow per card
   ═══════════════════════════════════════════════════ */
const CARD_STYLES = [
  {
    rank: "A+",
    border: "border-amber-500/25",
    hoverBorder: "hover:border-amber-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(245,158,11,0.2)]",
    accentBg: "bg-amber-500/15",
    accentText: "text-amber-500 dark:text-amber-400",
    rankBg: "bg-gradient-to-br from-amber-500/30 to-amber-600/20",
    rankBorder: "border-amber-500/30",
    rankText: "text-amber-400",
    neonLine: "from-amber-500/30 via-amber-500/10 to-transparent",
    metricBg: "bg-amber-500/10",
    metricBorder: "border-amber-500/20",
  },
  {
    rank: "S+",
    border: "border-violet-500/25",
    hoverBorder: "hover:border-violet-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(139,92,246,0.2)]",
    accentBg: "bg-violet-500/15",
    accentText: "text-violet-500 dark:text-violet-400",
    rankBg: "bg-gradient-to-br from-violet-500/30 to-violet-600/20",
    rankBorder: "border-violet-500/30",
    rankText: "text-violet-400",
    neonLine: "from-violet-500/30 via-violet-500/10 to-transparent",
    metricBg: "bg-violet-500/10",
    metricBorder: "border-violet-500/20",
  },
  {
    rank: "S",
    border: "border-cyan-500/25",
    hoverBorder: "hover:border-cyan-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(6,182,212,0.2)]",
    accentBg: "bg-cyan-500/15",
    accentText: "text-cyan-500 dark:text-cyan-400",
    rankBg: "bg-gradient-to-br from-cyan-500/30 to-cyan-600/20",
    rankBorder: "border-cyan-500/30",
    rankText: "text-cyan-400",
    neonLine: "from-cyan-500/30 via-cyan-500/10 to-transparent",
    metricBg: "bg-cyan-500/10",
    metricBorder: "border-cyan-500/20",
  },
  {
    rank: "S+",
    border: "border-emerald-500/25",
    hoverBorder: "hover:border-emerald-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(16,185,129,0.2)]",
    accentBg: "bg-emerald-500/15",
    accentText: "text-emerald-500 dark:text-emerald-400",
    rankBg: "bg-gradient-to-br from-emerald-500/30 to-emerald-600/20",
    rankBorder: "border-emerald-500/30",
    rankText: "text-emerald-400",
    neonLine: "from-emerald-500/30 via-emerald-500/10 to-transparent",
    metricBg: "bg-emerald-500/10",
    metricBorder: "border-emerald-500/20",
  },
  {
    rank: "S+",
    border: "border-rose-500/25",
    hoverBorder: "hover:border-rose-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(244,63,94,0.2)]",
    accentBg: "bg-rose-500/15",
    accentText: "text-rose-500 dark:text-rose-400",
    rankBg: "bg-gradient-to-br from-rose-500/30 to-rose-600/20",
    rankBorder: "border-rose-500/30",
    rankText: "text-rose-400",
    neonLine: "from-rose-500/30 via-rose-500/10 to-transparent",
    metricBg: "bg-rose-500/10",
    metricBorder: "border-rose-500/20",
  },
  {
    rank: "A+",
    border: "border-indigo-500/25",
    hoverBorder: "hover:border-indigo-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(99,102,241,0.2)]",
    accentBg: "bg-indigo-500/15",
    accentText: "text-indigo-500 dark:text-indigo-400",
    rankBg: "bg-gradient-to-br from-indigo-500/30 to-indigo-600/20",
    rankBorder: "border-indigo-500/30",
    rankText: "text-indigo-400",
    neonLine: "from-indigo-500/30 via-indigo-500/10 to-transparent",
    metricBg: "bg-indigo-500/10",
    metricBorder: "border-indigo-500/20",
  },
  {
    rank: "S",
    border: "border-orange-500/25",
    hoverBorder: "hover:border-orange-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(249,115,22,0.2)]",
    accentBg: "bg-orange-500/15",
    accentText: "text-orange-500 dark:text-orange-400",
    rankBg: "bg-gradient-to-br from-orange-500/30 to-orange-600/20",
    rankBorder: "border-orange-500/30",
    rankText: "text-orange-400",
    neonLine: "from-orange-500/30 via-orange-500/10 to-transparent",
    metricBg: "bg-orange-500/10",
    metricBorder: "border-orange-500/20",
  },
  {
    rank: "A+",
    border: "border-pink-500/25",
    hoverBorder: "hover:border-pink-500/40",
    glow: "hover:shadow-[0_0_40px_-8px_rgba(236,72,153,0.2)]",
    accentBg: "bg-pink-500/15",
    accentText: "text-pink-500 dark:text-pink-400",
    rankBg: "bg-gradient-to-br from-pink-500/30 to-pink-600/20",
    rankBorder: "border-pink-500/30",
    rankText: "text-pink-400",
    neonLine: "from-pink-500/30 via-pink-500/10 to-transparent",
    metricBg: "bg-pink-500/10",
    metricBorder: "border-pink-500/20",
  },
];

/* ─── Gold 3D Stars ─── */
function GoldStars({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`size-3.5 ${
            i < count
              ? "fill-amber-400 text-amber-400 drop-shadow-[0_0_3px_rgba(251,191,36,0.5)]"
              : "fill-slate-300/20 text-slate-300/20 dark:fill-white/8 dark:text-white/8"
          }`}
        />
      ))}
      <span className="ml-1 text-[11px] font-bold text-amber-400/70">
        {count}.0
      </span>
    </div>
  );
}

/* ─── Rank Badge (Diamond/Shield shape) ─── */
function RankBadge({
  rank,
  style,
}: {
  rank: string;
  style: (typeof CARD_STYLES)[number];
}) {
  const isS = rank.startsWith("S");
  return (
    <div className="relative">
      <div
        className={`flex size-11 items-center justify-center rounded-xl border backdrop-blur-md ${style.rankBg} ${style.rankBorder}`}
      >
        <span
          className={`text-sm font-black tracking-tight ${style.rankText}`}
          style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
        >
          {rank}
        </span>
      </div>
      {/* Glow behind rank for S+ ranks */}
      {isS && (
        <div
          className={`absolute inset-0 -z-10 rounded-xl ${style.rankBg} blur-md opacity-60`}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   ACHIEVEMENT CARD — Gaming "Level Up Report" style
   ═══════════════════════════════════════════════════ */
function AchievementCard({
  review,
  style,
  index,
  isMobile = false,
}: {
  review: {
    name: string;
    role: string;
    quote: string;
    rating: number;
    buff: string;
    metric: string;
    metricLabel: string;
  };
  style: (typeof CARD_STYLES)[number];
  index: number;
  isMobile?: boolean;
}) {
  const initials = review.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);

  return (
    <motion.div
      className={`group ${isMobile ? "w-[300px] shrink-0 sm:w-[320px]" : "break-inside-avoid mb-5 lg:mb-6"}`}
      initial={{ y: 25 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.45, delay: index * 0.07 }}
    >
      <div
        className={`relative overflow-hidden rounded-2xl border bg-white/60 backdrop-blur-xl transition-all duration-300 dark:bg-white/[0.03] ${style.border} ${style.hoverBorder} ${style.glow} hover:-translate-y-1`}
      >
        {/* ── Subtle top neon line ── */}
        <div className={`h-px bg-gradient-to-r ${style.neonLine}`} />

        {/* ── Inner grid noise texture ── */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.02] dark:opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.15) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.15) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />

        <div className="relative p-5 sm:p-6">
          {/* ── Top: Player Info + Decorative Quote Mark ── */}
          <div className="flex items-start gap-3">
            <div
              className={`flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-black ${style.accentBg} ${style.accentText}`}
            >
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-900 dark:text-white">
                {review.name}
              </div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">
                {review.role}
              </div>
            </div>
            {/* Decorative quote mark */}
            <span
              className={`shrink-0 text-3xl font-black leading-none ${style.accentText} opacity-20`}
              style={{ fontFamily: "Georgia, serif" }}
            >
              &ldquo;
            </span>
          </div>

          {/* ── Stars ── */}
          <div className="mt-3">
            <GoldStars count={review.rating} />
          </div>

          {/* ── Quote ── */}
          <p className="mt-3 text-[13px] leading-relaxed text-slate-600 dark:text-white/50 sm:text-sm">
            {review.quote}
          </p>

          {/* ── Gradient Divider ── */}
          <div className={`my-4 h-px bg-gradient-to-r ${style.neonLine}`} />

          {/* ── Bottom: All Badges Grouped ── */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Rank badge (compact pill) */}
            <div
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-black ${style.rankBg} ${style.rankBorder} ${style.rankText}`}
            >
              {style.rank}
            </div>

            {/* Buff equipped badge */}
            <div
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 ${style.accentBg} ${style.metricBorder}`}
            >
              <Shield className={`size-3 ${style.accentText}`} />
              <span
                className={`text-[10px] font-bold uppercase tracking-wider ${style.accentText}`}
              >
                {review.buff}
              </span>
            </div>

            {/* Buff effect stat */}
            <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/15 bg-emerald-500/[0.06] px-2.5 py-1">
              <Zap className="size-3 text-emerald-400" />
              <span className="text-[10px] font-semibold text-emerald-500 dark:text-emerald-400">
                {review.metric}
              </span>
              <span className="text-[9px] text-emerald-500/50 dark:text-emerald-400/40">
                {review.metricLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Animated Stat Counter ─── */
function StatItem({
  value,
  label,
  index,
}: {
  value: string;
  label: string;
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-50px" });

  return (
    <motion.div
      ref={ref}
      className="text-center px-2"
      initial={{ y: 20, scale: 0.95 }}
      animate={inView ? { opacity: 1, y: 0, scale: 1 } : {}}
      transition={{ duration: 0.5, delay: 0.1 + index * 0.1 }}
    >
      <div
        className="text-2xl font-black tracking-tight text-slate-900 dark:text-white sm:text-3xl lg:text-4xl"
        style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] font-medium text-slate-500 dark:text-white/35 sm:text-sm">
        {label}
      </div>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Wall of Fame / Achievement Board
   ═══════════════════════════════════════════════════ */
export function HomeWallOfFame() {
  const { t } = useI18n();
  const s = t.wallOfFame;
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: "left" | "right") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({
      left: dir === "left" ? -330 : 330,
      behavior: "smooth",
    });
  };

  return (
    <section className="relative overflow-hidden bg-slate-50 py-20 dark:bg-[#030014] sm:py-28 lg:py-32">
      {/* Grid background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ambient glows */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[10%] top-[20%] h-[500px] w-[600px] rounded-full bg-amber-400/6 blur-[180px] dark:bg-amber-600/8" />
        <div className="absolute bottom-[10%] right-[15%] h-[400px] w-[500px] rounded-full bg-violet-400/6 blur-[160px] dark:bg-violet-600/8" />
      </div>

      {/* Ghost watermark */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <Trophy className="size-[300px] text-slate-900/[0.015] dark:text-white/[0.015] sm:size-[400px]" />
      </div>

      <div className="relative z-10">
        {/* ══ HEADER ══ */}
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div
            className="mb-14 text-center sm:mb-16"
            initial={{ y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-4 py-1.5 backdrop-blur-xl">
              <Trophy className="size-3.5 text-amber-500" />
              <span className="text-xs font-bold tracking-wider text-amber-600/70 dark:text-amber-400/70">
                {s.badge}
              </span>
            </div>
            <h2
              className="text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {s.title}
              <br />
              <span className="bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent dark:from-amber-400 dark:to-orange-400">
                {s.titleHighlight}
              </span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-white/40 sm:text-base">
              {s.subtitle}
            </p>
          </motion.div>
        </div>

        {/* ══ DESKTOP: Masonry Grid ══ */}
        <div className="relative mx-auto hidden max-w-7xl px-4 sm:px-6 md:block lg:px-8">
          <div className="columns-2 gap-5 lg:columns-3 lg:gap-6">
            {s.reviews.slice(0, 6).map((review, i) => (
              <AchievementCard
                key={i}
                review={review}
                style={CARD_STYLES[i % CARD_STYLES.length]}
                index={i}
              />
            ))}
          </div>
        </div>

        {/* ══ MOBILE: Horizontal Carousel ══ */}
        <div className="relative md:hidden">
          {/* Fade edges */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-slate-50 to-transparent dark:from-[#030014]" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-slate-50 to-transparent dark:from-[#030014]" />

          {/* Scrollable cards */}
          <div
            ref={scrollRef}
            className="no-scrollbar flex gap-4 overflow-x-auto px-6 py-2"
            style={{ scrollSnapType: "x mandatory" }}
          >
            {s.reviews.slice(0, 6).map((review, i) => (
              <div key={i} style={{ scrollSnapAlign: "center" }}>
                <AchievementCard
                  review={review}
                  style={CARD_STYLES[i % CARD_STYLES.length]}
                  index={i}
                  isMobile
                />
              </div>
            ))}
          </div>

          {/* Mobile navigation dots */}
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              aria-label="Geser ke testimoni sebelumnya"
              onClick={() => scroll("left")}
              className="flex size-9 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-500 shadow-sm backdrop-blur-md transition-all hover:bg-white hover:shadow-md dark:border-white/10 dark:bg-white/[0.06] dark:text-white/50 dark:hover:bg-white/[0.12]"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Geser ke testimoni berikutnya"
              onClick={() => scroll("right")}
              className="flex size-9 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-500 shadow-sm backdrop-blur-md transition-all hover:bg-white hover:shadow-md dark:border-white/10 dark:bg-white/[0.06] dark:text-white/50 dark:hover:bg-white/[0.12]"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* ══ SHOW MORE BUTTON ══ */}
        <motion.div
          className="mt-10 flex justify-center sm:mt-12"
          initial={{ y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <Link
            href="/register"
            className="group inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/60 px-8 py-3.5 text-sm font-medium text-slate-600 backdrop-blur-xl transition-all duration-300 hover:border-amber-400/40 hover:bg-amber-500/[0.06] hover:text-amber-600 hover:shadow-[0_0_30px_-5px_rgba(245,158,11,0.15)] dark:border-white/10 dark:bg-white/[0.04] dark:text-white/70 dark:hover:border-amber-400/30 dark:hover:bg-amber-400/[0.08] dark:hover:text-amber-400"
          >
            {s.ctaMore}
            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
