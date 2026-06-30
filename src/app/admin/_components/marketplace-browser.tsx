"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Inbox, Plus, X } from "lucide-react";
import {
  apiFetch,
  Badge,
  Combobox,
  ConfirmDialog,
  CurrencyField,
  DataTable,
  EmptyState,
  FilterBar,
  FormRow,
  Pagination,
  SearchInput,
  Section,
  SegmentedControl,
  Select,
  StatusBadge,
  useAdminMutation,
  useAdminQuery,
  type Column,
  type Option,
  type StatusMap,
  type Tone,
} from "./ui";

type Row = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  category: string | null;
  priceRp: number;
  status: string;
  version: string | null;
  sellerName: string | null;
  sellerType: string | null;
  installSpec: Record<string, unknown> | null;
  reviewNotes: string | null;
  createdAt: string;
  publishedAt: string | null;
};
type Resp = {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  counts: Record<string, number>;
};

// --- Enums (mirror listings route + listings/[id] route) ---

const STATUSES = [
  "draft",
  "pending",
  "approved",
  "published",
  "rejected",
  "delisted",
] as const;
type Status = (typeof STATUSES)[number];

// Mirrors the server-side lifecycle DAG (listings/[id] route). The row dropdown
// only offers the current status + its legal next states so an admin never picks
// a transition the API would reject with 409.
const ALLOWED_TRANSITIONS: Record<string, Status[]> = {
  draft: ["pending", "published", "rejected"],
  pending: ["approved", "rejected", "published", "draft"],
  approved: ["published", "rejected", "delisted"],
  published: ["delisted", "rejected"],
  rejected: ["pending", "draft"],
  delisted: ["published", "pending", "draft"],
};
// Destructive transitions get a confirm dialog + required/optional reviewNotes.
const DESTRUCTIVE = new Set<Status>(["rejected", "delisted"]);

const STATUS_LABEL: Record<Status, string> = {
  draft: "Draft",
  pending: "Pending",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
  delisted: "Delisted",
};

const STATUS_HINT: Record<Status, string> = {
  draft: "Belum tampil ke user.",
  pending: "Menunggu review admin.",
  approved: "Lolos review, belum tampil.",
  published: "Tampil & bisa dibeli.",
  rejected: "Ditolak, tidak tampil.",
  delisted: "Pernah tampil lalu ditarik.",
};

const STATUS_TONE: Record<Status, Tone> = {
  draft: "muted",
  pending: "warn",
  approved: "info",
  published: "ok",
  rejected: "bad",
  delisted: "bad",
};

const STATUS_MAP: StatusMap = Object.fromEntries(
  STATUSES.map((s) => [
    s,
    { tone: STATUS_TONE[s], label: STATUS_LABEL[s], hint: STATUS_HINT[s] },
  ]),
) as StatusMap;

const KIND_LABEL: Record<string, string> = {
  skill: "Skill",
  mcp_app: "MCP App",
  bundle: "Bundle",
};

const KIND_FILTER_OPTIONS: Option[] = [
  { value: "", label: "Semua kind" },
  { value: "skill", label: "Skill" },
  { value: "mcp_app", label: "MCP App", hint: "Aplikasi berbasis MCP" },
  { value: "bundle", label: "Bundle" },
];

const KIND_CREATE_OPTIONS: Option<"skill" | "mcp_app" | "bundle">[] = [
  { value: "skill", label: "Skill" },
  { value: "mcp_app", label: "MCP App" },
  { value: "bundle", label: "Bundle" },
];

const STATUS_FILTER_OPTIONS: Option[] = [
  { value: "", label: "Semua" },
  ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
];

const PRICE_CEILING = 100_000_000;
const PRICE_PRESETS = [0, 49_000, 99_000, 149_000];
const MAX_TITLE = 120;
const MAX_CATEGORY = 40;

const rp = (n: number) => (n > 0 ? `Rp ${n.toLocaleString("id-ID")}` : "Gratis");

