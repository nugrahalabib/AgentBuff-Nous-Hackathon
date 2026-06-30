"use client";

import { motion } from "framer-motion";
import {
  Sparkles,
  PenLine,
  Bot,
  CheckCircle2,
  Search,
  FileText,
  Megaphone,
  Mail,
  Lightbulb,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskPrefill } from "./task-templates";

type Template = {
  icon: typeof Search;
  accent: string;
  glow: string;
  title: string;
  desc: string;
  prefill: TaskPrefill;
};

const TEMPLATES: Template[] = [
  {
    icon: Search,
    accent: "text-cyan-300",
    glow: "from-cyan-400/30 to-cyan-400/0 group-hover/t:border-cyan-400/40",
    title: "Riset kilat",
    desc: "Cari tren terbaru & rangkum poin pentingnya",
    prefill: {
      title: "Riset tren terbaru di bidang [topik] minggu ini",
      body: "Cari 5 tren/insight paling penting, ringkas tiap poin 1-2 kalimat, dan sebutkan sumbernya.",
      priority: 1,
    },
  },
  {
    icon: Megaphone,
    accent: "text-fuchsia-300",
    glow: "from-fuchsia-400/30 to-fuchsia-400/0 group-hover/t:border-fuchsia-400/40",
    title: "Bikin konten",
    desc: "Ide caption / script promo siap pakai",
    prefill: {
      title: "Buat 3 ide caption Instagram untuk promo [produk]",
      body: "Gaya santai, ada hook di kalimat pertama, sertakan CTA dan 5 hashtag relevan per caption.",
      priority: 1,
    },
  },
  {
    icon: FileText,
    accent: "text-indigo-300",
    glow: "from-indigo-400/30 to-indigo-400/0 group-hover/t:border-indigo-400/40",
    title: "Rangkum & rapikan",
    desc: "Ubah teks panjang jadi poin singkat",
    prefill: {
      title: "Rangkum dokumen/teks ini jadi poin-poin singkat",
      body: "Tempel teksnya di sini. Minta: ringkasan 5-7 bullet + 1 paragraf kesimpulan.",
    },
  },
  {
    icon: Mail,
    accent: "text-emerald-300",
    glow: "from-emerald-400/30 to-emerald-400/0 group-hover/t:border-emerald-400/40",
    title: "Susun balasan",
    desc: "Draft email / chat yang rapi & sopan",
    prefill: {
      title: "Susun draft balasan untuk pesan ini",
      body: "Tempel pesan aslinya. Minta nada profesional tapi ramah, maksimal 1 paragraf.",
    },
  },
  {
    icon: Lightbulb,
    accent: "text-amber-300",
    glow: "from-amber-400/30 to-amber-400/0 group-hover/t:border-amber-400/40",
    title: "Cari peluang",
    desc: "Ide & langkah aksi untuk bisnismu",
    prefill: {
      title: "Carikan ide peluang & langkah aksi untuk [bisnis]",
      body: "Kasih 5 ide konkret + langkah pertama yang bisa langsung dikerjakan minggu ini.",
      priority: 2,
    },
  },
  {
    icon: Sparkles,
    accent: "text-white",
    glow: "from-white/20 to-white/0 group-hover/t:border-white/30",
    title: "Tugas bebas",
    desc: "Tulis sendiri apa pun yang kamu mau",
    prefill: {},
  },
];

const STEPS = [
  { icon: PenLine, label: "Kamu antre tugas", tone: "text-cyan-300", ring: "border-cyan-400/30 bg-cyan-400/10" },
  { icon: Bot, label: "Agen mengambil & kerjakan", tone: "text-emerald-300", ring: "border-emerald-400/30 bg-emerald-400/10" },
  { icon: CheckCircle2, label: "Selesai otomatis", tone: "text-fuchsia-300", ring: "border-fuchsia-400/30 bg-fuchsia-400/10" },
];

export function KanbanEmpty({
  onTemplate,
  onBlank,
}: {
  onTemplate: (prefill: TaskPrefill) => void;
  onBlank: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-10">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center text-center"
        >
          <div className="relative mb-5 flex size-16 items-center justify-center">
            <div className="absolute inset-0 animate-pulse rounded-2xl bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 opacity-50 blur-xl" />
            <div className="relative flex size-16 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_30px_-6px_rgba(99,102,241,0.6)]">
              <Sparkles className="size-7" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-white/95 sm:text-3xl">
            Delegasikan, lalu{" "}
            <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">
              tinggal pantau
            </span>
          </h2>
          <p className="mt-2 max-w-xl text-sm text-white/55">
            Tulis apa yang mau dikerjakan, agenmu yang ambil dan menuntaskannya
            otomatis. Mulai dari satu template di bawah — sekali klik langsung jalan.
          </p>
        </motion.div>

        {/* How it works */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.4 }}
          className="mt-7 flex flex-wrap items-center justify-center gap-2"
        >
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
                <span className={cn("flex size-6 items-center justify-center rounded-full border", s.ring)}>
                  <s.icon className={cn("size-3.5", s.tone)} />
                </span>
                <span className="text-xs font-medium text-white/70">{s.label}</span>
              </div>
              {i < STEPS.length - 1 ? (
                <ArrowRight className="size-3.5 text-white/25" />
              ) : null}
            </div>
          ))}
        </motion.div>

        {/* Templates */}
        <div className="mt-8 w-full">
          <p className="mb-3 text-center font-mono text-[10px] uppercase tracking-[0.24em] text-white/40">
            Pilih template untuk mulai
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TEMPLATES.map((tpl, i) => (
              <motion.button
                key={tpl.title}
                type="button"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.05, duration: 0.3 }}
                onClick={() => onTemplate(tpl.prefill)}
                className="group/t relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 text-left transition hover:bg-white/[0.05]"
              >
                <div className={cn("pointer-events-none absolute -right-6 -top-6 size-24 rounded-full bg-gradient-to-br opacity-40 blur-2xl transition-opacity group-hover/t:opacity-70", tpl.glow)} />
                <div className="relative">
                  <div className="mb-2.5 flex size-9 items-center justify-center rounded-xl border border-white/10 bg-[#0B0E14]/60">
                    <tpl.icon className={cn("size-4.5", tpl.accent)} />
                  </div>
                  <p className="text-sm font-semibold text-white/90">{tpl.title}</p>
                  <p className="mt-0.5 text-xs leading-snug text-white/50">{tpl.desc}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-cyan-300/80 opacity-0 transition group-hover/t:opacity-100">
                    Pakai template <ArrowRight className="size-3" />
                  </span>
                </div>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Blank CTA */}
        <button
          type="button"
          onClick={onBlank}
          className="mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/75 transition hover:border-cyan-400/40 hover:bg-white/[0.06]"
        >
          <PenLine className="size-4 text-cyan-300" />
          Atau tulis tugas dari nol
        </button>
      </div>
    </div>
  );
}
