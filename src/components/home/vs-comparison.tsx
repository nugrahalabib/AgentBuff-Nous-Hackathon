"use client";

import { motion } from "framer-motion";
import { X, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/* ═══════════════════════════════════════════════════
   VS Comparison — Unified comparison table
   ═══════════════════════════════════════════════════ */
export function HomeVsComparison() {
  const { t } = useI18n();
  const v = t.vsComparison;

  return (
    <section
      id="vs-comparison"
      className="relative overflow-hidden bg-white py-16 dark:bg-[#030014] sm:py-24 lg:py-28"
    >
      {/* Cyber-grid bg */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        {/* ── Header ── */}
        <motion.div
          className="mb-12 text-center sm:mb-16"
          initial={{ y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <h2
            className="text-balance text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl"
            style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
          >
            {v.title}
            <br />
            <span className="bg-gradient-to-r from-orange-400 via-red-400 to-cyan-400 bg-clip-text text-transparent">
              {v.titleHighlight}
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-white/55 sm:text-base">
            {v.subtitle}
          </p>
        </motion.div>

        {/* ── Unified Comparison Table ── */}
        <motion.div
          role="table"
          aria-label={v.title}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 backdrop-blur-xl shadow-[0_0_60px_-15px_rgba(6,182,212,0.12),0_0_60px_-15px_rgba(249,115,22,0.08)] dark:border-white/[0.08] dark:bg-slate-900/70 dark:shadow-[0_0_60px_-15px_rgba(6,182,212,0.08),0_0_60px_-15px_rgba(249,115,22,0.05)] sm:rounded-3xl"
          initial={{ y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          {/* Table Header */}
          <div role="row" className="grid grid-cols-[1fr_1fr]">
            {/* Left header — OpenClaw */}
            <div role="columnheader" className="flex items-center justify-center gap-2 border-b border-r border-slate-200 bg-red-500/10 px-4 py-4 dark:border-white/[0.08] dark:bg-red-500/[0.06] sm:px-6 sm:py-5">
              <X className="size-4 text-red-500 dark:text-red-400" aria-hidden="true" />
              <span className="text-xs font-bold uppercase tracking-wider text-red-600 sm:text-sm dark:text-red-400">
                {v.leftLabel}
              </span>
            </div>
            {/* Right header — AgentBuff */}
            <div role="columnheader" className="flex items-center justify-center gap-2 border-b border-slate-200 bg-cyan-500/10 px-4 py-4 dark:border-white/[0.08] dark:bg-cyan-500/[0.06] sm:px-6 sm:py-5">
              <Check className="size-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
              <span className="text-xs font-bold uppercase tracking-wider text-cyan-600 sm:text-sm dark:text-cyan-400">
                {v.rightLabel}
              </span>
            </div>
          </div>

          {/* Table Rows */}
          {v.rows.map((row: { category: string; left: string; right: string }, i: number) => (
            <div role="rowgroup" key={i}>
              {/* Category bar */}
              <div role="row" className="border-b border-slate-200 bg-slate-50 px-5 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.03] sm:px-8 sm:py-3">
                <span role="rowheader" aria-colspan={2} className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-500 sm:text-xs dark:text-white/30">
                  {row.category}
                </span>
              </div>

              {/* Content row */}
              <div
                role="row"
                className={`grid grid-cols-[1fr_1fr] ${
                  i < v.rows.length - 1 ? "border-b border-slate-200 dark:border-white/[0.06]" : ""
                }`}
              >
                {/* Left cell — OpenClaw */}
                <div role="cell" className="flex items-start gap-2 border-r border-slate-200 bg-red-500/[0.03] px-3.5 py-4 dark:border-white/[0.08] dark:bg-red-500/[0.02] sm:gap-3 sm:px-8 sm:py-5">
                  <X className="mt-0.5 size-4 flex-shrink-0 text-red-500/70 dark:text-red-400/60" aria-hidden="true" />
                  <p className="text-xs leading-relaxed text-slate-600 sm:text-sm dark:text-white/40">{row.left}</p>
                </div>

                {/* Right cell — AgentBuff */}
                <div role="cell" className="flex items-start gap-2 bg-cyan-500/[0.03] px-3.5 py-4 dark:bg-cyan-500/[0.02] sm:gap-3 sm:px-8 sm:py-5">
                  <Check className="mt-0.5 size-4 flex-shrink-0 text-cyan-600 drop-shadow-[0_0_6px_rgba(6,182,212,0.5)] dark:text-cyan-400" aria-hidden="true" />
                  <p className="text-xs leading-relaxed text-slate-700 sm:text-sm dark:text-white/60">{row.right}</p>
                </div>
              </div>
            </div>
          ))}
        </motion.div>

        {/* ── Conclusion ── */}
        <motion.p
          className="mx-auto mt-10 max-w-3xl text-center text-sm italic leading-relaxed text-slate-500 sm:mt-14 sm:text-base dark:text-white/55"
          initial={{ y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4 }}
        >
          &ldquo;{v.conclusion}&rdquo;
        </motion.p>
      </div>
    </section>
  );
}