// --- Lifecycle legend strip (replaces the developer-only mental model) ---

function LifecycleLegend() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
      <span className="font-mono uppercase tracking-[0.18em] text-zinc-600">
        Alur
      </span>
      {(["draft", "pending", "approved", "published"] as Status[]).map(
        (s, i) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-zinc-700">→</span>}
            <Badge tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Badge>
          </span>
        ),
      )}
      <span className="text-zinc-700">→</span>
      <Badge tone="bad">Delisted</Badge>
      <span className="text-zinc-700">/</span>
      <Badge tone="bad">Rejected</Badge>
    </div>
  );
}

// --- Mini stat card (status counts) ---

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-zinc-100">
        {value}
      </div>
    </div>
  );
}

export function MarketplaceBrowser() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);

  const queryUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status) p.set("status", status);
    if (kind) p.set("kind", kind);
    p.set("page", String(page));
    return `/api/admin/listings?${p.toString()}`;
  }, [q, status, kind, page]);

  const { data, isLoading, isError, refetch } = useAdminQuery<Resp>(
    ["admin", "listings", q, status, kind, page],
    queryUrl,
  );

  const invalidateAll = () =>
    void qc.invalidateQueries({ queryKey: ["admin", "listings"] });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 25)));
  const curPage = data?.page ?? page;
  const counts = data?.counts ?? {};
  const hasFilters = Boolean(q || status || kind);

  // Stable identity so the categorySuggestions memo below only recomputes when
  // the underlying rows actually change (not on every render via `?? []`).
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);

  // Category suggestions for the create form, derived from loaded rows (no new
  // endpoint). allowCustom lets the admin type a brand-new category.
  const categorySuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return Array.from(set).sort();
  }, [rows]);

  const resetFilters = () => {
    setQ("");
    setStatus("");
    setKind("");
    setPage(1);
  };

  const columns: Column<Row>[] = [
    {
      key: "item",
      header: "Item",
      cell: (l) => (
        <div>
          <div className="text-zinc-200">{l.title}</div>
          <div className="font-mono text-[10px] text-zinc-600">
            {l.slug}
            {l.category ? ` · ${l.category}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (l) => (
        <span className="text-zinc-400">{KIND_LABEL[l.kind] ?? l.kind}</span>
      ),
    },
    {
      key: "seller",
      header: "Seller",
      cell: (l) => (
        <span className="text-zinc-500">
          {l.sellerName ?? "—"}
          {l.sellerType === "first_party" ? (
            <span className="ml-1 text-[10px] text-cyan-400/70">(house)</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "price",
      header: "Harga",
      align: "right",
      cell: (l) => (
        <span className="whitespace-nowrap tabular-nums text-zinc-300">
          {rp(l.priceRp)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (l) => <StatusCell row={l} onDone={invalidateAll} />,
    },
  ];

  return (
    <div className="space-y-4">
      <Section
        title="Listing marketplace"
        desc="Daftar & moderasi semua listing (first-party + 3rd-party) lewat alur status. Aksi destruktif (tolak/delist) minta konfirmasi + catatan review."
        actions={
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
          >
            {showCreate ? (
              <>
                <X className="size-3.5" /> Tutup
              </>
            ) : (
              <>
                <Plus className="size-3.5" /> Listing baru
              </>
            )}
          </button>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <MiniCard
              label="Published"
              value={String(counts.published ?? 0)}
            />
            <MiniCard label="Pending" value={String(counts.pending ?? 0)} />
            <MiniCard label="Draft" value={String(counts.draft ?? 0)} />
            <MiniCard label="Approved" value={String(counts.approved ?? 0)} />
            <MiniCard
              label="Delisted/Reject"
              value={String((counts.delisted ?? 0) + (counts.rejected ?? 0))}
            />
          </div>

          <LifecycleLegend />

          <FilterBar
            actions={
              <span className="text-xs text-zinc-500">
                {total.toLocaleString("id-ID")} listing
              </span>
            }
          >
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Cari judul / slug…"
              scopeHint="judul, slug"
            />
            <div className="w-40">
              <Select
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setPage(1);
                }}
                options={KIND_FILTER_OPTIONS}
              />
            </div>
          </FilterBar>

          <SegmentedControl
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={STATUS_FILTER_OPTIONS}
            size="sm"
          />

          {isError ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <span>Gagal memuat listing.</span>
              <button
                type="button"
                onClick={() => refetch()}
                className="rounded border border-red-500/40 px-2 py-0.5 text-xs hover:bg-red-500/20"
              >
                Coba lagi
              </button>
            </div>
          ) : null}

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            isLoading={isLoading}
            empty={
              hasFilters ? (
                <EmptyState
                  icon={<Inbox className="size-8" />}
                  title="Tidak ada listing dengan filter ini."
                  action={
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      Reset filter
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Inbox className="size-8" />}
                  title="Belum ada listing."
                  body="Buat listing first-party pertama."
                  action={
                    <button
                      type="button"
                      onClick={() => setShowCreate(true)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-cyan-400"
                    >
                      <Plus className="size-3.5" /> Listing baru
                    </button>
                  }
                />
              )
            }
          />

          <Pagination
            page={curPage}
            totalPages={totalPages}
            total={total}
            onPage={(p) => setPage(Math.max(1, p))}
          />
        </div>
      </Section>

      {showCreate ? (
        <CreateListing
          categorySuggestions={categorySuggestions}
          onDone={() => {
            setShowCreate(false);
            invalidateAll();
          }}
        />
      ) : null}
    </div>
  );
}

// --- StatusCell: per-row transition. Non-destructive commits immediately;
//     destructive opens a ConfirmDialog with a reviewNotes textarea. ---

function StatusCell({ row, onDone }: { row: Row; onDone: () => void }) {
  const [pending, setPending] = useState<{
    next: Status;
    notes: string;
  } | null>(null);

  const upd = useAdminMutation<
    { id: string; status: Status; reviewNotes?: string },
    unknown
  >(
    ({ id, status, reviewNotes }) =>
      apiFetch(`/api/admin/listings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reviewNotes !== undefined
            ? { status, reviewNotes }
            : { status },
        ),
      }),
    {
      successMessage: (_d, v) => `Status → ${STATUS_LABEL[v.status]}`,
      onSuccess: () => {
        setPending(null);
        onDone();
      },
    },
  );

  const current = row.status as Status;
  const nexts = ALLOWED_TRANSITIONS[current] ?? [];
  const options: Option<Status>[] = [
    { value: current, label: STATUS_LABEL[current] ?? current },
    ...nexts.map((s) => ({
      value: s,
      label: STATUS_LABEL[s],
      hint: STATUS_HINT[s],
    })),
  ];

  const handleChange = (next: Status) => {
    if (next === current) return;
    if (DESTRUCTIVE.has(next)) {
      setPending({ next, notes: "" });
      return;
    }
    upd.mutate({ id: row.id, status: next });
  };

  const notesRequired = pending?.next === "rejected";
  const canConfirm =
    !!pending && (!notesRequired || pending.notes.trim().length > 0);

  return (
    <div className="flex items-center gap-2">
      <StatusBadge value={row.status} map={STATUS_MAP} />
      <div className="w-36">
        <Select
          value={current}
          onChange={handleChange}
          options={options}
          disabled={upd.isPending}
        />
      </div>

      {pending ? (
        <ConfirmDestructiveDialog
          row={row}
          next={pending.next}
          notes={pending.notes}
          notesRequired={notesRequired}
          loading={upd.isPending}
          onNotes={(notes) => setPending({ next: pending.next, notes })}
          onCancel={() => setPending(null)}
          canConfirm={canConfirm}
          onConfirm={() =>
            upd.mutate({
              id: row.id,
              status: pending.next,
              reviewNotes: pending.notes.trim() || undefined,
            })
          }
        />
      ) : null}
    </div>
  );
}

