// Skill catalog — SINGLE SOURCE OF TRUTH for the marketplace (BuffHub).
//
// Consumed by:
//   - Checkout: src/app/api/billing/skill/route.ts (getSkill + isPurchasable)
//   - Public listing: src/app/api/skills/buffhub/route.ts (listSkills)
//   - Item Shop UI: /app/shop (listSkills / category grouping)
//   - Installer: src/lib/billing/skill-installer.ts (source + key)
//
// IMPORTANT (2026-06-02, Chief decision):
//   These are EXTERNAL WEB APPS connected to the user's agent via MCP-over-HTTP
//   + a companion SKILL.md (the "MCP HTTP + Skill" pattern — see
//   _USULAN-ItemShop/ARSITEKTUR-Penghubung-WebApp.md). The web apps don't exist
//   yet. For the HACKATHON DEMO every item ships as `status: "available"` so the
//   Item Shop reads as a live, running marketplace (Buy CTA, no "Coming Soon").
//   For PRODUCTION, flip an item back to "coming_soon" until its app + MCP are
//   live — the checkout route REFUSES coming_soon SKUs (no selling a vacuum).

export type SkillSource = "clawhub" | "direct";

/** Lifecycle gate. `coming_soon` items are visible in the Shop but NOT
 *  purchasable (checkout refuses them). `available` = web app + MCP live. */
export type SkillStatus = "available" | "coming_soon";

/** Market segment — drives the Item Shop category filter + grouping. */
export type SkillCategory =
  | "umkm"
  | "creator"
  | "produktivitas"
  | "operasional"
  | "riset";

/** What buying this unlocks on the user's container. For these marketplace
 *  web apps it's always "connector" (an MCP-over-HTTP connection), but the
 *  field keeps room for future native skill/tool/plugin SKUs. */
export type UnlockKind = "skill" | "tool" | "plugin" | "connector" | "app";

/** Billing model. All current items are one-time; subscription reserved for
 *  apps with ongoing 3rd-party API cost (none yet). */
export type SkillBilling = "one_time" | "subscription";

export type SkillCatalogEntry = {
  // Stable identifier — used as skillKey in transactions + container_skill,
  // and as the install slug at the gateway.
  key: string;
  // Short hook line for the Shop card.
  tagline: string;
  // User-facing name.
  title: string;
  // Long copy for the detail view.
  description: string;
  // Rupiah, whole number (no fractional cents).
  priceRp: number;
  // Market segment.
  category: SkillCategory;
  // lucide-react icon name (resolved by the Shop UI).
  icon: string;
  // What the purchase unlocks on the container.
  unlock: UnlockKind;
  // Lifecycle gate (drives Buy vs "Segera Hadir").
  status: SkillStatus;
  // True when the app runs on the user's own API keys (BYOK).
  byok?: boolean;
  // Billing model.
  billing: SkillBilling;
  // Install path the gateway should take once available.
  source: SkillSource;
  // ClawHub manifest version pin. Undefined = install latest.
  version?: string;

  // ── Marketplace display (Item Shop UI; no effect on checkout/install) ──
  // Big emoji used as the card / hero cover art.
  coverEmoji: string;
  // Accent palette key for card gradients/badges.
  accent: "cyan" | "fuchsia" | "amber" | "emerald" | "violet" | "rose";
  // Show in the hero/featured rail + "Trending" badge.
  featured?: boolean;
  // Bullet list of what this app can do (detail drawer).
  capabilities: string[];
};

