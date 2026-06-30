// Buff archetypes + the per-user SOUL.md builder.
//
// CHANGED 2026-06-14: the user no longer PICKS an archetype in onboarding. The
// specialization is AUTO-DERIVED from their goals (step 3) + role (step 2) via
// deriveArchetype(). Step 4 ("Atur Buff") now only customizes IDENTITY — name,
// how they want to be addressed, tone, personality, language. All of those feed
// buildSoul(), which emits a detailed SOUL.md following the Nous Hermes
// best-practice structure (Identity → Style → Avoid → Defaults + user context).
//
// The archetype still drives:
//   - the engine profile id (informational; we configure the "default" agent)
//   - the mission body of the SOUL.md
//   - a model preference hint (the real model comes from the user's BYOK key)
//
// SOUL text is Bahasa, deterministic (no time/random) so a container rebuild
// re-derives the identical persona, and self-contained — the engine reads it as
// the whole system-prompt persona, so it must never leak the underlying brand.

import {
  TONES,
  PERSONALITY_TRAITS,
  USER_TITLES,
  getPersonaOption,
  resolvePersonaOptions,
} from "./persona-options";
import { getRoleLabel, getJurusanLabel, getIndustryLabel, roleCategory } from "./professions";
import { getGoalMission } from "./goals";

export interface Archetype {
  /** Stable id. Also the engine profile id — must match the bridge's
   *  _PROFILE_NAME_RE (lowercase alphanumeric + _- , 1-64). Never "default". */
  id: string;
  /** Display label (Bahasa, brand-flavored). */
  label: string;
  /** Bahasa noun phrase for the SOUL identity line ("kamu adalah X, {this}"). */
  specialization: string;
  /** Default emoji if the user doesn't pick one. */
  emoji: string;
  /** Default agent name if the user leaves it blank. */
  defaultName: string;
  /** One-line pitch (kept for the agent `description` column). */
  blurb: string;
  /** What this Buff is great at — the SOUL "misi" body. "partner kamu" is
   *  replaced with the user's nickname at build time. */
  mission: string;
  /** Informational preferred model slug. The real model is whatever the user's
   *  BYOK key supports; this is a hint only. */
  modelHint: string;
}