function ConfirmDestructiveDialog({
  row,
  next,
  notes,
  notesRequired,
  loading,
  canConfirm,
  onNotes,
  onCancel,
  onConfirm,
}: {
  row: Row;
  next: Status;
  notes: string;
  notesRequired: boolean;
  loading: boolean;
  canConfirm: boolean;
  onNotes: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verb = next === "rejected" ? "Tolak" : "Delist";
  const body = (
    <div className="space-y-3">
      <p>
        {next === "rejected"
          ? "Listing akan ditolak dan tidak tampil. Catatan review wajib diisi."
          : "Listing akan ditarik dari etalase. Catatan review opsional."}
      </p>
      <div>
        <label className="text-xs text-zinc-400">
          Catatan review{notesRequired ? " (wajib)" : " (opsional)"}
        </label>
        <textarea
          value={notes}
          onChange={(e) => onNotes(e.target.value.slice(0, 1000))}
          rows={3}
          placeholder="Alasan (mis. kenapa ditolak). Tersimpan di log."
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
        />
        <div className="mt-1 text-right text-[11px] text-zinc-600">
          {notes.length} / 1000
        </div>
      </div>
    </div>
  );

  return (
    <ConfirmDialog
      open
      danger
      loading={loading}
      title={`${verb} listing "${row.title}"?`}
      body={body}
      summary={[
        { label: "Listing", value: row.title },
        { label: "Slug", value: row.slug },
        {
          label: "Status baru",
          value: STATUS_LABEL[next],
          tone: STATUS_TONE[next],
        },
      ]}
      confirmLabel={`${verb} listing`}
      cancelLabel="Batal"
      onCancel={onCancel}
      onConfirm={() => {
        if (!canConfirm) return;
        onConfirm();
      }}
    />
  );
}

// --- CreateListing: form + installSpec builder (replaces JSON-by-hand) ---

type SpecSource = "clawhub" | "direct";
type EnvPair = { key: string; value: string };

function CreateListing({
  onDone,
  categorySuggestions,
}: {
  onDone: () => void;
  categorySuggestions: string[];
}) {
  const [kind, setKind] = useState<"skill" | "mcp_app" | "bundle">("skill");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [priceRp, setPriceRp] = useState<number>(0);
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<"draft" | "published">("draft");

  // installSpec builder state
  const [specSource, setSpecSource] = useState<SpecSource>("clawhub");
  const [cSlug, setCSlug] = useState("");
  const [cVersion, setCVersion] = useState("");
  const [dCommand, setDCommand] = useState("");
  const [dArgs, setDArgs] = useState<string[]>([]);
  const [dEnv, setDEnv] = useState<EnvPair[]>([]);

  const [fieldErr, setFieldErr] = useState<{ title?: string }>({});

  const slugPreview = useMemo(
    () =>
      (slug || title)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60),
    [slug, title],
  );

  const installSpec = useMemo<Record<string, unknown> | undefined>(() => {
    if (specSource === "clawhub") {
      if (!cSlug.trim()) return undefined;
      const spec: Record<string, unknown> = {
        source: "clawhub",
        slug: cSlug.trim(),
      };
      if (cVersion.trim()) spec.version = cVersion.trim();
      return spec;
    }
    // direct
    if (!dCommand.trim()) return undefined;
    const env = Object.fromEntries(
      dEnv
        .filter((e) => e.key.trim())
        .map((e) => [e.key.trim(), e.value]),
    );
    const spec: Record<string, unknown> = { command: dCommand.trim() };
    if (dArgs.length) spec.args = dArgs;
    if (Object.keys(env).length) spec.env = env;
    return spec;
  }, [specSource, cSlug, cVersion, dCommand, dArgs, dEnv]);

  const categoryOptions: Option[] = categorySuggestions.map((c) => ({
    value: c,
    label: c,
  }));
  const isNewCategory =
    category.trim().length > 0 &&
    !categorySuggestions.some((c) => c === category.trim());

  const create = useAdminMutation<void, { id: string; slug: string }>(
    () =>
      apiFetch<{ id: string; slug: string }>("/api/admin/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          slug: slug.trim() || undefined,
          category: category.trim() || undefined,
          version: version.trim() || undefined,
          priceRp: priceRp || 0,
          installSpec,
          status,
        }),
      }),
    {
      successMessage: "Listing dibuat.",
      onSuccess: () => onDone(),
    },
  );

  const submit = () => {
    if (!title.trim()) {
      setFieldErr({ title: "Judul wajib diisi." });
      return;
    }
    setFieldErr({});
    create.mutate();
  };

  return (
    <Section
      title="Buat listing first-party"
      desc="Seller = AgentBuff (house, komisi 0%). Install spec dibangun lewat form, tanpa ngetik JSON."
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormRow label="Kind">
            <SegmentedControl
              value={kind}
              onChange={setKind}
              options={KIND_CREATE_OPTIONS}
              size="sm"
            />
          </FormRow>

          <FormRow
            label="Judul"
            required
            help={`Nama produk di Shop. Maks ${MAX_TITLE} karakter.`}
            error={fieldErr.title}
          >
            <div className="relative">
              <input
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value.slice(0, MAX_TITLE))
                }
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 pr-12 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-zinc-600">
                {title.length}/{MAX_TITLE}
              </span>
            </div>
          </FormRow>

          <FormRow
            label="Slug"
            help="Kosong = otomatis dari judul. Huruf kecil, angka, strip. Unik."
          >
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto dari judul"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
            {slugPreview ? (
              <p className="mt-1 font-mono text-[11px] text-zinc-500">
                /{slugPreview}
              </p>
            ) : null}
          </FormRow>

          <FormRow
            label="Kategori"
            help="Dipakai juga di rule Komisi. Pakai nama yang konsisten."
          >
            <Combobox
              value={category}
              onChange={(v) => setCategory(v.slice(0, MAX_CATEGORY))}
              options={categoryOptions}
              allowCustom
              placeholder="Pilih / ketik kategori…"
              emptyText="Ketik untuk kategori baru"
            />
            {isNewCategory ? (
              <p className="mt-1 text-[11px] text-amber-400">
                Kategori baru — pastikan cocok dengan rule Komisi.
              </p>
            ) : null}
          </FormRow>

          <FormRow
            label="Harga"
            help="0 = Gratis. Maks Rp 100 juta."
          >
            <CurrencyField
              value={priceRp}
              onChange={setPriceRp}
              max={PRICE_CEILING}
              min={0}
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {PRICE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriceRp(p)}
                  className={
                    priceRp === p
                      ? "rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-300"
                      : "rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
                  }
                >
                  {p === 0 ? "Gratis" : `Rp ${p.toLocaleString("id-ID")}`}
                </button>
              ))}
            </div>
          </FormRow>

          <FormRow label="Version" help="Opsional. Contoh: 1.0.0">
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value.slice(0, 40))}
              placeholder="1.0.0"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
          </FormRow>

          <FormRow
            label="Status awal"
            help="Draft = belum tampil. Publish = langsung tampil & bisa dibeli."
          >
            <SegmentedControl
              value={status}
              onChange={setStatus}
              options={[
                { value: "draft", label: "Draft" },
                { value: "published", label: "Langsung publish" },
              ]}
              size="sm"
            />
          </FormRow>
        </div>

        <InstallSpecBuilder
          source={specSource}
          onSource={setSpecSource}
          cSlug={cSlug}
          onCSlug={setCSlug}
          cVersion={cVersion}
          onCVersion={setCVersion}
          dCommand={dCommand}
          onDCommand={setDCommand}
          dArgs={dArgs}
          onDArgs={setDArgs}
          dEnv={dEnv}
          onDEnv={setDEnv}
          previewJson={installSpec}
        />

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={create.isPending || !title.trim()}
            onClick={submit}
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {create.isPending ? "Membuat…" : "Buat listing"}
          </button>
          <span className="text-[11px] text-zinc-600">
            Seller = AgentBuff (first-party, komisi 0%).
          </span>
        </div>
      </div>
    </Section>
  );
}

