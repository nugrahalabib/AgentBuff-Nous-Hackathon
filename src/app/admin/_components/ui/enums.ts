// Shared admin enums, status->tone maps, and the error-code -> Bahasa table.
// Single source so filters/badges/labels never drift across the 14 tabs.

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

// Dark ops-console tone classes (matches /app + existing admin tabs).
export const TONE_BADGE: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/25",
  warn: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/25",
  bad: "bg-red-500/15 text-red-300 ring-1 ring-red-500/25",
  muted: "bg-zinc-700/40 text-zinc-300 ring-1 ring-zinc-600/50",
  info: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/25",
};

// Dot color for status dots (legend, nav warning, etc.).
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  muted: "bg-zinc-400",
  info: "bg-sky-500",
};

export type Option<T extends string = string> = {
  value: T;
  label: string;
  hint?: string;
  tone?: Tone;
};

// --- Cross-cutting enums (grounded in CLAUDE.md + schema). Per-tab enums live
// next to their tab; only the truly shared ones belong here. ---

export const USER_ROLES: Option[] = [
  { value: "user", label: "User", hint: "Pemakai biasa AgentBuff", tone: "muted" },
  { value: "support", label: "Support", hint: "Baca-saja panel admin", tone: "info" },
  { value: "admin", label: "Admin", hint: "Akses penuh, bisa ubah semua", tone: "ok" },
];

export const TIERS: Option[] = [
  { value: "starter", label: "Starter", hint: "Gratis · 1 agen", tone: "muted" },
  { value: "op_buff", label: "OP Buff", hint: "Rp 99k/bln", tone: "info" },
  { value: "guild_master", label: "Guild Master", hint: "Enterprise · custom", tone: "ok" },
];

// Status->tone map for container lifecycle (schema: user_container.status).
export const CONTAINER_STATUS_TONE: Record<string, Tone> = {
  running: "ok",
  "awaiting-health": "warn",
  starting: "warn",
  queued: "warn",
  stopped: "muted",
  failed: "bad",
  destroyed: "bad",
};

// --- Error code -> friendly Bahasa. Maps server GatewayError/HTTP codes the
// admin routes return into something an operator understands. Extend as tabs
// surface new codes; unknown codes fall back to the raw message. ---

export const ERROR_BAHASA: Record<string, string> = {
  RATE_LIMITED: "Terlalu sering. Tunggu sebentar lalu coba lagi.",
  UNAUTHORIZED: "Sesi kadaluarsa. Muat ulang halaman lalu login lagi.",
  FORBIDDEN: "Aksi ini khusus admin.",
  ADMIN_ONLY: "Aksi ini khusus admin.",
  NOT_FOUND: "Data tidak ditemukan (mungkin sudah berubah). Muat ulang.",
  INVALID_REQUEST: "Input tidak valid. Periksa lagi isiannya.",
  VALIDATION_ERROR: "Ada isian yang belum benar. Periksa field bertanda merah.",
  BELOW_THRESHOLD: "Di bawah minimum yang diizinkan (mis. payout Rp 50.000).",
  SELF_APPROVAL_FORBIDDEN: "Harus disetujui admin yang berbeda dari pembuatnya.",
  CANNOT_SELF_DEMOTE: "Kamu tidak bisa menurunkan role akun sendiri.",
  CANNOT_SELF_SUSPEND: "Kamu tidak bisa menangguhkan akun sendiri.",
  CANNOT_SELF_DELETE: "Kamu tidak bisa menjadwalkan hapus akun sendiri.",
  IRIS_NOT_CONFIGURED: "Kunci payout Iris belum dipasang (fase deploy).",
  ENERGY_EXHAUSTED: "Energy user habis.",
  CONFLICT: "Bentrok dengan data lain (mungkin sudah diproses). Muat ulang.",
};

/** Map an error code or raw message to friendly Bahasa, with a safe fallback. */
export function errorToBahasa(input: unknown): string {
  if (!input) return "Terjadi kesalahan. Coba lagi.";
  const raw = input instanceof Error ? input.message : String(input);
  // Try exact code match first, then substring (some come as "HTTP 429" etc).
  if (ERROR_BAHASA[raw]) return ERROR_BAHASA[raw];
  const upper = raw.toUpperCase();
  for (const [code, msg] of Object.entries(ERROR_BAHASA)) {
    if (upper.includes(code)) return msg;
  }
  if (/\b429\b/.test(raw)) return ERROR_BAHASA.RATE_LIMITED;
  if (/\b401\b/.test(raw)) return ERROR_BAHASA.UNAUTHORIZED;
  if (/\b403\b/.test(raw)) return ERROR_BAHASA.FORBIDDEN;
  if (/\b404\b/.test(raw)) return ERROR_BAHASA.NOT_FOUND;
  return raw;
}
