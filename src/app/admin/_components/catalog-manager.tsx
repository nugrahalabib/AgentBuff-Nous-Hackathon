"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Package, Plus, Sparkles, Star } from "lucide-react";
import {
  apiFetch,
  Badge,
  Combobox,
  ConfirmDialog,
  CurrencyField,
  DataTable,
  EmptyState,
  errorToBahasa,
  FormRow,
  MultiSelectChips,
  Section,
  Select,
  SegmentedControl,
  StatusBadge,
  Toggle,
  useAdminMutation,
  useAdminQuery,
  type Column,
  type Option,
  type StatusMap,
} from "./ui";

// D13 — first-party catalog editor (BuffHub). Full CRUD over skill_catalog: the 8
// seed items live in the DB now, admin owns title/copy/price/status/etc. without a
// redeploy. status drives the Shop Buy-vs-"Segera Hadir" gate + checkout.

type Catalog = {
  key: string;
  title: string;
  tagline: string;
  description: string;
  priceRp: number;
  category: string;
  icon: string;
  unlock: string;
  status: "available" | "coming_soon";
  byok?: boolean;
  billing: string;
  source: string;
  version?: string;
  coverEmoji: string;
  accent: string;
  featured?: boolean;
  capabilities: string[];
};

// --- Enum -> friendly option lists (values match the API zod schema exactly) ---

const CATEGORY_OPTS: Option[] = [
  { value: "umkm", label: "UMKM", hint: "Untuk pelaku usaha kecil" },
  { value: "creator", label: "Creator", hint: "Untuk content creator" },
  { value: "produktivitas", label: "Produktivitas", hint: "Bantu kerja harian" },
  { value: "operasional", label: "Operasional", hint: "Otomasi operasional bisnis" },
  { value: "riset", label: "Riset", hint: "Analisis & riset" },
];

const UNLOCK_OPTS: Option[] = [
  { value: "skill", label: "Skill", hint: "kemampuan agen" },
  { value: "tool", label: "Tool", hint: "alat tunggal" },
  { value: "plugin", label: "Plugin", hint: "ekstensi engine" },
  { value: "connector", label: "Connector", hint: "sambungan app" },
  { value: "app", label: "App", hint: "aplikasi MCP penuh" },
];

const BILLING_OPTS: Option[] = [
  { value: "one_time", label: "Sekali bayar", hint: "Bayar sekali, langsung punya" },
  { value: "subscription", label: "Langganan", hint: "Tagihan berulang" },
];

const SOURCE_OPTS: Option[] = [
  { value: "clawhub", label: "ClawHub", hint: "ambil dari registry (slug)" },
  { value: "direct", label: "Direct", hint: "install spec sendiri" },
];

const ACCENT_OPTS: { value: string; label: string; swatch: string }[] = [
  { value: "cyan", label: "Cyan", swatch: "bg-cyan-400" },
  { value: "fuchsia", label: "Fuchsia", swatch: "bg-fuchsia-500" },
  { value: "amber", label: "Amber", swatch: "bg-amber-400" },
  { value: "emerald", label: "Emerald", swatch: "bg-emerald-400" },
  { value: "violet", label: "Violet", swatch: "bg-violet-400" },
  { value: "rose", label: "Rose", swatch: "bg-rose-400" },
];

// A small curated lucide list for the picker (allowCustom keeps any valid name).
const ICON_OPTS: Option[] = [
  { value: "Package", label: "Package" },
  { value: "Bot", label: "Bot" },
  { value: "MessageSquare", label: "MessageSquare" },
  { value: "ShoppingBag", label: "ShoppingBag" },
  { value: "TrendingUp", label: "TrendingUp" },
  { value: "Sparkles", label: "Sparkles" },
  { value: "Brain", label: "Brain" },
  { value: "FileText", label: "FileText" },
  { value: "Image", label: "Image" },
  { value: "Mic", label: "Mic" },
  { value: "Calendar", label: "Calendar" },
  { value: "Mail", label: "Mail" },
  { value: "Database", label: "Database" },
  { value: "Search", label: "Search" },
  { value: "Zap", label: "Zap" },
];