// --- InstallSpecBuilder: clawhub | direct, no raw JSON typing ---

function InstallSpecBuilder({
  source,
  onSource,
  cSlug,
  onCSlug,
  cVersion,
  onCVersion,
  dCommand,
  onDCommand,
  dArgs,
  onDArgs,
  dEnv,
  onDEnv,
  previewJson,
}: {
  source: SpecSource;
  onSource: (v: SpecSource) => void;
  cSlug: string;
  onCSlug: (v: string) => void;
  cVersion: string;
  onCVersion: (v: string) => void;
  dCommand: string;
  onDCommand: (v: string) => void;
  dArgs: string[];
  onDArgs: (v: string[]) => void;
  dEnv: EnvPair[];
  onDEnv: (v: EnvPair[]) => void;
  previewJson: Record<string, unknown> | undefined;
}) {
  const [showJson, setShowJson] = useState(false);

  const inputCls =
    "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-200">Install spec</div>
          <p className="text-[11px] text-zinc-500">
            Sumber install produk. Dibangun lewat form, bukan JSON.
          </p>
        </div>
        <SegmentedControl
          value={source}
          onChange={onSource}
          options={[
            { value: "clawhub", label: "ClawHub" },
            { value: "direct", label: "Direct" },
          ]}
          size="sm"
        />
      </div>

      {source === "clawhub" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Slug" help="Ambil dari ClawHub registry.">
            <input
              value={cSlug}
              onChange={(e) => onCSlug(e.target.value)}
              placeholder="mis. vision"
              className={inputCls}
            />
          </FormRow>
          <FormRow label="Version (opsional)">
            <input
              value={cVersion}
              onChange={(e) => onCVersion(e.target.value)}
              placeholder="latest"
              className={inputCls}
            />
          </FormRow>
        </div>
      ) : (
        <div className="space-y-4">
          <FormRow label="Command" help="Perintah install langsung.">
            <input
              value={dCommand}
              onChange={(e) => onDCommand(e.target.value)}
              placeholder="npx"
              className={inputCls}
            />
          </FormRow>
          <FormRow
            label="Args"
            help="Satu argumen per chip. Enter untuk tambah."
          >
            <ArgsInput values={dArgs} onChange={onDArgs} />
          </FormRow>
          <FormRow label="Env">
            <EnvRows pairs={dEnv} onChange={onDEnv} />
          </FormRow>
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowJson((v) => !v)}
          className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
        >
          {showJson ? "Sembunyikan JSON" : "Lihat JSON"}
        </button>
        {showJson ? (
          <pre className="mt-2 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] text-zinc-400">
            {previewJson ? JSON.stringify(previewJson, null, 2) : "—"}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

// --- ArgsInput: chip list for direct install args ---

function ArgsInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v.slice(0, 160)]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 focus-within:border-cyan-500/50 focus-within:ring-2 focus-within:ring-cyan-500/30">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            aria-label={`Hapus ${v}`}
          >
            <X className="size-3 text-zinc-500 hover:text-zinc-200" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={values.length === 0 ? "-y, @scope/pkg…" : ""}
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
      />
    </div>
  );
}

// --- EnvRows: repeatable key/value pairs for direct install env ---

function EnvRows({
  pairs,
  onChange,
}: {
  pairs: EnvPair[];
  onChange: (v: EnvPair[]) => void;
}) {
  const inputCls =
    "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30";

  const update = (i: number, patch: Partial<EnvPair>) =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={p.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="KEY"
            className={inputCls}
          />
          <span className="text-zinc-600">=</span>
          <input
            value={p.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
            aria-label="Hapus env"
            className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
        className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
      >
        <Plus className="size-3" /> Tambah env
      </button>
    </div>
  );
}
