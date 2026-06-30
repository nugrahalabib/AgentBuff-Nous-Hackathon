"use client";

/**
 * ShopTab — Item Shop (BuffHub marketplace) untuk /app/shop.
 *
 * Marketplace-grade UI: hero banner, kategori rail, kartu produk dengan cover
 * gradient + emoji besar + accent warna + capabilities preview, detail drawer
 * slide-in, plus 3 mode: Marketplace (skill/app/tool/agen) · Energy · Langganan.
 *
 * Data REAL dari /api/skills/buffhub (skill-catalog.ts) + /api/billing/bundles
 * (DB). Checkout reuse popup /billing/* + listener postMessage "billing:settled".
 * Semua item web-app sekarang `coming_soon` → kartu "Segera Hadir" + tombol
 * "Daftar Tunggu" (gak charge). Begitu app+MCP live → status flip → tombol Beli.
 *
 * Backend TIDAK disentuh — murni UI/UX. (Chief 2026-06-02: bikin kayak
 * marketplace beneran, lebih bagus dari /basecamp/shop mock.)
 */
import { AnimatePresence, motion } from "framer-motion";
import { openBillingPopup } from "@/lib/app/billing-popup";
import { EarlyAccessModal } from "@/components/home/early-access-modal";
import {
  PLANS_ORDERED,
  isSubscribableTier,
  type PlanTier,
} from "@/lib/billing/plans";
import { useSubscriptionState, useProfile, usePricing } from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { localizeSkill } from "@/lib/billing/skill-catalog-i18n";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Headset,
  KeyRound,
  Megaphone,
  Rocket,
  Search,
  ShoppingBag,
  Sparkles,
  Store,
  Telescope,
  UserCheck,
  Wallet,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { cn } from "@/lib/utils";

// ── Types (mirror /api/skills/buffhub response) ──────────────────────────
type Accent = "cyan" | "fuchsia" | "amber" | "emerald" | "violet" | "rose";

type ShopItem = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: "umkm" | "creator" | "produktivitas" | "operasional" | "riset";
  priceRp: number;
  icon: string;
  unlock: string;
  status: "available" | "coming_soon";
  byok: boolean;
  billing: "one_time" | "subscription";
  coverEmoji: string;
  accent: Accent;
  featured: boolean;
  capabilities: string[];
};

export type ShopSection = "market" | "energy" | "langganan";

const ICONS: Record<string, LucideIcon> = {
  Headset, Wallet, Telescope, Rocket, Megaphone, Store, Building2, UserCheck,
};

type ShopDemoDict = ReturnType<typeof useI18n>["t"]["app"]["shop"]["demo"];

function categoryLabel(d: ShopDemoDict, c: ShopItem["category"]): string {
  switch (c) {
    case "umkm": return d.categoryUmkm;
    case "creator": return d.categoryCreator;
    case "produktivitas": return d.categoryProduktivitas;
    case "operasional": return d.categoryOperasional;
    case "riset": return d.categoryRiset;
    default: return c;
  }
}

function unlockLabel(d: ShopDemoDict, unlock: string): string {
  switch (unlock) {
    case "connector": return d.unlockConnector;
    case "skill": return d.unlockSkill;
    case "tool": return d.unlockTool;
    case "plugin": return d.unlockPlugin;
    case "app": return d.unlockApp;
    default: return unlock;
  }
}

// Accent → tailwind class bundles. Static strings so Tailwind keeps them.
const ACCENT: Record<
  Accent,
  { grad: string; ring: string; ringHover: string; text: string; badge: string; glow: string; btn: string }
> = {
  cyan: {
    grad: "from-cyan-500/25 via-sky-500/15 to-indigo-500/10",
    ring: "border-cyan-400/20",
    ringHover: "hover:border-cyan-400/50",
    text: "text-cyan-200",
    badge: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(34,211,238,0.5)]",
    btn: "from-cyan-400 via-sky-500 to-indigo-500",
  },
  fuchsia: {
    grad: "from-fuchsia-500/25 via-violet-500/15 to-indigo-500/10",
    ring: "border-fuchsia-400/20",
    ringHover: "hover:border-fuchsia-400/50",
    text: "text-fuchsia-200",
    badge: "border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(217,70,239,0.5)]",
    btn: "from-fuchsia-500 via-violet-500 to-indigo-500",
  },
  amber: {
    grad: "from-amber-500/25 via-orange-500/15 to-yellow-500/10",
    ring: "border-amber-400/20",
    ringHover: "hover:border-amber-400/50",
    text: "text-amber-200",
    badge: "border-amber-400/30 bg-amber-500/10 text-amber-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(251,191,36,0.5)]",
    btn: "from-amber-400 via-orange-500 to-yellow-500",
  },
  emerald: {
    grad: "from-emerald-500/25 via-teal-500/15 to-cyan-500/10",
    ring: "border-emerald-400/20",
    ringHover: "hover:border-emerald-400/50",
    text: "text-emerald-200",
    badge: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(16,185,129,0.5)]",
    btn: "from-emerald-400 via-teal-500 to-cyan-500",
  },
  violet: {
    grad: "from-violet-500/25 via-indigo-500/15 to-fuchsia-500/10",
    ring: "border-violet-400/20",
    ringHover: "hover:border-violet-400/50",
    text: "text-violet-200",
    badge: "border-violet-400/30 bg-violet-500/10 text-violet-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(139,92,246,0.5)]",
    btn: "from-violet-500 via-indigo-500 to-fuchsia-500",
  },
  rose: {
    grad: "from-rose-500/25 via-pink-500/15 to-fuchsia-500/10",
    ring: "border-rose-400/20",
    ringHover: "hover:border-rose-400/50",
    text: "text-rose-200",
    badge: "border-rose-400/30 bg-rose-500/10 text-rose-200",
    glow: "hover:shadow-[0_18px_50px_-16px_rgba(244,63,94,0.5)]",
    btn: "from-rose-500 via-pink-500 to-fuchsia-500",
  },
};