// ── Seed catalog (Chief-approved 2026-06-02) ─────────────────────────────
// 8 external web-app products. All coming_soon until their app + MCP ship.
// This is the SEED only — on first load it's inserted into the skill_catalog
// table, after which the DB is authoritative (admin CRUD via /admin/marketplace).
export const SEED_CATALOG: Record<string, SkillCatalogEntry> = {
  "cs-toko-autopilot": {
    key: "cs-toko-autopilot",
    title: "CS Toko Auto-Pilot",
    tagline: "CS toko 24/7 tanpa lembur.",
    description:
      "Customer service lengkap buat online shop kamu. Agen jawab FAQ produk, " +
      "cek stok, status order, handle komplain, dan eskalasi ke kamu kalau " +
      "perlu. Notifikasi order baru langsung masuk ke WhatsApp kamu, plus bisa " +
      "kirim invoice PDF otomatis ke pelanggan.",
    priceRp: 99_000,
    category: "umkm",
    icon: "Headset",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "🛍️",
    accent: "cyan",
    featured: true,
    capabilities: [
      "Jawab FAQ produk + cek stok otomatis",
      "Lacak status order pelanggan real-time",
      "Handle komplain + eskalasi ke kamu",
      "Notif order baru langsung ke WhatsApp",
      "Kirim invoice PDF otomatis ke pembeli",
    ],
  },
  "pencatat-keuangan": {
    key: "pencatat-keuangan",
    title: "Pencatat Keuangan",
    tagline: "Catat duit cukup ngobrol.",
    description:
      "Cukup chat 'keluar 50rb buat makan' — agen langsung catat. Tiap akhir " +
      "bulan kamu dapet laporan pemasukan/pengeluaran lengkap dengan grafik, " +
      "dikirim sebagai file ke chat. Kelola keuangan tanpa ribet aplikasi.",
    priceRp: 49_000,
    category: "umkm",
    icon: "Wallet",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "💸",
    accent: "emerald",
    capabilities: [
      "Catat pemasukan/pengeluaran cukup via chat",
      "Laporan bulanan otomatis + grafik (PDF)",
      "Kategori transaksi rapi tanpa ribet",
      "Pengingat tagihan & target keuangan",
    ],
  },
  "researcher-analyst": {
    key: "researcher-analyst",
    title: "Researcher Analyst",
    tagline: "Riset mendalam, hasil siap pakai.",
    description:
      "Web app riset mendalam + analisis mendetail. Kasih topik, agen jalanin " +
      "riset dari banyak sumber, lalu kirim laporan rapi + datanya ke kamu. " +
      "Cocok buat riset pasar, analisis kompetitor, atau bahan keputusan bisnis.",
    priceRp: 99_000,
    category: "riset",
    icon: "Telescope",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "🔭",
    accent: "violet",
    featured: true,
    capabilities: [
      "Riset mendalam dari banyak sumber",
      "Analisis pasar & kompetitor terstruktur",
      "Laporan rapi siap pakai + sumber dikutip",
      "Hasil dikirim sebagai file ke chat",
    ],
  },
  "business-builder": {
    key: "business-builder",
    title: "Bangun Bisnis Pro",
    tagline: "Dari ide jadi proposal + deck.",
    description:
      "Asisten bangun bisnis end-to-end: planning, riset pasar, analisis, " +
      "bikin logo, mood board, mockup, sampai proposal bisnis + pitch deck. " +
      "Tiap hasil dikirim bertahap ke kamu. Pakai sistem BYOK (API key kamu " +
      "sendiri) biar fleksibel dan hemat.",
    priceRp: 149_000,
    category: "produktivitas",
    icon: "Rocket",
    unlock: "connector",
    status: "available",
    byok: true,
    billing: "one_time",
    source: "direct",
    coverEmoji: "🚀",
    accent: "fuchsia",
    featured: true,
    capabilities: [
      "Planning + riset pasar end-to-end",
      "Generate logo, mood board, & mockup",
      "Susun proposal bisnis + pitch deck",
      "Output dikirim bertahap ke kamu",
      "Hemat: pakai API key kamu sendiri (BYOK)",
    ],
  },
  "marketing-content": {
    key: "marketing-content",
    title: "Studio Konten Pemasaran",
    tagline: "Pabrik konten viral all-in-one.",
    description:
      "Web app konten pemasaran lengkap: generate gambar dengan template sosmed " +
      "siap pakai, bikin mood board, generate video dari mood board, plus " +
      "analisis konten buat ngejar viral. Semua hasil dikirim ke chat. Pakai " +
      "sistem BYOK (API key kamu sendiri).",
    priceRp: 149_000,
    category: "creator",
    icon: "Megaphone",
    unlock: "connector",
    status: "available",
    byok: true,
    billing: "one_time",
    source: "direct",
    coverEmoji: "🎨",
    accent: "rose",
    featured: true,
    capabilities: [
      "Generate gambar dengan template sosmed",
      "Bikin mood board + video dari mood board",
      "Analisis konten buat ngejar viral",
      "Hasil dikirim ke chat, siap posting",
      "Hemat: pakai API key kamu sendiri (BYOK)",
    ],
  },
  "pos-umkm": {
    key: "pos-umkm",
    title: "Kasir POS UMKM",
    tagline: "Kasir digital di genggaman.",
    description:
      "Web app POS (Point of Sale) buat UMKM. Catat transaksi, kelola stok, " +
      "lihat laporan penjualan. Agen kasih notifikasi stok menipis + rekap " +
      "omzet harian langsung ke chat kamu.",
    priceRp: 99_000,
    category: "operasional",
    icon: "Store",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "🏪",
    accent: "amber",
    capabilities: [
      "Catat transaksi penjualan cepat",
      "Kelola stok produk otomatis",
      "Laporan omzet harian ke chat",
      "Notif stok menipis biar gak kehabisan",
    ],
  },
  "manajemen-kos": {
    key: "manajemen-kos",
    title: "Manajemen Kos",
    tagline: "Urus kos tanpa pusing.",
    description:
      "Web app kelola kos: data kamar, penghuni, dan tagihan sewa. Agen kasih " +
      "notifikasi jatuh tempo sewa otomatis ke kamu dan penghuni lewat " +
      "WhatsApp. Anti telat bayar, anti lupa.",
    priceRp: 99_000,
    category: "operasional",
    icon: "Building2",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "🏘️",
    accent: "cyan",
    capabilities: [
      "Data kamar & penghuni terorganisir",
      "Tagihan sewa otomatis terhitung",
      "Notif jatuh tempo ke kamu + penghuni",
      "Rekap pemasukan kos bulanan",
    ],
  },
  "absensi-karyawan": {
    key: "absensi-karyawan",
    title: "Absensi Karyawan",
    tagline: "Absensi tim, otomatis terekap.",
    description:
      "Web app absensi karyawan. Check-in/check-out, rekap kehadiran, dan " +
      "laporan otomatis. Agen kirim rekap harian ke kamu biar pantau tim tanpa " +
      "buka aplikasi.",
    priceRp: 49_000,
    category: "operasional",
    icon: "UserCheck",
    unlock: "connector",
    status: "available",
    billing: "one_time",
    source: "direct",
    coverEmoji: "🕒",
    accent: "emerald",
    capabilities: [
      "Check-in/check-out karyawan praktis",
      "Rekap kehadiran otomatis",
      "Laporan harian dikirim ke kamu",
      "Pantau tim tanpa buka aplikasi",
    ],
  },
};