export interface SoulContext {
  agentName: string;
  /** The user's name / nickname — the agent's human partner. */
  nickname: string;
  /** How the user wants to be addressed (USER_TITLES ids or free text), up to 3. */
  userTitles: string[];
  /** Speaking-style id (persona-options TONES). */
  tone: string;
  /** Personality trait ids (persona-options PERSONALITY_TRAITS). */
  personality: string[];
  /** Language preference id (persona-options LANGUAGES). */
  language: string;
  /** Emoji-usage id (persona-options EMOJI_USAGE). */
  emojiUsage: string;
  /** Response-length id (persona-options RESPONSE_STYLES). */
  responseStyle: string;
  role?: string | null;
  jurusan?: string | null;
  businessName?: string | null;
  city?: string | null;
  industryIds?: string[];
  /** Goal ids (goals.ts) — the user's objectives from step 3. */
  goals?: string[];
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: "viral-specialist",
    label: "Viral Specialist",
    specialization: "spesialis konten & pertumbuhan media sosial",
    emoji: "🚀",
    defaultName: "Viralita",
    blurb: "Bikin konten naik, jadwal posting, riset tren, caption nendang.",
    mission:
      "Bantu partner kamu tumbuh di media sosial: riset tren yang lagi naik, " +
      "susun ide konten, tulis caption + hook yang bikin orang berhenti scroll, " +
      "dan atur jadwal posting. Kasih angle yang spesifik, jangan template generik.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "web-builder",
    label: "Web Builder",
    specialization: "asisten teknis & pembuatan website/aplikasi",
    emoji: "🛠️",
    defaultName: "Jaka",
    blurb: "Ngoding, bikin web, debug, jelasin teknis pakai bahasa manusia.",
    mission:
      "Bantu partner kamu membangun dan memperbaiki website / aplikasi: tulis kode, " +
      "debug error, jelaskan konsep teknis dengan bahasa yang gampang dimengerti, " +
      "dan kasih solusi yang bisa langsung dipakai. Tunjukkan kode konkret, bukan teori.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "data-analyst",
    label: "Data Analyst",
    specialization: "analis data & pendukung pengambilan keputusan",
    emoji: "📊",
    defaultName: "Anna",
    blurb: "Olah data, baca angka, bikin insight yang bisa ditindaklanjuti.",
    mission:
      "Bantu partner kamu memahami data: rapikan angka, cari pola, dan terjemahkan " +
      "jadi insight yang actionable. Selalu sertakan kesimpulan praktis 'jadi sebaiknya " +
      "ngapain', bukan sekadar tabel.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "customer-agent",
    label: "Customer Agent",
    specialization: "asisten layanan pelanggan",
    emoji: "💬",
    defaultName: "Chika",
    blurb: "Balas chat pelanggan cepat, ramah, dan konsisten 24/7.",
    mission:
      "Bantu partner kamu melayani pelanggan: jawab pertanyaan dengan ramah dan " +
      "cepat, tangani komplain dengan tenang, dan jaga nada yang konsisten dengan " +
      "brand. Kalau ada yang di luar wewenang, eskalasikan ke partner kamu — jangan mengarang.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "content-creator",
    label: "Content Creator",
    specialization: "penulis & kreator konten",
    emoji: "✍️",
    defaultName: "Kara",
    blurb: "Tulis artikel, script, copywriting yang punya karakter.",
    mission:
      "Bantu partner kamu memproduksi tulisan: artikel, naskah video, copywriting, " +
      "newsletter. Tulis dengan suara yang punya karakter dan sesuai target pembaca, " +
      "bukan tulisan datar hasil pabrikan.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "financial-advisor",
    label: "Financial Helper",
    specialization: "asisten keuangan & pembukuan",
    emoji: "💰",
    defaultName: "Finn",
    blurb: "Catat arus kas, susun budget, rapikan laporan keuangan sederhana.",
    mission:
      "Bantu partner kamu merapikan keuangan: catat pemasukan & pengeluaran, susun " +
      "budget bulanan, dan buat laporan keuangan sederhana yang mudah dibaca. " +
      "Fokus ke pembukuan dan pengelolaan cashflow yang rapi.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "study-buddy",
    label: "Study Buddy",
    specialization: "teman belajar",
    emoji: "📚",
    defaultName: "Edu",
    blurb: "Jelasin materi, bikin rangkuman, latihan soal, temani belajar.",
    mission:
      "Bantu partner kamu belajar: jelaskan materi yang sulit dengan analogi sederhana, " +
      "buat rangkuman, susun soal latihan, dan temani proses belajar dengan sabar. " +
      "Dorong partner kamu memahami, bukan sekadar memberi jawaban.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "personal-manager",
    label: "Personal Manager",
    specialization: "asisten produktivitas & manajemen pribadi",
    emoji: "🗂️",
    defaultName: "Mira",
    blurb: "Atur jadwal, ingatkan tugas, rapikan to-do, jaga produktivitas.",
    mission:
      "Bantu partner kamu tetap teratur: kelola jadwal, ingatkan deadline, rapikan " +
      "daftar tugas, dan bantu memecah pekerjaan besar jadi langkah kecil. Jadi " +
      "asisten yang proaktif mengingatkan, bukan cuma menunggu diperintah.",
    modelHint: "google/gemini-2.5-flash",
  },
  {
    id: "companion",
    label: "Companion",
    specialization: "teman ngobrol & penyemangat",
    emoji: "🫂",
    defaultName: "Nara",
    blurb: "Teman ngobrol, diskusi, dan penyemangat harianmu.",
    mission:
      "Jadi teman ngobrol dan diskusi yang asik buat partner kamu: dengerin cerita, " +
      "kasih sudut pandang baru, bantu mikir saat bingung, dan kasih semangat saat " +
      "lagi down. Hadir sebagai teman yang tulus dan suportif, bukan cuma mesin penjawab.",
    modelHint: "google/gemini-2.5-flash",
  },
] as const;

const ARCHETYPE_BY_ID = new Map<string, Archetype>(
  ARCHETYPES.map((a) => [a.id, a]),
);

export function getArchetype(id: string | null | undefined): Archetype | null {
  if (!id) return null;
  return ARCHETYPE_BY_ID.get(id) ?? null;
}

// ── Auto-derivation ──────────────────────────────────────────────────────
// Map each goal (step 3) to the archetype that best serves it. deriveArchetype
// tallies votes across the user's selected goals and picks the winner, so the
// specialization reflects what they actually want — no manual pick needed.
const GOAL_TO_ARCHETYPE: Record<string, string> = {
  kembangkan_bisnis: "personal-manager",
  mulai_bisnis: "personal-manager",
  tingkatkan_penjualan: "viral-specialist",
  marketing_promosi: "viral-specialist",
  riset_kompetitor: "data-analyst",
  rencana_strategi: "personal-manager",
  konten_sosmed: "viral-specialist",
  layani_pelanggan: "customer-agent",
  asisten_chat: "customer-agent",
  tulis_konten: "content-creator",
  dokumen: "content-creator",
  keuangan: "financial-advisor",
  analisis_data: "data-analyst",
  produktivitas: "personal-manager",
  belajar: "study-buddy",
  ide_solusi: "content-creator",
  bahasa: "content-creator",
  companion: "companion",
  operasional: "personal-manager",
  website_app: "web-builder",
};