const GRID_OVERLAY: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)",
  backgroundSize: "40px 40px",
  maskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
};

function formatRp(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

// Whole months saved paying yearly vs 12x monthly, from EFFECTIVE prices.
function saveMonthsFor(m: number | null, y: number | null): number {
  if (!m || !y) return 0;
  return Math.max(0, Math.round((m * 12 - y) / m));
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Public (not-logged-in) marketplace gates every action to login. After auth,
// land the user straight in the in-app Item Shop so the action they wanted is
// one tap away. Same component, same design/content — only the action target
// changes.
const PUBLIC_LOGIN_HREF = "/login?next=%2Fapp%2Fshop";
function gateToLogin(): void {
  if (typeof window !== "undefined") window.location.href = PUBLIC_LOGIN_HREF;
}

// ════════════════════════════════════════════════════════════════════════
export function ShopTab({
  publicMode = false,
  initialSection = "market",
}: {
  publicMode?: boolean;
  // Deep-link target resolved server-side from ?tab= (e.g. "langganan" from the
  // Riwayat "Perpanjang" button) — set as the initial section so there's no
  // hydration flash and no setState-in-effect.
  initialSection?: ShopSection;
}) {
  const { t } = useI18n();
  const d = t.app.shop.demo;
  const [section, setSection] = useState<ShopSection>(initialSection);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; event?: string } | null;
      if (data?.source === "agentbuff-billing" && data.event === "billing:settled") {
        setToast(d.toastPaid);
        setTimeout(() => setToast(null), 4000);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [d.toastPaid]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow="BuffHub Marketplace"
        title="Item Shop"
        subtitle={d.subtitle}
        actions={
          <div className="inline-flex items-center gap-0.5 rounded-xl border border-white/10 bg-black/30 p-1">
            <SectionToggle active={section === "market"} onClick={() => setSection("market")} icon={ShoppingBag} label={d.toggleMarketplace} />
            <SectionToggle active={section === "energy"} onClick={() => setSection("energy")} icon={Zap} label={d.toggleEnergy} />
            <SectionToggle active={section === "langganan"} onClick={() => setSection("langganan")} icon={Sparkles} label={d.toggleLangganan} />
          </div>
        }
      />

      <div className="scrollbar-slim relative min-h-0 flex-1 overflow-y-auto">
        {/* Ambient glow backdrop */}
        <div aria-hidden className="pointer-events-none absolute -left-40 top-0 size-[420px] rounded-full blur-[150px]" style={{ background: "radial-gradient(closest-side, rgba(34,211,238,0.16), transparent)" }} />
        <div aria-hidden className="pointer-events-none absolute -right-40 top-40 size-[460px] rounded-full blur-[170px]" style={{ background: "radial-gradient(closest-side, rgba(217,70,239,0.14), transparent)" }} />

        <div className="relative w-full px-4 py-6 sm:px-6 lg:px-8">
          {publicMode ? <PublicBrowseBanner className="mb-6" /> : null}
          {section === "market" ? (
            <MarketSection setToast={setToast} publicMode={publicMode} />
          ) : section === "energy" ? (
            <EnergySection />
          ) : (
            <SubscriptionSection publicMode={publicMode} />
          )}
        </div>
      </div>

      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="pointer-events-none fixed bottom-6 left-1/2 z-[80] -translate-x-1/2 rounded-xl border border-emerald-400/30 bg-[#0B0E14]/95 px-5 py-3 text-sm font-medium text-emerald-200 shadow-[0_20px_50px_-15px_rgba(16,185,129,0.5)] backdrop-blur-xl"
          >
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SectionToggle({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition",
        active ? "bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.3)]" : "text-white/55 hover:text-white",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

// ── Public browse banner (public marketplace only) ────────────────────────
function PublicBrowseBanner({ className }: { className?: string }) {
  const { t } = useI18n();
  const d = t.app.shop.demo;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/[0.08] via-cyan-500/[0.04] to-transparent px-5 py-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-xl" aria-hidden>🛍️</span>
        <div>
          <p className="font-display text-sm font-bold text-white">{d.publicBannerTitle}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-white/60">
            {d.publicBannerDesc}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={gateToLogin}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-500 px-4 py-2.5 text-sm font-bold text-[#0B0E14] transition hover:brightness-110 active:scale-[0.98]"
      >
        {d.publicBannerCta}
      </button>
    </div>
  );
}

// ── Marketplace section ──────────────────────────────────────────────────
type SortKey = "featured" | "priceAsc" | "priceDesc" | "name";

function MarketSection({ setToast, publicMode }: { setToast: (t: string | null) => void; publicMode: boolean }) {
  const { t, locale } = useI18n();
  const d = t.app.shop.demo;
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<"all" | ShopItem["category"]>("all");
  const [sort, setSort] = useState<SortKey>("featured");
  const [selected, setSelected] = useState<ShopItem | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);

  const handleBuy = useCallback(
    (slug: string) => {
      if (publicMode) { gateToLogin(); return; }
      openBillingPopup(`/billing/skill/${encodeURIComponent(slug)}`, "agentbuff-billing-skill");
    },
    [publicMode],
  );
  const handleWaitlist = useCallback(() => {
    if (publicMode) { gateToLogin(); return; }
    // No waitlist backend yet — don't promise we'll contact them. Honest
    // "coming soon" ack until a real waitlist (admin phase) exists.
    setToast(d.toastWaitlist);
  }, [publicMode, setToast, d.toastWaitlist]);

  useEffect(() => {
    // `alive` guards against the fetch race: on mount locale is the SSR default
    // "id", then it flips to the stored "en", re-running this effect. Without the
    // guard the stale "id" fetch could resolve last and overwrite the localized
    // "en" items. The superseded effect's cleanup sets alive=false first.
    let alive = true;
    fetch("/api/skills/buffhub", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { skills: ShopItem[] };
      })
      .then((res) => {
        if (alive) setItems(res.skills.map((s) => localizeSkill(s, locale)));
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : d.loadCatalogError);
      });
    return () => {
      alive = false;
    };
  }, [d.loadCatalogError, locale]);

  const featured = useMemo(() => (items ?? []).filter((i) => i.featured), [items]);

  // Hero auto-rotate
  useEffect(() => {
    if (featured.length < 2) return;
    const id = window.setInterval(() => setHeroIdx((i) => (i + 1) % featured.length), 5500);
    return () => window.clearInterval(id);
  }, [featured.length]);

  const categories = useMemo(() => {
    if (!items) return [];
    return Array.from(new Set(items.map((i) => i.category)));
  }, [items]);

  const visible = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    const base = items.filter((i) => {
      if (cat !== "all" && i.category !== cat) return false;
      if (!q) return true;
      return `${i.name} ${i.tagline} ${i.description} ${categoryLabel(d, i.category)}`.toLowerCase().includes(q);
    });
    return [...base].sort((a, b) => {
      switch (sort) {
        case "priceAsc": return a.priceRp - b.priceRp;
        case "priceDesc": return b.priceRp - a.priceRp;
        case "name": return a.name.localeCompare(b.name);
        case "featured":
        default: return (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
      }
    });
  }, [items, cat, query, sort, d]);

  if (err) {
    return <div className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-4 py-3 text-sm text-red-100">{err}</div>;
  }
  if (!items) {
    return (
      <div className="space-y-5">
        <div className="h-52 animate-pulse rounded-3xl border border-white/[0.06] bg-white/[0.03]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-72 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.03]" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      {featured.length > 0 ? (
        <ShopHero items={featured} idx={heroIdx} onIdx={setHeroIdx} onOpen={setSelected} />
      ) : null}

      {/* Info strip */}
      <div className="flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.04] via-indigo-500/[0.03] to-transparent px-4 py-3 text-[12px] text-white/75 backdrop-blur-md">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-cyan-300/85" aria-hidden />
        <p className="leading-relaxed">
          {d.infoStripPrefix}<strong className="text-white/90">{d.infoStripAllAgents}</strong>{d.infoStripMiddle}<strong className="text-white/90">{d.infoStripFree}</strong>{d.infoStripItemTagged}
          <span className="font-mono text-amber-200">{d.infoStripComingSoonTag}</span>{d.infoStripSuffix}
        </p>
      </div>

      {/* Search + sort */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={d.searchPlaceholder}
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] py-3 pl-11 pr-4 text-sm text-white placeholder:text-white/35 focus:border-cyan-400/40 focus:outline-none focus:ring-2 focus:ring-cyan-400/15"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs text-white/80 focus:border-cyan-400/40 focus:outline-none [color-scheme:dark]"
        >
          <option value="featured" className="bg-[#0B0E14]">{d.sortFeatured}</option>
          <option value="priceAsc" className="bg-[#0B0E14]">{d.sortPriceAsc}</option>
          <option value="priceDesc" className="bg-[#0B0E14]">{d.sortPriceDesc}</option>
          <option value="name" className="bg-[#0B0E14]">{d.sortName}</option>
        </select>
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap gap-2">
        <CatChip active={cat === "all"} onClick={() => setCat("all")} label={d.catAll} emoji="✨" />
        {categories.map((c) => (
          <CatChip key={c} active={cat === c} onClick={() => setCat(c)} label={categoryLabel(d, c)} emoji={CAT_EMOJI[c]} />
        ))}
      </div>

      {/* Results count */}
      <p className="text-xs text-white/45">
        <span className="font-semibold text-white/75">{visible.length}</span>{d.resultsSuffix}
      </p>

      {/* Grid */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-16 text-center">
          <p className="font-display text-lg font-bold text-white/85">{d.emptyTitle}</p>
          <p className="mt-1 text-sm text-white/50">{d.emptySubtitle}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((it, i) => (
            <ItemCard key={it.slug} item={it} index={i} onOpen={() => setSelected(it)} onBuy={() => handleBuy(it.slug)} onWaitlist={handleWaitlist} />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      <AnimatePresence>
        {selected ? (
          <ItemDrawer
            item={selected}
            onClose={() => setSelected(null)}
            onBuy={() => handleBuy(selected.slug)}
            onWaitlist={() => { setSelected(null); handleWaitlist(); }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const CAT_EMOJI: Record<ShopItem["category"], string> = {
  umkm: "🛒", creator: "🎨", produktivitas: "💼", operasional: "⚙️", riset: "🔭",
};

function CatChip({ active, onClick, label, emoji }: { active: boolean; onClick: () => void; label: string; emoji: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition",
        active
          ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100 shadow-[0_0_18px_-4px_rgba(34,211,238,0.5)]"
          : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white",
      )}
    >
      <span aria-hidden>{emoji}</span>
      {label}
    </button>
  );
}

// Marketplace cover art (real product images, public/images/shop/<slug>.webp).
// Falls back to coverEmoji for any slug without an image, so partial sets work.
const SHOP_COVER_SLUGS = new Set([
  "cs-toko-autopilot",
  "pencatat-keuangan",
  "researcher-analyst",
  "business-builder",
  "marketing-content",
  "pos-umkm",
  "manajemen-kos",
  "absensi-karyawan",
]);
function coverImage(slug: string): string | null {
  return SHOP_COVER_SLUGS.has(slug) ? `/images/shop/${slug}.webp` : null;
}

// ── Hero carousel ────────────────────────────────────────────────────────
function ShopHero({ items, idx, onIdx, onOpen }: { items: ShopItem[]; idx: number; onIdx: (i: number) => void; onOpen: (it: ShopItem) => void }) {
  const { t } = useI18n();
  const d = t.app.shop.demo;
  const active = items[idx % items.length];
  const a = ACCENT[active.accent];
  const cover = coverImage(active.slug);
  const go = (d: number) => onIdx((idx + d + items.length) % items.length);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10">
      <div className={cn("relative aspect-[16/9] bg-gradient-to-br sm:aspect-[21/9]", a.grad)}>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{ ...GRID_OVERLAY, backgroundSize: "56px 56px" }} />
        <AnimatePresence mode="wait">
          <motion.div
            key={active.slug}
            initial={{ opacity: 0, scale: 1.02 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
            className="absolute inset-0 flex items-center px-6 sm:px-10"
          >
            {cover ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cover} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-center" />
                <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-[#0B0E14]/95 via-[#0B0E14]/45 to-transparent" />
                <div aria-hidden className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0B0E14]/70 to-transparent" />
              </>
            ) : null}
            <div className="relative z-10 max-w-[62%]">
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]", a.badge)}>
                {active.status === "coming_soon" ? <><Clock className="size-2.5" /> {d.heroComingSoon}</> : d.heroFeatured}
              </span>
              <h2 className="mt-2.5 font-display text-2xl font-black leading-tight sm:text-4xl">{active.name}</h2>
              <p className="mt-2 max-w-md text-sm text-white/70">{active.tagline}</p>
              <button
                type="button"
                onClick={() => onOpen(active)}
                className={cn("mt-4 inline-flex items-center gap-2 rounded-full border bg-white/10 px-4 py-2 text-sm font-bold backdrop-blur-md transition hover:bg-white/15", a.badge)}
              >
                {d.heroViewDetail}
              </button>
            </div>
            {!cover ? (
              <div className="pointer-events-none absolute right-[5%] top-1/2 -translate-y-1/2">
                <motion.span
                  animate={{ y: [0, -12, 0], rotate: [0, -3, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  className="text-[120px] drop-shadow-[0_18px_50px_rgba(0,0,0,0.45)] sm:text-[180px]"
                >
                  {active.coverEmoji}
                </motion.span>
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>

        {items.length > 1 ? (
          <>
            <button type="button" aria-label={d.heroPrev} onClick={() => go(-1)} className="absolute left-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/30 text-white/80 backdrop-blur-md hover:border-white/30 hover:text-white">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" aria-label={d.heroNext} onClick={() => go(1)} className="absolute right-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/30 text-white/80 backdrop-blur-md hover:border-white/30 hover:text-white">
              <ChevronRight className="size-4" />
            </button>
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5">
              {items.map((_, i) => (
                <button key={i} type="button" aria-label={`${d.heroSlideLabel} ${i + 1}`} onClick={() => onIdx(i)} className={cn("h-1.5 rounded-full transition-all", i === idx % items.length ? "w-7 bg-white/90" : "w-1.5 bg-white/30 hover:bg-white/50")} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Item card ────────────────────────────────────────────────────────────
function ItemCard({ item, index, onOpen, onBuy, onWaitlist }: { item: ShopItem; index: number; onOpen: () => void; onBuy: () => void; onWaitlist: () => void }) {
  const { t } = useI18n();
  const d = t.app.shop.demo;
  const a = ACCENT[item.accent];
  const Icon = ICONS[item.icon] ?? Sparkles;
  const comingSoon = item.status === "coming_soon";
  const cover = coverImage(item.slug);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay: Math.min(index * 0.04, 0.4), ease: "easeOut" }}
      whileHover={{ y: -3 }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-[#0B0E14]/60 text-left backdrop-blur-xl transition-all",
        a.ring, a.ringHover, a.glow,
      )}
    >
      {/* Body opens the drawer — one real button, no interactive nesting. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${d.cardViewDetailAria} ${item.name}`}
        className="block w-full cursor-pointer text-left"
      >
      {/* Cover */}
      <div className={cn("relative aspect-[16/9] overflow-hidden bg-gradient-to-br", a.grad)}>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.10]" style={GRID_OVERLAY} />
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" aria-hidden loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.05]" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.span whileHover={{ scale: 1.06, rotate: 2 }} transition={{ type: "spring", stiffness: 220, damping: 18 }} className="text-[64px] drop-shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
              {item.coverEmoji}
            </motion.span>
          </div>
        )}
        {item.featured ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#0B0E14]">
            {d.cardFeatured}
          </span>
        ) : null}
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/80 backdrop-blur-md">
          {unlockLabel(d, item.unlock)}
        </span>
      </div>

      {/* Body */}
      <div className="p-4">
        <div className="flex items-center gap-2">
          <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05]", a.text)}>
            <Icon className="size-3.5" aria-hidden />
          </div>
          <h3 className="min-w-0 flex-1 truncate font-display text-base font-black text-white">{item.name}</h3>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs text-white/55">{item.tagline}</p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider", a.badge)}>{categoryLabel(d, item.category)}</span>
          {item.byok ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-indigo-400/30 bg-indigo-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-indigo-200">
              <KeyRound className="size-2.5" /> BYOK
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="font-display text-lg font-black text-white">{formatRp(item.priceRp)}</span>
          {comingSoon ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200">
              <Clock className="size-2.5" /> {d.cardComingSoon}
            </span>
          ) : null}
        </div>
      </div>
      </button>

      {/* Hover/focus CTA — sibling of the body button (not nested). */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 p-3 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => (comingSoon ? onWaitlist() : onBuy())}
          className={cn(
            "pointer-events-auto w-full rounded-xl px-3 py-2.5 text-xs font-bold backdrop-blur-md transition",
            comingSoon
              ? "border border-amber-400/30 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25"
              : cn("bg-gradient-to-r text-[#0B0E14] hover:brightness-110", a.btn),
          )}
        >
          {comingSoon ? d.ctaWaitlist : d.ctaBuyNow}
        </button>
      </div>
    </motion.div>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────
function ItemDrawer({ item, onClose, onBuy, onWaitlist }: { item: ShopItem; onClose: () => void; onBuy: () => void; onWaitlist: () => void }) {
  const { t } = useI18n();
  const d = t.app.shop.demo;
  const a = ACCENT[item.accent];
  const Icon = ICONS[item.icon] ?? Sparkles;
  const comingSoon = item.status === "coming_soon";
  const cover = coverImage(item.slug);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <motion.div role="dialog" aria-modal="true" aria-labelledby="item-drawer-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="fixed inset-0 z-[70] flex">
      <button type="button" aria-label={d.drawerDialogClose} onClick={onClose} className="absolute inset-0 bg-[#030014]/70 backdrop-blur-md" />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 320, damping: 36 }}
        className="relative z-10 ml-auto flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-white/10 bg-[#0B0E14] shadow-[-40px_0_120px_-40px_rgba(0,0,0,0.8)]"
      >
        <div className="scrollbar-slim flex-1 overflow-y-auto pb-32">
          {/* Banner */}
          <div className={cn("relative aspect-[16/9] overflow-hidden bg-gradient-to-br", a.grad)}>
            <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12]" style={{ ...GRID_OVERLAY, backgroundSize: "48px 48px" }} />
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.span animate={{ y: [0, -8, 0] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }} className="text-[88px] drop-shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                  {item.coverEmoji}
                </motion.span>
              </div>
            )}
            <button type="button" onClick={onClose} aria-label={d.drawerCloseAria} className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur-md hover:border-white/30 hover:text-white">
              <X className="size-4" />
            </button>
            <span className={cn("absolute left-4 top-4 rounded-full border px-3 py-1 text-[11px] font-bold backdrop-blur-md", a.badge)}>{categoryLabel(d, item.category)}</span>
          </div>

          {/* Body */}
          <div className="px-5 pt-5 sm:px-7">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-semibold text-white/70">
                <span className={a.text}><Icon className="size-3" aria-hidden /></span>
                {unlockLabel(d, item.unlock)}
              </span>
              {item.byok ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 font-semibold text-indigo-200">
                  <KeyRound className="size-3" /> BYOK
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-semibold text-white/60">{d.drawerOneTime}</span>
              {comingSoon ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-200">
                  <Clock className="size-3" /> {d.drawerComingSoon}
                </span>
              ) : null}
            </div>

            <h2 id="item-drawer-title" className="mt-3 font-display text-3xl font-black leading-tight">{item.name}</h2>
            <p className="mt-1 text-sm text-white/60">{item.tagline}</p>

            <section className="mt-6">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white/70">{d.drawerAbout}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/65">{item.description}</p>
            </section>

            <section className="mt-6">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white/70">{d.drawerCapabilities}</h3>
              <ul className="mt-3 grid gap-2.5">
                {item.capabilities.map((cap, i) => (
                  <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }} className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-300">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    <span className="text-sm text-white/80">{cap}</span>
                  </motion.li>
                ))}
              </ul>
            </section>

            {comingSoon ? (
              <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3 text-[12px] leading-relaxed text-amber-100/90">
                {d.drawerComingSoonNotePrefix}<strong>{d.drawerComingSoonNoteBold}</strong>{d.drawerComingSoonNoteSuffix}
              </div>
            ) : null}
          </div>
        </div>

        {/* Sticky action bar */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0B0E14] via-[#0B0E14]/95 to-transparent pt-8">
          <div className="pointer-events-auto border-t border-white/10 bg-[#0B0E14]/95 px-5 py-4 backdrop-blur-xl sm:px-7">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">{d.drawerPriceLabel}</span>
              <span className="font-display text-xl font-black text-white">{formatRp(item.priceRp)}</span>
            </div>
            <button
              type="button"
              onClick={() => comingSoon ? onWaitlist() : onBuy()}
              className={cn(
                "w-full rounded-xl px-5 py-3.5 text-sm font-bold transition",
                comingSoon
                  ? "border border-amber-400/40 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25"
                  : cn("bg-gradient-to-r text-[#0B0E14] hover:brightness-110", a.btn),
              )}
            >
              {comingSoon ? d.drawerCtaWaitlist : `${d.drawerCtaBuyPrefix}${formatRp(item.priceRp)}`}
            </button>
          </div>
        </div>
      </motion.aside>
    </motion.div>
  );
}

// ── Energy section ──────────────────────────────────────────────────────
function EnergySection() {
  // Energy / konversi token / top-up = skema MASA DEPAN (no-BYOK).
  // SAAT INI AgentBuff full BYOK: user bawa API key + model sendiri, jadi kita
  // TIDAK menjual energy (gak ngonversi token jadi saldo). Section ini sengaja
  // ditampilkan sebagai "Segera Hadir" — jangan jual barang kosong.
  // Chief 2026-06-02.
  const { t } = useI18n();
  const d = t.app.shop.demo;
  const perks = [
    { emoji: "🔑", title: d.energyPerk1Title, desc: d.energyPerk1Desc },
    { emoji: "⚡", title: d.energyPerk2Title, desc: d.energyPerk2Desc },
    { emoji: "🔄", title: d.energyPerk3Title, desc: d.energyPerk3Desc },
    { emoji: "🛒", title: d.energyPerk4Title, desc: d.energyPerk4Desc },
  ];
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-gradient-to-br from-amber-500/[0.05] to-transparent px-4 py-3 text-[12px] text-white/75 backdrop-blur-md">
        <Zap className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        <p className="leading-relaxed">
          {d.energyInfoPrefix}<strong className="text-white/90">{d.energyInfoByok}</strong>{d.energyInfoMiddle}<strong className="text-white/90">{d.energyInfoEnergy}</strong>{d.energyInfoSuffix}
        </p>
      </div>

      <div className="relative overflow-hidden rounded-3xl border border-amber-400/25 bg-gradient-to-br from-amber-500/[0.07] via-orange-500/[0.03] to-transparent p-8 text-center">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-[280px] rounded-full blur-[120px]" style={{ background: "radial-gradient(closest-side, rgba(251,191,36,0.22), transparent)" }} />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-amber-200">
            <Clock className="size-3" aria-hidden /> {d.energyComingSoon}
          </span>
          <div className="mx-auto mt-5 flex size-16 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-amber-400/20 to-orange-500/20 text-3xl">⚡</div>
          <h3 className="mt-4 font-display text-xl font-black text-white">{d.energyTitle}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-white/60">
            {d.energyDescPrefix}
            <span className="text-amber-200">{d.energyDescEnergy}</span>{d.energyDescSuffix}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {perks.map((p) => (
          <div key={p.title} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <span className="text-2xl" aria-hidden>{p.emoji}</span>
            <div>
              <h4 className="font-display text-sm font-bold text-white">{p.title}</h4>
              <p className="mt-0.5 text-[12px] leading-relaxed text-white/55">{p.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Subscription section ────────────────────────────────────────────────
// Tier emoji is presentational only (not in i18n) — kept here to preserve the
// in-app card visual. Keys mirror PlanTier exactly.
const TIER_EMOJI: Record<PlanTier, string> = {
  starter: "🎁",
  op_buff: "👑",
  full_managed: "🚀",
  guild_master: "🏆",
};

function SubscriptionSection({ publicMode }: { publicMode: boolean }) {
  const { t } = useI18n();
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  // Early-access waitlist (Full Managed "Segera Hadir") — opens the SAME modal
  // the landing page uses, in-app, instead of bouncing to the landing page.
  const [earlyAccessOpen, setEarlyAccessOpen] = useState(false);

  // Already-subscribed gate: in public mode there's no session, so skip the
  // query (it would 401). In-app reads the user's current tier + status.
  const { data: subState } = useSubscriptionState();
  const { data: profile } = useProfile();
  // Admin-effective price/status (placeholderData = static catalog).
  const { data: pricingData } = usePricing();
  const pricing = pricingData?.plans;
  const isSubscribed =
    !publicMode && subState?.status === "active" && subState.tier !== "starter";
  const activeTier = isSubscribed && subState ? subState.tier : null;
  const trialDays = profile?.trial?.daysLeft ?? 0;
  const trialActive =
    !publicMode &&
    !isSubscribed &&
    profile?.trial?.status === "active" &&
    trialDays > 0;
  // The free Starter tier shows ONLY to an active-trial user (or the public
  // acquisition view). Once subscribed — or trial ended, or ever subscribed —
  // the free trial is gone and the card disappears.
  const visiblePlans = PLANS_ORDERED.filter(
    (p) => p.tier !== "starter" || publicMode || trialActive,
  );

  const subscribe = useCallback(() => {
    if (publicMode) { gateToLogin(); return; }
    openBillingPopup(`/checkout?cycle=${cycle}`, "agentbuff-billing-subscription");
  }, [publicMode, cycle]);

  return (
    <div className="space-y-5">
      <div className="inline-flex items-center gap-0.5 rounded-xl border border-white/10 bg-black/30 p-1">
        <button type="button" onClick={() => setCycle("monthly")} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition", cycle === "monthly" ? "bg-fuchsia-400/15 text-fuchsia-100 shadow-[inset_0_0_0_1px_rgba(217,70,239,0.3)]" : "text-white/55 hover:text-white")}>{t.plans.monthly}</button>
        <button type="button" onClick={() => setCycle("yearly")} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition", cycle === "yearly" ? "bg-fuchsia-400/15 text-fuchsia-100 shadow-[inset_0_0_0_1px_rgba(217,70,239,0.3)]" : "text-white/55 hover:text-white")}>{t.plans.yearly} <span className="text-emerald-300">{t.plans.yearlySaveTag}</span></button>
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2",
          visiblePlans.length >= 4 ? "xl:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        {visiblePlans.map((plan) => {
          const eff = pricing?.[plan.tier] ?? plan;
          return (
          <SubscriptionCard
            key={plan.tier}
            tier={plan.tier}
            status={eff.status}
            priceMonthly={eff.priceMonthly}
            priceYearly={eff.priceYearly}
            badge={plan.badge}
            highlighted={plan.highlighted}
            ctaKind={plan.ctaKind}
            externalUrl={plan.externalUrl}
            cycle={cycle}
            isActiveTier={activeTier === plan.tier}
            trialActive={plan.tier === "starter" && trialActive}
            trialDays={trialDays}
            expiresAt={isSubscribed ? (subState?.expiresAt ?? null) : null}
            billingCycle={isSubscribed ? (subState?.billingCycle ?? null) : null}
            onSubscribe={subscribe}
            onEarlyAccess={() => setEarlyAccessOpen(true)}
          />
          );
        })}
      </div>

      <EarlyAccessModal
        open={earlyAccessOpen}
        onClose={() => setEarlyAccessOpen(false)}
        tier="full-managed"
      />
    </div>
  );
}

function SubscriptionCard({
  tier,
  status,
  priceMonthly,
  priceYearly,
  badge,
  highlighted,
  ctaKind,
  externalUrl,
  cycle,
  isActiveTier,
  trialActive,
  trialDays,
  expiresAt,
  billingCycle,
  onSubscribe,
  onEarlyAccess,
}: {
  tier: PlanTier;
  status: "free" | "live" | "coming_soon" | "enterprise";
  priceMonthly: number | null;
  priceYearly: number | null;
  badge: "popular" | "coming_soon" | "enterprise" | null;
  highlighted: boolean;
  ctaKind: "current" | "subscribe" | "early_access" | "external";
  externalUrl?: string;
  cycle: "monthly" | "yearly";
  isActiveTier: boolean;
  trialActive: boolean;
  trialDays: number;
  expiresAt: string | null;
  billingCycle: "monthly" | "yearly" | null;
  onSubscribe: () => void;
  onEarlyAccess: () => void;
}) {
  const { t } = useI18n();
  const copy = t.plans.tiers[tier];
  const sc = t.app.riwayat.statusCard;

  // Price display: free → "Gratis"; enterprise (no price) → "Custom";
  // everything else → formatted Rupiah for the active cycle.
  const hasPrice = status !== "free" && status !== "enterprise";
  const price = hasPrice
    ? ((cycle === "yearly" ? priceYearly : priceMonthly) ?? 0)
    : 0;
  const saveMonths = cycle === "yearly" ? saveMonthsFor(priceMonthly, priceYearly) : 0;

  // The owned tier suppresses its marketing badge — the AKTIF ribbon takes over.
  const badgeNode = isActiveTier
    ? null
    : badge === "popular" ? (
      <span className="ml-auto rounded-full bg-gradient-to-r from-fuchsia-400 to-cyan-400 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-[#0B0E14]">{t.plans.badge.popular}</span>
    ) : badge === "coming_soon" ? (
      <span className="ml-auto rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-200">{t.plans.badge.comingSoon}</span>
    ) : badge === "enterprise" ? (
      <span className="ml-auto rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-cyan-200">{t.plans.badge.enterprise}</span>
    ) : null;

  return (
    <div className={cn(
      "relative flex flex-col gap-3 overflow-hidden rounded-2xl border p-5 transition",
      isActiveTier
        ? "border-emerald-400/60 bg-gradient-to-br from-emerald-500/[0.15] via-emerald-500/[0.05] to-transparent shadow-[0_0_44px_-8px_rgba(16,185,129,0.6)] ring-1 ring-emerald-400/40"
        : highlighted
          ? "border-fuchsia-400/40 bg-gradient-to-br from-fuchsia-500/[0.08] via-indigo-500/[0.04] to-transparent hover:-translate-y-0.5 hover:shadow-[0_18px_50px_-16px_rgba(217,70,239,0.5)]"
          : "border-white/10 bg-white/[0.03] hover:-translate-y-0.5 hover:border-white/20",
    )}>
      {isActiveTier ? (
        <div className="-mx-5 -mt-5 mb-1 flex items-center gap-1.5 bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#0B0E14]">
          <Check className="size-3.5" strokeWidth={3} aria-hidden /> {sc.statusActive}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-2xl" aria-hidden>{TIER_EMOJI[tier]}</span>
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-black text-white">{copy.name}</h3>
          <p className="text-[11px] text-white/55">{copy.tagline}</p>
        </div>
        {badgeNode}
      </div>

      {status === "free" ? (
        <div className="flex items-baseline gap-1">
          <span className="font-display text-2xl font-black text-white">{t.plans.free}</span>
        </div>
      ) : status === "enterprise" ? (
        <div className="flex items-baseline gap-1">
          <span className="font-display text-2xl font-black text-white/80">{t.plans.custom}</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
          <span className="font-display text-2xl font-black text-white">{formatRp(price)}</span>
          <span className="text-[11px] text-white/45">{cycle === "monthly" ? t.plans.perMonth : t.plans.perYear}</span>
          {saveMonths > 0 ? (
            <span className="ml-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">{t.plans.saveMonthsPrefix}{saveMonths} {t.plans.saveMonthsSuffix}</span>
          ) : null}
        </div>
      )}

      {isActiveTier && expiresAt ? (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-2 text-[11px] font-semibold text-emerald-200">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          <span>{sc.activeUntil} {formatShortDate(expiresAt)}</span>
          <span className="text-emerald-300/60">· {(billingCycle ?? cycle) === "yearly" ? sc.cycleYearly : sc.cycleMonthly}</span>
        </div>
      ) : null}

      <ul className="flex-1 space-y-1.5">
        {copy.features.map((f) => <li key={f} className="flex items-start gap-2 text-[12px] text-white/70"><span className="mt-0.5 text-emerald-400">✓</span>{f}</li>)}
      </ul>

      <SubscriptionCta
        ctaKind={ctaKind}
        externalUrl={externalUrl}
        tierName={copy.name}
        highlighted={highlighted}
        isActiveTier={isActiveTier}
        canRenew={isActiveTier && isSubscribableTier(tier)}
        trialActive={trialActive}
        trialDays={trialDays}
        onSubscribe={onSubscribe}
        onEarlyAccess={onEarlyAccess}
      />
    </div>
  );
}

function SubscriptionCta({
  ctaKind,
  externalUrl,
  tierName,
  highlighted,
  isActiveTier,
  canRenew,
  trialActive,
  trialDays,
  onSubscribe,
  onEarlyAccess,
}: {
  ctaKind: "current" | "subscribe" | "early_access" | "external";
  externalUrl?: string;
  tierName: string;
  highlighted: boolean;
  isActiveTier: boolean;
  canRenew: boolean;
  trialActive: boolean;
  trialDays: number;
  onSubscribe: () => void;
  onEarlyAccess: () => void;
}) {
  const { t } = useI18n();
  const sc = t.app.riwayat.statusCard;

  // Already-subscribed gate: the tier the user owns shows a bold, filled
  // "Paket Aktif" affordance so the active state is unmistakable. A self-serve
  // tier (op_buff) ALSO gets a "Perpanjang" button — the only sanctioned way to
  // pay again (extends the current period; settle.ts stacks the time). onSubscribe
  // opens /checkout, which renders in renewal mode for an active subscriber.
  if (isActiveTier) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/50 bg-gradient-to-r from-emerald-500/25 to-cyan-500/15 py-2.5 text-sm font-black text-emerald-100">
          <Check className="size-4" strokeWidth={3} aria-hidden /> {t.plans.cta.active}
        </div>
        {canRenew ? (
          <button
            type="button"
            onClick={onSubscribe}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/[0.08] py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/15"
          >
            {t.plans.cta.renew}
          </button>
        ) : null}
      </div>
    );
  }

  // Free/starter tier — status badge, not a buy button. The card only renders
  // for an active-trial user, so surface the remaining trial days here.
  if (ctaKind === "current") {
    return (
      <div className="flex items-center justify-center gap-1.5 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] py-2.5 text-[12px] font-semibold text-cyan-200">
        <Sparkles className="size-3.5" aria-hidden />
        {trialActive
          ? `${t.plans.cta.current} · ${sc.trialRemainingPrefix} ${trialDays} ${sc.trialDaysSuffix}`
          : t.plans.cta.current}
      </div>
    );
  }

  // Coming-soon (early access) — open the in-app early-access waitlist modal
  // (same form the landing page uses, posts to /api/early-access). It's a public
  // lead form, so it works in both in-app and public-marketplace mode.
  if (ctaKind === "early_access") {
    return (
      <button
        type="button"
        onClick={onEarlyAccess}
        className="rounded-lg border border-amber-400/30 bg-amber-400/10 py-2.5 text-sm font-bold text-amber-100 transition hover:bg-amber-400/20"
      >
        {t.plans.cta.earlyAccess}
      </button>
    );
  }

  // Enterprise — open the external sales site.
  if (ctaKind === "external") {
    return (
      <button
        type="button"
        onClick={() => { if (externalUrl) window.open(externalUrl, "_blank", "noopener,noreferrer"); }}
        className="rounded-lg border border-white/15 bg-white/[0.04] py-2.5 text-sm font-bold text-white transition hover:bg-white/[0.08]"
      >
        {t.plans.cta.enterprise}
      </button>
    );
  }

  // Self-serve subscribe (op_buff).
  return (
    <button
      type="button"
      onClick={onSubscribe}
      className={cn("rounded-lg py-2.5 text-sm font-bold transition", highlighted ? "bg-gradient-to-r from-fuchsia-500 via-indigo-500 to-cyan-400 text-[#0B0E14] hover:brightness-110" : "border border-white/15 bg-white/[0.04] text-white hover:bg-white/[0.08]")}
    >
      {t.plans.cta.choosePrefix} {tierName}
    </button>
  );
}
