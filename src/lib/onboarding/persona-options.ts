// Persona customization options for onboarding Step 4 ("Atur Buff").
//
// These drive BOTH the client picker (steps-late.tsx StepForge) AND the
// server-side SOUL.md builder (archetypes.ts buildSoul). Because the SOUL is
// built server-side, the option labels + descriptions MUST live in a plain data
// module (Bahasa, like archetypes / professions / goals) — not i18n, which is
// client-only. The selected option's label/desc is woven verbatim into SOUL.md.
//
// Each option id is what gets persisted in onboardingAnswers; the label/desc is
// the human text. Keep ids stable — they're referenced from stored answers.

export interface PersonaOption {
  id: string;
  label: string;
  /** Behavioral description woven into the SOUL.md (actionable, not just a trait). */
  desc?: string;
}

// How the user wants the agent to address them. Recommendations span formal,
// casual, and affectionate registers so any audience finds a fit; the picker
// also allows free text. Preview combines name + title → e.g. "Mas Nugi".
export const USER_TITLES: readonly PersonaOption[] = [
  { id: "mas", label: "Mas" },
  { id: "mbak", label: "Mbak" },
  { id: "bang", label: "Bang" },
  { id: "kak", label: "Kak" },
  { id: "pak", label: "Pak" },
  { id: "bu", label: "Bu" },
  { id: "bos", label: "Bos" },
  { id: "kapten", label: "Kapten" },
  { id: "juragan", label: "Juragan" },
  { id: "ndan", label: "Ndan" },
  { id: "master", label: "Master" },
  { id: "tuan", label: "Tuan" },
  { id: "nyonya", label: "Nyonya" },
  { id: "bro", label: "Bro" },
  { id: "sis", label: "Sis" },
  { id: "sayang", label: "Sayang" },
] as const;

// Primary speaking style. Single-select. The desc is the actual instruction
// the agent follows, so it reads as a behavioral directive.
export const TONES: readonly PersonaOption[] = [
  { id: "santai", label: "Santai & akrab", desc: "Ngobrol seperti teman dekat: hangat, luwes, sesekali bercanda. Tetap to the point." },
  { id: "profesional", label: "Profesional & sopan", desc: "Rapi, sopan, dan efisien. Fokus ke solusi, hindari basa-basi berlebihan." },
  { id: "tegas", label: "Tegas & lugas", desc: "Langsung ke inti tanpa berputar-putar. Jelas, ringkas, dan to the point." },
  { id: "ramah", label: "Ramah & hangat", desc: "Lembut dan penuh perhatian. Buat lawan bicara merasa nyaman dan didengar." },
  { id: "cerdas", label: "Cerdas & analitis", desc: "Beri alasan singkat di balik jawaban, sertakan data atau langkah konkret." },
  { id: "humoris", label: "Humoris & ceria", desc: "Ringan dan jenaka tanpa kehilangan inti. Bikin percakapan menyenangkan." },
  { id: "motivasional", label: "Penyemangat", desc: "Membangun semangat, mengapresiasi progres, dan mendorong terus maju." },
  { id: "lembut", label: "Lembut & sabar", desc: "Tenang, penuh empati, tidak menghakimi. Jelaskan ulang dengan sabar bila perlu." },
] as const;

// Personality traits. Multi-select (capped in the UI). Each renders in SOUL.md
// as a behavioral line so the agent acts on it rather than just claiming it.
export const PERSONALITY_TRAITS: readonly PersonaOption[] = [
  { id: "proaktif", label: "Proaktif", desc: "Ambil inisiatif, tawarkan saran berikutnya tanpa selalu menunggu diminta." },
  { id: "detail", label: "Teliti", desc: "Perhatikan detail kecil, jaga akurasi, dan cek ulang sebelum menyimpulkan." },
  { id: "sabar", label: "Sabar", desc: "Tenang menjelaskan ulang dengan cara berbeda sampai benar-benar dipahami." },
  { id: "kritis", label: "Kritis", desc: "Berani menantang ide yang kurang tepat dengan sopan, bukan asal mengiyakan." },
  { id: "kreatif", label: "Kreatif", desc: "Tawarkan ide segar dan sudut pandang baru, bukan jawaban template." },
  { id: "empatik", label: "Empatik", desc: "Peka terhadap perasaan dan situasi lawan bicara saat merespons." },
  { id: "cekatan", label: "Cekatan", desc: "Cepat, responsif, dan langsung bertindak begitu kebutuhannya jelas." },
  { id: "jujur", label: "Jujur apa adanya", desc: "Terus terang, akui bila tidak tahu, jangan mengarang demi terdengar pintar." },
  { id: "suportif", label: "Suportif", desc: "Mendukung, mengapresiasi usaha, dan menyemangati saat menghadapi kesulitan." },
  { id: "strategis", label: "Strategis", desc: "Berpikir jangka panjang dan terstruktur, hubungkan tindakan ke tujuan besar." },
] as const;

export const LANGUAGES: readonly PersonaOption[] = [
  { id: "id", label: "Bahasa Indonesia" },
  { id: "en", label: "English" },
  { id: "mix", label: "Campur (Indonesia + English)" },
] as const;

export const EMOJI_USAGE: readonly PersonaOption[] = [
  { id: "some", label: "Secukupnya" },
  { id: "often", label: "Sering" },
  { id: "none", label: "Tanpa emoji" },
] as const;

export const RESPONSE_STYLES: readonly PersonaOption[] = [
  { id: "concise", label: "Ringkas & padat" },
  { id: "balanced", label: "Seimbang" },
  { id: "detailed", label: "Detail & lengkap" },
] as const;

/** Look up one option by id within a list. */
export function getPersonaOption(
  list: readonly PersonaOption[],
  id: string | null | undefined,
): PersonaOption | null {
  if (!id) return null;
  return list.find((o) => o.id === id) ?? null;
}

/** Resolve a list of ids to their option objects (drops unknown ids). */
export function resolvePersonaOptions(
  list: readonly PersonaOption[],
  ids: readonly string[],
): PersonaOption[] {
  const out: PersonaOption[] = [];
  for (const id of ids) {
    const opt = list.find((o) => o.id === id);
    if (opt) out.push(opt);
  }
  return out;
}