const STATUS_MAP: StatusMap = {
  available: { tone: "ok", label: "Aktif jual", hint: "Langsung bisa dibeli" },
  coming_soon: { tone: "warn", label: "Segera hadir", hint: "Tampil 'Segera Hadir', checkout menolak" },
};

const STATUS_OPTS: Option[] = [
  { value: "available", label: "Aktif jual", hint: "Langsung bisa dibeli" },
  { value: "coming_soon", label: "Segera hadir", hint: "Tampil 'Segera Hadir', checkout menolak" },
];

const PRICE_CEILING = 100_000_000;
const PRICE_STEP = 10_000;
const PRICE_PRESETS = [0, 49_000, 99_000, 149_000];
const CAPS_MAX = 12;
const CAP_MAX_LEN = 160;
const TITLE_MAX = 80;
const TAGLINE_MAX = 120;
const DESC_MAX = 2000;
const VERSION_MAX = 40;
const KEY_MAX = 60;

const ADMIN_QUERY_KEY = ["admin", "catalog"] as const;

const fmtRp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX);

const accentSwatch = (accent: string) =>
  ACCENT_OPTS.find((a) => a.value === accent)?.swatch ?? "bg-cyan-400";

const emptyCatalog = (): Catalog => ({
  key: "",
  title: "",
  tagline: "",
  description: "",
  priceRp: 0,
  category: "umkm",
  icon: "Package",
  unlock: "connector",
  status: "coming_soon",
  byok: false,
  billing: "one_time",
  source: "direct",
  version: "",
  coverEmoji: "📦",
  accent: "cyan",
  featured: false,
  capabilities: [],
});

export function CatalogManager() {
  const { data, isLoading, isError, refetch } = useAdminQuery<{ items: Catalog[] }>(
    ADMIN_QUERY_KEY,
    "/api/admin/catalog",
  );

  const [editing, setEditing] = useState<Catalog | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Catalog | null>(null);

  const remove = useAdminMutation<Catalog>(
    (entry) => apiFetch(`/api/admin/catalog/${entry.key}`, { method: "DELETE" }),
    {
      successMessage: "Item dihapus.",
      invalidate: [ADMIN_QUERY_KEY],
      onSuccess: () => setConfirmDelete(null),
    },
  );

  const existingKeys = useMemo(
    () => new Set((data?.items ?? []).map((c) => c.key)),
    [data],
  );

  const columns: Column<Catalog>[] = [
    {
      key: "item",
      header: "Item",
      cell: (c) => (
        <div className="flex items-center gap-2">
          <span className="text-base">{c.coverEmoji}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-zinc-200">
              <span className="truncate">{c.title}</span>
              {c.featured ? <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" /> : null}
            </div>
            <div className="font-mono text-[10px] text-zinc-500">{c.key}</div>
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Kategori",
      cell: (c) => (
        <span className="text-zinc-400">
          {CATEGORY_OPTS.find((o) => o.value === c.category)?.label ?? c.category}
        </span>
      ),
    },
    { key: "price", header: "Harga", align: "right", cell: (c) => <span className="tabular-nums text-zinc-300">{fmtRp(c.priceRp)}</span> },
    { key: "status", header: "Status", cell: (c) => <StatusBadge value={c.status} map={STATUS_MAP} /> },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (c) => (
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setEditing(c)}
            className="text-zinc-300 transition hover:text-cyan-300"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(c)}
            className="text-red-400 transition hover:text-red-300"
          >
            Hapus
          </button>
        </div>
      ),
    },
  ];

  if (editing) {
    return (
      <CatalogForm
        entry={editing === "new" ? null : editing}
        existingKeys={existingKeys}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  }

  return (
    <Section
      title="Katalog 1P (BuffHub)"
      desc="Etalase produk first-party yang dijual di Shop. Aktif jual = bisa dibeli; Segera hadir = checkout menolak. Jangan set Aktif jual sebelum web app + MCP-nya live."
      actions={
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
        >
          <Plus className="size-4" /> Item
        </button>
      }
    >
      {isError ? (
        <EmptyState
          icon={<Package className="size-8" />}
          title="Gagal memuat katalog."
          body="Periksa koneksi lalu coba lagi."
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-800"
            >
              Coba lagi
            </button>
          }
        />
      ) : (
        <DataTable<Catalog>
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(c) => c.key}
          isLoading={isLoading}
          empty={
            <EmptyState
              icon={<Package className="size-8" />}
              title="Belum ada produk."
              body="Mulai isi etalase BuffHub."
              action={
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
                >
                  <Plus className="size-4" /> Item
                </button>
              }
            />
          }
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        danger
        title="Hapus item katalog?"
        body={
          confirmDelete ? (
            <>
              Hapus item <span className="font-medium text-zinc-200">{confirmDelete.title}</span> ({confirmDelete.key})?
              Tindakan ini tidak bisa dibatalkan.
            </>
          ) : null
        }
        summary={
          confirmDelete
            ? [
                { label: "Key", value: confirmDelete.key },
                { label: "Harga", value: fmtRp(confirmDelete.priceRp) },
                {
                  label: "Status",
                  value: STATUS_MAP[confirmDelete.status]?.label ?? confirmDelete.status,
                  tone: STATUS_MAP[confirmDelete.status]?.tone,
                },
              ]
            : undefined
        }
        confirmLabel="Hapus permanen"
        loading={remove.isPending}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </Section>
  );
}

