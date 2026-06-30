// Role + industry options for the onboarding "Peran" step. Clear, single,
// real-world categories (NOT vague "X / Y" combos) so the marketing data is
// accurate. Bahasa labels (Indonesia-first market), like archetypes/locations.
// The role dropdown has a "Lainnya → ketik" escape hatch for anything missing;
// industry is a multi-select chip grid.

export interface RoleOption {
  id: string;
  label: string;
}

export interface IndustryOption {
  id: string;
  icon: string;
  label: string;
}

export const ROLES: readonly RoleOption[] = [
  { id: "pemilik_usaha", label: "Pemilik Usaha (UMKM)" },
  { id: "founder_startup", label: "Founder Startup" },
  { id: "pemilik_online_shop", label: "Pemilik Online Shop" },
  { id: "karyawan_swasta", label: "Karyawan Swasta" },
  { id: "pegawai_negeri", label: "Pegawai Negeri (PNS)" },
  { id: "freelancer", label: "Freelancer" },
  { id: "content_creator", label: "Content Creator" },
  { id: "influencer", label: "Influencer" },
  { id: "marketing", label: "Marketing" },
  { id: "sales", label: "Sales" },
  { id: "developer", label: "Developer" },
  { id: "desainer", label: "Desainer" },
  { id: "penulis", label: "Penulis" },
  { id: "konsultan", label: "Konsultan" },
  { id: "tenaga_medis", label: "Tenaga Medis" },
  { id: "guru", label: "Guru" },
  { id: "dosen", label: "Dosen" },
  { id: "mahasiswa", label: "Mahasiswa" },
  { id: "pelajar", label: "Pelajar" },
  { id: "ibu_rumah_tangga", label: "Ibu Rumah Tangga" },
  { id: "pencari_kerja", label: "Pencari Kerja" },
] as const;

export const INDUSTRIES: readonly IndustryOption[] = [
  { id: "kuliner", icon: "🍜", label: "Kuliner" },
  { id: "fashion", icon: "👗", label: "Fashion" },
  { id: "kecantikan", icon: "💄", label: "Kecantikan" },
  { id: "kesehatan", icon: "🏥", label: "Kesehatan" },
  { id: "pendidikan", icon: "📚", label: "Pendidikan" },
  { id: "teknologi", icon: "💻", label: "Teknologi" },
  { id: "properti", icon: "🏠", label: "Properti" },
  { id: "otomotif", icon: "🚗", label: "Otomotif" },
  { id: "retail", icon: "🛍️", label: "Retail" },
  { id: "jasa", icon: "🤝", label: "Jasa" },
  { id: "keuangan", icon: "💰", label: "Keuangan" },
  { id: "pariwisata", icon: "✈️", label: "Pariwisata" },
  { id: "logistik", icon: "🚚", label: "Logistik" },
  { id: "hiburan", icon: "🎬", label: "Hiburan" },
  { id: "pertanian", icon: "🌾", label: "Pertanian" },
  { id: "perikanan", icon: "🐟", label: "Perikanan" },
  { id: "konstruksi", icon: "🏗️", label: "Konstruksi" },
  { id: "manufaktur", icon: "🏭", label: "Manufaktur" },
  { id: "event", icon: "🎉", label: "Event" },
  { id: "olahraga", icon: "⚽", label: "Olahraga" },
  { id: "pemerintahan", icon: "🏛️", label: "Pemerintahan" },
  { id: "pertambangan", icon: "⛏️", label: "Pertambangan" },
] as const;

// Common Indonesian study programs — shown when the role is a student. Single,
// clear majors + a "Lainnya → ketik" fallback.
export const JURUSAN: readonly RoleOption[] = [
  { id: "teknik_informatika", label: "Teknik Informatika" },
  { id: "sistem_informasi", label: "Sistem Informasi" },
  { id: "ilmu_komputer", label: "Ilmu Komputer" },
  { id: "teknik_sipil", label: "Teknik Sipil" },
  { id: "teknik_mesin", label: "Teknik Mesin" },
  { id: "teknik_elektro", label: "Teknik Elektro" },
  { id: "teknik_industri", label: "Teknik Industri" },
  { id: "arsitektur", label: "Arsitektur" },
  { id: "manajemen", label: "Manajemen" },
  { id: "akuntansi", label: "Akuntansi" },
  { id: "ekonomi", label: "Ekonomi" },
  { id: "bisnis_digital", label: "Bisnis Digital" },
  { id: "hukum", label: "Hukum" },
  { id: "kedokteran", label: "Kedokteran" },
  { id: "keperawatan", label: "Keperawatan" },
  { id: "farmasi", label: "Farmasi" },
  { id: "kesehatan_masyarakat", label: "Kesehatan Masyarakat" },
  { id: "psikologi", label: "Psikologi" },
  { id: "ilmu_komunikasi", label: "Ilmu Komunikasi" },
  { id: "dkv", label: "Desain Komunikasi Visual" },
  { id: "pendidikan", label: "Pendidikan / Keguruan" },
  { id: "sastra", label: "Sastra & Bahasa" },
  { id: "hubungan_internasional", label: "Hubungan Internasional" },
  { id: "pertanian", label: "Pertanian" },
  { id: "pariwisata", label: "Pariwisata" },
  { id: "smp_sma", label: "Masih SMP / SMA" },
] as const;

// Which follow-up question to ask after the role is picked.
export type RoleCategory = "student" | "business" | "worker" | "general";

const STUDENT_ROLES = new Set(["mahasiswa", "pelajar"]);
const BUSINESS_ROLES = new Set([
  "pemilik_usaha",
  "founder_startup",
  "pemilik_online_shop",
]);
const WORKER_ROLES = new Set([
  "karyawan_swasta",
  "pegawai_negeri",
  "marketing",
  "sales",
  "developer",
  "desainer",
  "penulis",
  "konsultan",
  "tenaga_medis",
  "guru",
  "dosen",
]);

export function roleCategory(roleId: string): RoleCategory {
  if (STUDENT_ROLES.has(roleId)) return "student";
  if (BUSINESS_ROLES.has(roleId)) return "business";
  if (WORKER_ROLES.has(roleId)) return "worker";
  // freelancer, content_creator, influencer, ibu_rumah_tangga, pencari_kerja,
  // or a custom typed role → generic "bidang yang kamu geluti".
  return "general";
}

// Label resolvers for the SOUL builder. The stored value may be a known id OR a
// custom string the user typed (SelectWithOther) — fall back to the raw text so
// custom answers still read naturally in the persona.
function labelFromList(
  list: readonly { id: string; label: string }[],
  value: string | null | undefined,
): string | null {
  const v = value?.trim();
  if (!v) return null;
  return list.find((o) => o.id === v)?.label ?? v;
}

export function getRoleLabel(value: string | null | undefined): string | null {
  return labelFromList(ROLES, value);
}

export function getJurusanLabel(value: string | null | undefined): string | null {
  return labelFromList(JURUSAN, value);
}

export function getIndustryLabel(value: string | null | undefined): string | null {
  return labelFromList(INDUSTRIES, value);
}