// ── DB-backed catalog (D13) ──────────────────────────────────────────────
// The skill_catalog table is authoritative. On first load (table empty) we seed
// it from SEED_CATALOG, after which admin CRUD owns it. A 30s in-memory cache
// keeps the hot read paths (checkout, Shop listing) cheap; admin writes call
// invalidateCatalogCache(). NO `import "server-only"`: reached from the installer
// in the plain-Node worker chain (same constraint as settings.ts).
import { db } from "@/lib/db";
import { skillCatalog } from "@/lib/db/schema";

type CatalogRow = typeof skillCatalog.$inferSelect;

let cache: { entries: Map<string, SkillCatalogEntry>; exp: number } | null = null;
let seedChecked = false;
const TTL_MS = 30_000;

function rowToEntry(r: CatalogRow): SkillCatalogEntry {
  return {
    key: r.key,
    title: r.title,
    tagline: r.tagline,
    description: r.description,
    priceRp: r.priceRp,
    category: r.category as SkillCategory,
    icon: r.icon,
    unlock: r.unlock as UnlockKind,
    status: r.status as SkillStatus,
    byok: r.byok,
    billing: r.billing as SkillBilling,
    source: r.source as SkillSource,
    version: r.version ?? undefined,
    coverEmoji: r.coverEmoji,
    accent: r.accent as SkillCatalogEntry["accent"],
    featured: r.featured,
    capabilities: r.capabilities ?? [],
  };
}

/** Insert the SEED entries once (idempotent) if the table has never been seeded. */
async function ensureSeeded(): Promise<void> {
  if (seedChecked) return;
  const [existing] = await db
    .select({ key: skillCatalog.key })
    .from(skillCatalog)
    .limit(1);
  if (!existing) {
    const seed = Object.values(SEED_CATALOG).map((s, i) => ({
      key: s.key,
      title: s.title,
      tagline: s.tagline,
      description: s.description,
      priceRp: s.priceRp,
      category: s.category,
      icon: s.icon,
      unlock: s.unlock,
      status: s.status,
      byok: s.byok ?? false,
      billing: s.billing,
      source: s.source,
      version: s.version ?? null,
      coverEmoji: s.coverEmoji,
      accent: s.accent,
      featured: s.featured ?? false,
      capabilities: s.capabilities,
      sortOrder: i,
    }));
    await db.insert(skillCatalog).values(seed).onConflictDoNothing();
  }
  seedChecked = true;
}

async function loadCatalog(): Promise<Map<string, SkillCatalogEntry>> {
  if (cache && cache.exp > Date.now()) return cache.entries;
  await ensureSeeded();
  const rows = await db
    .select()
    .from(skillCatalog)
    .orderBy(skillCatalog.sortOrder);
  const entries = new Map<string, SkillCatalogEntry>();
  for (const r of rows) entries.set(r.key, rowToEntry(r));
  cache = { entries, exp: Date.now() + TTL_MS };
  return entries;
}

/** Drop the in-memory cache (call after an admin write). */
export function invalidateCatalogCache(): void {
  cache = null;
}

export async function getSkill(key: string): Promise<SkillCatalogEntry | null> {
  const entries = await loadCatalog();
  return entries.get(key) ?? null;
}

export async function listSkills(): Promise<SkillCatalogEntry[]> {
  const entries = await loadCatalog();
  return [...entries.values()];
}

/** Only items that are actually purchasable right now (app + MCP live). */
export async function listAvailableSkills(): Promise<SkillCatalogEntry[]> {
  const entries = await loadCatalog();
  return [...entries.values()].filter((s) => s.status === "available");
}

/** True when this SKU can be bought right now. Checkout MUST gate on this so
 *  we never charge for a coming_soon product. */
export async function isPurchasable(key: string): Promise<boolean> {
  const s = await getSkill(key);
  return !!s && s.status === "available";
}
