import { Search, FileText, Megaphone, Mail, Lightbulb, Sparkles, type LucideIcon } from "lucide-react";

export type TaskPrefill = {
  title?: string;
  body?: string;
  priority?: number;
};

export type TaskTemplate = {
  id: string;
  icon: LucideIcon;
  accent: string;
  glow: string;
  title: string;
  desc: string;
  prefill: TaskPrefill;
};

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "riset",
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
    id: "konten",
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
    id: "rangkum",
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
    id: "balasan",
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
    id: "peluang",
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
    id: "bebas",
    icon: Sparkles,
    accent: "text-white",
    glow: "from-white/20 to-white/0 group-hover/t:border-white/30",
    title: "Tugas bebas",
    desc: "Tulis sendiri apa pun yang kamu mau",
    prefill: {},
  },
];

/** Detect [placeholder] tokens the user must replace before creating. */
export function findPlaceholders(...texts: (string | undefined | null)[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) found.add(m[0]);
  }
  return Array.from(found);
}
