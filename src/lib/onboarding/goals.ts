// "What do you want AgentBuff to help you with?" options for the onboarding
// Quest step. These are the user's GOALS / needs (not abstract tasks), worded
// as clear "help me with X" areas so the purpose of the question is obvious.
// They map to the 8 Buff archetypes so the answer guides the recommendation.
// Bahasa labels (Indonesia-first), like the other onboarding taxonomy modules.

export interface GoalOption {
  id: string;
  icon: string;
  label: string;
  /** What the agent concretely DOES for this goal — one actionable sentence,
   *  woven into the SOUL.md "Misi" list so EVERY picked goal is represented. */
  mission: string;
  /** Show a "Coming Soon" badge and disable selection. */
  comingSoon?: boolean;
}

// Framed as the user's GOALS / outcomes (what a layperson actually wants to
// achieve to be more productive) — NOT tools. The engine's features (multi-
// channel chat, voice/image understanding, web search) are HOW it gets there
// and run automatically; the user just picks their objective. Things that need
// more than chat (website building) are marked coming-soon.
export const GOALS: readonly GoalOption[] = [
  {
    id: "kembangkan_bisnis",
    icon: "🚀",
    label: "Kembangkan bisnis",
    mission:
      "Bantu kembangkan bisnis: temukan peluang baru, perbaiki yang sudah jalan, dan susun langkah pertumbuhan.",
  },
  {
    id: "mulai_bisnis",
    icon: "💡",
    label: "Mulai bisnis baru",
    mission:
      "Bantu memulai bisnis dari nol: validasi ide, susun rencana awal, dan tentukan langkah pertama yang konkret.",
  },
  {
    id: "tingkatkan_penjualan",
    icon: "📈",
    label: "Tingkatkan penjualan",
    mission:
      "Dorong penjualan: bikin ide promo, follow-up calon pembeli, dan teknik closing yang pas.",
  },
  {
    id: "marketing_promosi",
    icon: "📣",
    label: "Kelola marketing & promosi",
    mission:
      "Kelola marketing & promosi: rencana kampanye, materi promosi, dan copy iklan yang menarik.",
  },
  {
    id: "riset_kompetitor",
    icon: "🔍",
    label: "Riset kompetitor & pasar",
    mission:
      "Riset kompetitor & pasar: pantau pesaing, baca tren, dan temukan celah peluang.",
  },
  {
    id: "rencana_strategi",
    icon: "🗺️",
    label: "Susun rencana & strategi",
    mission:
      "Susun rencana & strategi: pecah tujuan besar jadi langkah jelas yang bisa langsung dijalankan.",
  },
  {
    id: "konten_sosmed",
    icon: "📱",
    label: "Produksi konten & sosmed",
    mission:
      "Produksi konten sosmed: ide, caption + hook yang nendang, dan jadwal posting yang konsisten.",
  },
  {
    id: "layani_pelanggan",
    icon: "💬",
    label: "Layani pelanggan lebih cepat",
    mission:
      "Layani pelanggan: jawab pertanyaan dengan cepat, tangani komplain dengan tenang, jaga nada brand.",
  },
  {
    id: "asisten_chat",
    icon: "🤖",
    label: "Hadir 24/7 di WhatsApp & Telegram",
    mission:
      "Hadir 24/7 di WhatsApp & Telegram: balas chat masuk dengan ramah dan responsif.",
  },
  {
    id: "tulis_konten",
    icon: "✍️",
    label: "Tulis artikel, caption & email",
    mission:
      "Tulis artikel, caption & email: tulisan berkarakter yang sesuai target pembaca.",
  },
  {
    id: "dokumen",
    icon: "📄",
    label: "Susun & rapikan dokumen",
    mission:
      "Susun & rapikan dokumen: ringkas, format, dan poles jadi rapi serta enak dibaca.",
  },
  {
    id: "keuangan",
    icon: "💰",
    label: "Kelola keuangan & pembukuan",
    mission:
      "Kelola keuangan & pembukuan: catat arus kas, susun budget, dan rapikan laporan sederhana.",
  },
  {
    id: "analisis_data",
    icon: "📊",
    label: "Analisis data untuk keputusan",
    mission:
      "Analisis data: rapikan angka, cari pola, dan ubah jadi kesimpulan yang bisa ditindaklanjuti.",
  },
  {
    id: "produktivitas",
    icon: "⏰",
    label: "Tingkatkan produktivitas",
    mission:
      "Tingkatkan produktivitas: atur prioritas, ingatkan tugas, dan bantu fokus ke yang penting.",
  },
  {
    id: "belajar",
    icon: "📚",
    label: "Pelajari skill & ilmu baru",
    mission:
      "Temani belajar: jelaskan materi sulit dengan analogi sederhana, buat rangkuman, dan susun latihan.",
  },
  {
    id: "ide_solusi",
    icon: "🧠",
    label: "Temukan ide & solusi",
    mission:
      "Bantu cari ide & solusi: brainstorm, kasih sudut pandang baru, dan bedah masalah sampai ketemu jalan keluar.",
  },
  {
    id: "bahasa",
    icon: "🌐",
    label: "Komunikasi lintas bahasa",
    mission:
      "Bantu komunikasi lintas bahasa: terjemahkan dan susun pesan yang pas konteks dan sopan.",
  },
  {
    id: "companion",
    icon: "🫂",
    label: "Teman diskusi & motivasi",
    mission:
      "Jadi teman diskusi & penyemangat: dengerin cerita, kasih masukan, dan semangati saat lagi butuh.",
  },
  {
    id: "operasional",
    icon: "⚙️",
    label: "Kelola operasional & admin",
    mission:
      "Kelola operasional & admin: rapikan tugas rutin biar semua urusan jalan lancar.",
  },
  // Coming soon — visible but not selectable yet.
  {
    id: "website_app",
    icon: "💻",
    label: "Bangun website & aplikasi",
    mission:
      "Bantu bangun website & aplikasi: tulis kode, debug, dan jelaskan hal teknis dengan bahasa sederhana.",
    comingSoon: true,
  },
] as const;

const GOAL_IDS: ReadonlySet<string> = new Set(GOALS.map((g) => g.id));
const GOAL_LABEL_BY_ID = new Map<string, string>(GOALS.map((g) => [g.id, g.label]));

/** Keep only ids that still exist as a goal — drops stale ids from old drafts. */
export function validGoalIds(ids: readonly string[]): string[] {
  return ids.filter((id) => GOAL_IDS.has(id));
}

/** Human label for a goal id (null if unknown) — used by the SOUL builder. */
export function getGoalLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return GOAL_LABEL_BY_ID.get(id) ?? null;
}

const GOAL_MISSION_BY_ID = new Map<string, string>(
  GOALS.map((g) => [g.id, g.mission]),
);

/** Mission sentence for a goal id (null if unknown) — used by the SOUL builder. */
export function getGoalMission(id: string | null | undefined): string | null {
  if (!id) return null;
  return GOAL_MISSION_BY_ID.get(id) ?? null;
}