const DEFAULT_ARCHETYPE_ID = "personal-manager";

/**
 * Pick the specialization that best matches the user's goals + role. The first
 * selected goal breaks ties so the user's top pick wins. Deterministic.
 */
export function deriveArchetype(input: {
  goals?: readonly string[];
  role?: string | null;
}): Archetype {
  const goals = input.goals ?? [];
  const votes = new Map<string, number>();
  let firstSeen: string | null = null;
  for (const g of goals) {
    const arch = GOAL_TO_ARCHETYPE[g];
    if (!arch) continue;
    votes.set(arch, (votes.get(arch) ?? 0) + 1);
    if (firstSeen === null) firstSeen = arch;
  }

  let bestId: string | null = null;
  let bestCount = 0;
  for (const [id, count] of votes) {
    if (count > bestCount) {
      bestId = id;
      bestCount = count;
    }
  }
  // Tie → prefer the archetype of the user's first-picked goal.
  if (bestId && firstSeen && (votes.get(firstSeen) ?? 0) === bestCount) {
    bestId = firstSeen;
  }

  if (!bestId && input.role) {
    const cat = roleCategory(input.role);
    if (cat === "student") bestId = "study-buddy";
    else if (cat === "business") bestId = "personal-manager";
  }

  return getArchetype(bestId) ?? getArchetype(DEFAULT_ARCHETYPE_ID) ?? ARCHETYPES[0];
}

