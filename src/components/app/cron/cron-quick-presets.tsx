"use client";

/**
 * CronQuickPresets — 6 visual preset cards untuk fast-path bikin rutinitas.
 * Klik kartu → open CreateWizard pre-filled dengan preset itu.
 *
 * Layout:
 *  - Kalau zero job: prominent, full-width, headline besar
 *  - Kalau ada job: collapsible accordion ("Bikin rutinitas baru"),
 *    presets compact dalam 3-col grid
 */
import { motion } from "framer-motion";
import { ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { QUICK_PRESETS, type QuickPreset } from "./helpers";

export function CronQuickPresets({
  prominent,
  onSelect,
  onCustom,
}: {
  prominent: boolean;
  onSelect: (preset: QuickPreset) => void;
  onCustom: () => void;
}) {
  const [open, setOpen] = useState(prominent);

  if (!prominent) {
    return (
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-white/[0.02]"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-fuchsia-300" aria-hidden />
            <h2 className="text-sm font-semibold text-white/90">
              Bikin rutinitas baru
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
              · 6 preset siap pakai
            </span>
          </div>
          <ChevronDown
            className={cn(
              "size-4 text-white/55 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {open ? (
          <div className="border-t border-white/[0.04] p-4">
            <PresetGrid onSelect={onSelect} onCustom={onCustom} compact />
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/[0.05] via-[#0B0E14]/40 to-fuchsia-500/[0.03] p-6 backdrop-blur-xl"
    >
      <header className="mb-1 flex items-center gap-2">
        <Sparkles className="size-4 text-cyan-300" aria-hidden />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
          ✦ Mulai cepat
        </span>
      </header>
      <h2 className="font-display text-xl font-bold leading-tight text-white">
        Pilih satu, AI ngerjain sendiri tiap waktu.
      </h2>
      <p className="mt-1 text-[13px] text-white/65">
        Set sekali → AI auto-lari sesuai jadwal. Bisa kamu pause kapan aja.
      </p>
      <div className="mt-4">
        <PresetGrid onSelect={onSelect} onCustom={onCustom} compact={false} />
      </div>
    </motion.section>
  );
}

function PresetGrid({
  onSelect,
  onCustom,
  compact,
}: {
  onSelect: (preset: QuickPreset) => void;
  onCustom: () => void;
  compact: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        compact
          ? "grid-cols-2 lg:grid-cols-4"
          : "grid-cols-2 md:grid-cols-3",
      )}
    >
      {QUICK_PRESETS.map((preset) => (
        <PresetCard key={preset.id} preset={preset} onClick={() => onSelect(preset)} />
      ))}
      <button
        type="button"
        onClick={onCustom}
        className="group flex flex-col items-start gap-1 rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-3 text-left transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.04]"
      >
        <div className="text-xl">⚙️</div>
        <div className="text-[12px] font-semibold text-white/85 group-hover:text-cyan-100">
          Custom (advanced)
        </div>
        <p className="text-[10px] leading-snug text-white/55">
          Cron expression, webhook, timeout, dst.
        </p>
      </button>
    </div>
  );
}

function PresetCard({
  preset,
  onClick,
}: {
  preset: QuickPreset;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.06] hover:shadow-[0_8px_24px_-12px_rgba(34,211,238,0.4)]"
    >
      <div className="text-xl">{preset.emoji}</div>
      <div className="text-[12px] font-semibold text-white/90 group-hover:text-cyan-100">
        {preset.title}
      </div>
      <p className="text-[10px] leading-snug text-white/55">
        {preset.description}
      </p>
    </button>
  );
}
