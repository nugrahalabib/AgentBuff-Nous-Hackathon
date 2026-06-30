"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/* ─── Single FAQ Item ─── */
function FaqItem({
  question,
  answer,
  index,
  isOpen,
  onToggle,
}: {
  question: string;
  answer: string;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const buttonId = `faq-trigger-${index}`;
  const panelId = `faq-panel-${index}`;
  return (
    <motion.div
      className="border-b border-slate-200 last:border-b-0 dark:border-white/[0.06]"
      initial={{ y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.35, delay: index * 0.04 }}
    >
      <button
        type="button"
        id={buttonId}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
        className="group flex w-full items-center justify-between gap-4 py-5 text-left transition-colors sm:py-6"
      >
        <span className={`text-sm font-semibold transition-colors sm:text-base ${isOpen ? "text-slate-900 dark:text-white" : "text-slate-700 group-hover:text-slate-900 dark:text-white/70 dark:group-hover:text-white/90"}`}>
          {question}
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.25 }}
          className="flex-shrink-0"
        >
          <ChevronDown aria-hidden="true" className={`size-4 transition-colors ${isOpen ? "text-cyan-600 dark:text-cyan-400" : "text-slate-400 group-hover:text-slate-600 dark:text-white/25 dark:group-hover:text-white/40"}`} />
        </motion.div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm leading-relaxed text-slate-600 sm:pb-6 sm:text-sm dark:text-white/60">
              {answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Home FAQ
   ═══════════════════════════════════════════════════ */
export function HomeFaq() {
  const { t } = useI18n();
  const f = t.faq;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="relative overflow-hidden bg-white py-16 dark:bg-[#030014] sm:py-24 lg:py-28">
      {/* Grid bg */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        {/* ── Header ── */}
        <motion.div
          className="mb-10 text-center sm:mb-14"
          initial={{ y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <h2
            className="text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl"
            style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
          >
            {f.title}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-500 dark:text-white/55 sm:text-base">
            {f.subtitle}
          </p>
        </motion.div>

        {/* ── FAQ List ── */}
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-1 backdrop-blur-sm dark:border-white/[0.06] dark:bg-white/[0.02] sm:rounded-3xl sm:p-2">
          <div className="px-4 sm:px-6">
            {f.items.map((item: { question: string; answer: string }, i: number) => (
              <FaqItem
                key={i}
                question={item.question}
                answer={item.answer}
                index={i}
                isOpen={openIndex === i}
                onToggle={() => setOpenIndex(openIndex === i ? null : i)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