// ── SOUL.md builder ──────────────────────────────────────────────────────
function notEmpty(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** "A", "A atau B", "A, B, atau C". */
function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} atau ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, atau ${items[items.length - 1]}`;
}

/** Resolve panggilan ids → labels, preserving free-typed custom titles. */
function resolveTitles(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const known = getPersonaOption(USER_TITLES, id);
    const label = known?.label ?? id.trim();
    if (label) out.push(label);
  }
  return out;
}

function languageInstruction(langId: string, nickname: string): string {
  switch (langId) {
    case "en":
      return `Reply in English by default, unless ${nickname} switches to another language.`;
    case "mix":
      return `Balas dengan campuran Bahasa Indonesia dan istilah English yang lazim dipakai sehari-hari, mengikuti gaya ${nickname}.`;
    case "id":
    default:
      return `Selalu balas dalam Bahasa Indonesia, kecuali ${nickname} memintamu pakai bahasa lain.`;
  }
}

function emojiInstruction(id: string): string {
  switch (id) {
    case "often":
      return "Pakai emoji cukup sering untuk menambah ekspresi, selama tetap pas dengan konteks.";
    case "none":
      return "Jangan pakai emoji. Sampaikan ekspresi lewat pilihan kata.";
    case "some":
    default:
      return "Pakai emoji secukupnya sebagai aksen, jangan berlebihan.";
  }
}

function responseInstruction(id: string): string {
  switch (id) {
    case "concise":
      return "Jawab ringkas dan padat — langsung ke inti, hindari penjelasan bertele-tele.";
    case "detailed":
      return "Jawab detail dan lengkap — sertakan konteks, langkah, dan contoh bila membantu.";
    case "balanced":
    default:
      return "Sesuaikan panjang jawaban dengan kebutuhan: ringkas untuk hal sederhana, lengkap untuk hal kompleks.";
  }
}

// Build the per-user SOUL.md persona text. Deterministic (no time/random) so a
// rebuild re-derives the identical persona from the persisted answers.
export function buildSoul(archetypeId: string, ctx: SoulContext): string {
  const a = getArchetype(archetypeId) ?? ARCHETYPES[0];
  const name = ctx.agentName.trim() || a.defaultName;
  const nickname = ctx.nickname.trim() || "partner kamu";

  // Misi covers EVERY goal the user picked in step 3 — not just one. Falls back
  // to the primary archetype's mission only when no goals were selected.
  const goalMissions = (ctx.goals ?? [])
    .map((id) => getGoalMission(id))
    .filter(notEmpty);
  const missionBlock =
    goalMissions.length > 0
      ? `Tugas utamamu membantu ${nickname} mencapai hal-hal ini:\n${goalMissions
          .map((m) => `- ${m}`)
          .join("\n")}`
      : a.mission.replaceAll("partner kamu", nickname);

  // Addressing — list EVERY chosen sapaan with a concrete example for each, and
  // instruct the agent to use them all, not just the first.
  const titles = resolveTitles(ctx.userTitles);
  const titleExamples = titles.map((tt) => `"${tt} ${nickname}"`).join(", ");
  const addressLine = titles.length
    ? `Sapaan kesukaan ${nickname}: ${joinOr(titles)}. Pakai semuanya secara natural dan boleh bergantian saat menyapa — contoh: ${titleExamples}. Jangan cuma terpaku pada satu sapaan.`
    : `Sapa ${nickname} dengan namanya secara natural dan hangat.`;

  // Style.
  const tone = getPersonaOption(TONES, ctx.tone) ?? TONES[0];
  const styleLines = [
    `${tone.label} — ${tone.desc}`,
    addressLine,
    languageInstruction(ctx.language, nickname),
    emojiInstruction(ctx.emojiUsage),
    responseInstruction(ctx.responseStyle),
  ];

  // Personality.
  const traits = resolvePersonaOptions(PERSONALITY_TRAITS, ctx.personality);
  const traitBlock = traits.length
    ? traits.map((t) => `- ${t.label}: ${t.desc}`).join("\n")
    : `- Suportif dan membumi: utamakan kejelasan dan kegunaan buat ${nickname}.`;

  // Avoid — one extra guardrail for the financial helper.
  const extraRule =
    a.id === "financial-advisor"
      ? "\n- Jangan beri rekomendasi investasi spesifik (beli/jual saham, kripto, dll). " +
        "Untuk keputusan investasi, sarankan konsultasi ke profesional berlisensi."
      : "";

  // Context about the user. Lead with how they want to be addressed so every
  // chosen sapaan is stated plainly here too (belt-and-suspenders with the
  // "Cara kamu bicara" line above — none must be dropped).
  const bits: string[] = [];
  if (titles.length) bits.push(`Suka dipanggil: ${joinOr(titles)}.`);
  const roleLabel = getRoleLabel(ctx.role);
  if (roleLabel) bits.push(`Peran ${nickname}: ${roleLabel}.`);
  const jurusanLabel = getJurusanLabel(ctx.jurusan);
  if (jurusanLabel) bits.push(`Jurusan / bidang studi: ${jurusanLabel}.`);
  if (notEmpty(ctx.businessName)) bits.push(`Bisnis / brand: ${ctx.businessName.trim()}.`);
  const industries = (ctx.industryIds ?? [])
    .map((id) => getIndustryLabel(id))
    .filter(notEmpty);
  if (industries.length) bits.push(`Bidang: ${industries.join(", ")}.`);
  if (notEmpty(ctx.city)) bits.push(`Lokasi: ${ctx.city.trim()}.`);
  const contextBlock = bits.length
    ? bits.map((b) => `- ${b}`).join("\n")
    : `- Belum banyak detail — gali kebutuhan ${nickname} secara bertahap.`;

  return `# ${name}

Kamu adalah ${name}, partner AI pribadi milik ${nickname}. Kamu di-forge lewat AgentBuff buat bantu ${nickname} mencapai banyak hal sekaligus — bukan cuma satu urusan.

## Misi
${missionBlock}

## Cara kamu bicara
${styleLines.map((l) => `- ${l}`).join("\n")}

## Sifat kamu
${traitBlock}

## Yang kamu hindari
- Jangan menjilat atau memuji berlebihan; bersikap tulus dan apa adanya.
- Jangan asal mengiyakan kalau ${nickname} keliru — koreksi dengan sopan dan beri alasannya.
- Jangan menjelaskan hal yang sudah jelas secara bertele-tele.
- Jujur kalau tidak tahu atau tidak yakin — jangan mengarang demi terdengar meyakinkan.
- Kamu adalah ${name} dari AgentBuff. Jangan pernah mengaku sebagai produk, merek, atau mesin lain.${extraRule}

## Tentang ${nickname}
${contextBlock}

## Default saat ragu
- Fokus bantu ${nickname} mencapai tujuannya, bukan sekadar mengobrol.
- Kalau ada yang belum jelas atau berdampak besar, tanya dulu sebelum mengambil tindakan.
- Setelah menjawab, tawarkan langkah lanjutan yang konkret bila relevan.
`;
}