// --- Live preview card (mirrors the Shop card so admin never edits blind) ---

function PreviewCard({ f }: { f: Catalog }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
      <div className={`h-1 w-full ${accentSwatch(f.accent)}`} />
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-2xl">{f.coverEmoji || "📦"}</span>
          {f.featured ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/25">
              <Star className="size-2.5 fill-amber-400 text-amber-400" /> Trending
            </span>
          ) : null}
        </div>
        <div>
          <h3 className="text-base font-semibold text-zinc-100">
            {f.title || <span className="text-zinc-600">Judul produk…</span>}
          </h3>
          <p className="text-xs text-zinc-400">
            {f.tagline || <span className="text-zinc-600">Tagline singkat…</span>}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-sm font-semibold tabular-nums text-zinc-100">
            {f.priceRp === 0 ? "Gratis" : fmtRp(f.priceRp)}
          </span>
          <StatusBadge value={f.status} map={STATUS_MAP} />
        </div>
        {f.byok ? (
          <Badge tone="info">BYOK</Badge>
        ) : null}
      </div>
    </div>
  );
}

// --- Go-live checklist gate (replaces the ignorable yellow banner) ---

function GoLiveDialog({
  open,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [webLive, setWebLive] = useState(false);
  const [mcpTested, setMcpTested] = useState(false);
  // Reset checks each time the dialog opens (adjust-state-during-render pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setWebLive(false);
      setMcpTested(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Aktifkan jual sekarang?"
      body={
        <div className="space-y-3">
          <p>
            Status &ldquo;Aktif jual&rdquo; membuat item langsung bisa dibeli. Centang kedua syarat ini
            dulu — Simpan terkunci sampai keduanya benar.
          </p>
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <Toggle checked={webLive} onChange={setWebLive} label="Web app produk sudah live" />
            <Toggle checked={mcpTested} onChange={setMcpTested} label="MCP/connector-nya sudah teruji" />
          </div>
        </div>
      }
      confirmLabel="Aktif jual sekarang"
      loading={loading || !webLive || !mcpTested}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function CatalogForm({
  entry,
  existingKeys,
  onClose,
  onSaved,
}: {
  entry: Catalog | null;
  existingKeys: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = entry === null;
  const [f, setF] = useState<Catalog>(entry ?? emptyCatalog());
  // Tracks whether the admin has hand-edited the key; until then it auto-follows title.
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [goLiveOpen, setGoLiveOpen] = useState(false);

  const set = <K extends keyof Catalog>(k: K, v: Catalog[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const setTitle = (title: string) =>
    setF((prev) => ({
      ...prev,
      title,
      key: !keyTouched && isNew ? slugify(title) : prev.key,
    }));

  const keyTaken = isNew && f.key.trim() !== "" && existingKeys.has(f.key.trim());
  const keyInvalid = isNew && f.key.trim() !== "" && !/^[a-z0-9-]{1,60}$/.test(f.key.trim());
  const titleMissing = !f.title.trim();
  const keyError = isNew
    ? f.key.trim() === ""
      ? null
      : keyInvalid
        ? "Hanya huruf kecil, angka, dan strip."
        : keyTaken
          ? "Slug ini sudah dipakai."
          : null
    : null;

  const save = useAdminMutation<void>(
    () => {
      const payload = {
        ...(isNew ? { key: f.key.trim() } : {}),
        title: f.title.trim(),
        tagline: f.tagline.trim(),
        description: f.description.trim(),
        priceRp: Number(f.priceRp) || 0,
        category: f.category,
        icon: f.icon.trim() || "Package",
        unlock: f.unlock,
        status: f.status,
        byok: !!f.byok,
        billing: f.billing,
        source: f.source,
        version: f.version?.trim() ? f.version.trim() : null,
        coverEmoji: f.coverEmoji.trim() || "📦",
        accent: f.accent,
        featured: !!f.featured,
        capabilities: f.capabilities,
      };
      return isNew
        ? apiFetch("/api/admin/catalog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : apiFetch(`/api/admin/catalog/${entry.key}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
    },
    {
      successMessage: isNew ? "Item dibuat." : "Item disimpan.",
      invalidate: [ADMIN_QUERY_KEY],
      onSuccess: onSaved,
    },
  );

  const canSave =
    !save.isPending && !titleMissing && (!isNew || (f.key.trim() !== "" && !keyTaken && !keyInvalid));

  // "available" requires going through the go-live checklist gate.
  const requestSave = () => {
    if (f.status === "available" && entry?.status !== "available") {
      setGoLiveOpen(true);
      return;
    }
    save.mutate();
  };

  return (
    <Section
      title={isNew ? "Item baru" : `Edit: ${entry.title}`}
      desc="Isi form, lihat preview kartu di kanan secara live."
      actions={
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 text-xs text-zinc-400 transition hover:text-zinc-100"
        >
          <ArrowLeft className="size-3.5" /> Kembali
        </button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Form column */}
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {isNew ? (
              <FormRow
                label="Key (slug)"
                required
                error={keyError}
                help="Slug unik, dipakai sebagai SKU & install. Terkunci setelah dibuat."
              >
                <div className="space-y-1">
                  <input
                    value={f.key}
                    onChange={(e) => {
                      setKeyTouched(true);
                      set("key", slugify(e.target.value));
                    }}
                    placeholder="cs-toko-autopilot"
                    maxLength={KEY_MAX}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                  />
                  {f.key.trim() !== "" && !keyError && (
                    <p className="text-[11px] text-emerald-400">tersedia</p>
                  )}
                </div>
              </FormRow>
            ) : (
              <FormRow label="Key (terkunci)" help="Tidak bisa diubah — ini SKU & install slug.">
                <input
                  value={f.key}
                  disabled
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 font-mono text-sm text-zinc-500 outline-none"
                />
              </FormRow>
            )}

            <FormRow
              label="Judul"
              required
              help={`Nama produk di Shop. ${f.title.length} / ${TITLE_MAX}`}
              error={titleMissing ? "Judul wajib diisi." : undefined}
            >
              <input
                value={f.title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </FormRow>

            <FormRow label="Tagline" help={`Sub-judul singkat di kartu. ${f.tagline.length} / ${TAGLINE_MAX}`}>
              <input
                value={f.tagline}
                onChange={(e) => set("tagline", e.target.value)}
                maxLength={TAGLINE_MAX}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </FormRow>

            <FormRow label="Harga" help="0 = Gratis. Maks Rp 100 juta.">
              <CurrencyField value={f.priceRp} onChange={(v) => set("priceRp", v)} max={PRICE_CEILING} />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {PRICE_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set("priceRp", p)}
                    className={`rounded border px-1.5 py-0.5 text-[11px] transition ${
                      f.priceRp === p
                        ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                        : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                    }`}
                  >
                    {p === 0 ? "Gratis" : fmtRp(p)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">Langkah Rp {PRICE_STEP.toLocaleString("id-ID")}.</p>
            </FormRow>
          </div>

          <FormRow label="Deskripsi" help={`Deskripsi panjang. ${f.description.length} / ${DESC_MAX}`}>
            <textarea
              value={f.description}
              onChange={(e) => set("description", e.target.value)}
              maxLength={DESC_MAX}
              rows={3}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
          </FormRow>

          <FormRow
            label="Status jual"
            help="Aktif jual = langsung bisa dibeli. Segera hadir = tampil 'Segera Hadir', checkout menolak."
          >
            <SegmentedControl<Catalog["status"]>
              value={f.status}
              onChange={(v) => set("status", v)}
              options={STATUS_OPTS as Option<Catalog["status"]>[]}
            />
          </FormRow>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormRow label="Kategori">
              <Select value={f.category} onChange={(v) => set("category", v)} options={CATEGORY_OPTS} />
            </FormRow>
            <FormRow label="Unlock" help="Jenis yang dibuka saat dibeli.">
              <Select value={f.unlock} onChange={(v) => set("unlock", v)} options={UNLOCK_OPTS} />
            </FormRow>
            <FormRow label="Billing" help="Model penagihan produk.">
              <Select value={f.billing} onChange={(v) => set("billing", v)} options={BILLING_OPTS} />
            </FormRow>
            <FormRow label="Source" help="clawhub = registry · direct = spec sendiri.">
              <Select value={f.source} onChange={(v) => set("source", v)} options={SOURCE_OPTS} />
            </FormRow>
            <FormRow label="Icon (lucide)" help="Cari ikon lucide. Default Package.">
              <Combobox
                value={f.icon}
                onChange={(v) => set("icon", v || "Package")}
                options={ICON_OPTS}
                allowCustom
                placeholder="Package"
              />
            </FormRow>
            <FormRow label="Cover emoji" help="Emoji cover produk. Maks 8 karakter.">
              <input
                value={f.coverEmoji}
                onChange={(e) => set("coverEmoji", e.target.value.slice(0, 8))}
                maxLength={8}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-center text-lg text-zinc-100 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </FormRow>
            <FormRow label="Version" help="Opsional. Contoh: 1.0.0">
              <input
                value={f.version ?? ""}
                onChange={(e) => set("version", e.target.value.slice(0, VERSION_MAX))}
                placeholder="1.0.0"
                maxLength={VERSION_MAX}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </FormRow>
          </div>

          <FormRow label="Accent" help="Warna aksen kartu di Shop.">
            <div className="flex flex-wrap gap-2">
              {ACCENT_OPTS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => set("accent", a.value)}
                  aria-label={a.label}
                  title={a.label}
                  className={`size-7 rounded-full ${a.swatch} ring-2 ring-offset-2 ring-offset-zinc-900 transition ${
                    f.accent === a.value ? "ring-white/80" : "ring-transparent hover:ring-white/30"
                  }`}
                />
              ))}
            </div>
          </FormRow>

          <div className="flex flex-wrap gap-6">
            <Toggle checked={!!f.featured} onChange={(v) => set("featured", v)} label="Featured (rail + badge Trending)" />
            <Toggle checked={!!f.byok} onChange={(v) => set("byok", v)} label="BYOK (pakai API key user)" />
          </div>

          <FormRow
            label="Kemampuan"
            help={`Tambah satu kemampuan per chip. ${f.capabilities.length} / ${CAPS_MAX}`}
          >
            <MultiSelectChips
              values={f.capabilities}
              onChange={(v) => set("capabilities", v)}
              max={CAPS_MAX}
              validate={(v) => v.length <= CAP_MAX_LEN}
              placeholder="Ketik kemampuan lalu Enter…"
            />
          </FormRow>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled={!canSave}
              onClick={requestSave}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {save.isPending ? "Menyimpan…" : "Simpan"}
            </button>
            {save.isError ? (
              <span className="text-xs text-red-400">{errorToBahasa(save.error)}</span>
            ) : null}
          </div>
        </div>

        {/* Live preview column */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            <Sparkles className="size-3" /> Preview kartu
          </div>
          <PreviewCard f={f} />
        </div>
      </div>

      <GoLiveDialog
        open={goLiveOpen}
        loading={save.isPending}
        onConfirm={() => {
          setGoLiveOpen(false);
          save.mutate();
        }}
        onCancel={() => setGoLiveOpen(false)}
      />
    </Section>
  );
}
