"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, Loader2 } from "lucide-react";
import {
  apiFetch,
  fmtDate,
  errorToBahasa,
  Badge,
  StatusBadge,
  Section,
  TabIntro,
  EmptyState,
  RoleGate,
  Select,
  DataTable,
  FilterBar,
  SearchInput,
  Pagination,
  useAdminQuery,
  useToast,
  type Tone,
  type Column,
  type StatusMap,
  type Option,
} from "./ui";

type Lead = {
  id: string;
  name: string;
  email: string;
  whatsapp: string | null;
  note: string | null;
  tier: string;
  source: string;
  status: string;
  createdAt: string;
};
type Counts = { new: number; contacted: number; converted: number; archived: number };
type Resp = {
  rows: Lead[];
  page: number;
  pageSize: number;
  total: number;
  counts: Counts;
  filters: { tiers: string[]; sources: string[] };
};

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Single canonical status map (Bahasa labels + tone) so cards, dropdown, badge,
// and inline select never drift. Mirrors the 4 enum values the API validates
// (api/admin/leads/[id]/route.ts -> INVALID_STATUS otherwise).
const STATUS_MAP: StatusMap = {
  new: { tone: "warn", label: "Baru", hint: "Belum disentuh" },
  contacted: { tone: "info", label: "Dihubungi", hint: "Sudah di-outreach" },
  converted: { tone: "ok", label: "Konversi", hint: "Jadi user / deal" },
  archived: { tone: "muted", label: "Arsip", hint: "Mati / duplikat" },
};
const STATUS_ORDER = ["new", "contacted", "converted", "archived"] as const;

// Bahasa options for the inline per-row select + the header filter select.
const STATUS_OPTIONS: Option[] = STATUS_ORDER.map((s) => ({
  value: s,
  label: STATUS_MAP[s].label,
  hint: STATUS_MAP[s].hint,
  tone: STATUS_MAP[s].tone,
}));
const FILTER_OPTIONS: Option[] = [{ value: "", label: "Semua status" }, ...STATUS_OPTIONS];

const TABS: { value: string; label: string; countKey?: keyof Counts; tone: Tone }[] = [
  { value: "", label: "Semua", tone: "info" },
  { value: "new", label: "Baru", countKey: "new", tone: "warn" },
  { value: "contacted", label: "Dihubungi", countKey: "contacted", tone: "info" },
  { value: "converted", label: "Konversi", countKey: "converted", tone: "ok" },
  { value: "archived", label: "Arsip", countKey: "archived", tone: "muted" },
];

function buildListParams(
  q: string,
  status: string,
  tier: string,
  source: string,
  page?: number,
  pageSize?: number,
): URLSearchParams {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status) p.set("status", status);
  if (tier) p.set("tier", tier);
  if (source) p.set("source", source);
  if (typeof page === "number") p.set("page", String(page));
  if (typeof pageSize === "number") p.set("pageSize", String(pageSize));
  return p;
}

// --- Clickable status tab/card (segmented filter driven by the counts) ---

function StatusTab({
  label,
  count,
  total,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  total: number;
  tone: Tone;
  active: boolean;
  onClick: () => void;
}) {
  const ring =
    tone === "ok"
      ? "data-[active=true]:border-emerald-500/50 data-[active=true]:bg-emerald-500/10"
      : tone === "warn"
        ? "data-[active=true]:border-amber-500/50 data-[active=true]:bg-amber-500/10"
        : tone === "muted"
          ? "data-[active=true]:border-zinc-500/50 data-[active=true]:bg-zinc-500/10"
          : "data-[active=true]:border-cyan-500/50 data-[active=true]:bg-cyan-500/10";
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      aria-pressed={active}
      title={`Saring ke tahap ${label}`}
      className={`rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left transition hover:border-zinc-600 ${ring}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">
        {count.toLocaleString("id-ID")}
      </div>
      {total > 0 && label !== "Semua" && (
        <div className="text-[10px] text-zinc-600">
          {Math.round((count / total) * 100)}% dari total
        </div>
      )}
    </button>
  );
}

export function LeadsBrowser({ role = "admin" }: { role?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isReadOnly = role !== "admin";

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [tier, setTier] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [exporting, setExporting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Reset to page 1 whenever any active filter or the page size changes (kit
  // SearchInput debounces the search itself, so q updates already arrive settled).
  useEffect(() => {
    setPage(1);
  }, [q, status, tier, source, pageSize]);

  const queryKey = ["admin", "leads", q, status, tier, source, page, pageSize] as const;
  const { data, isLoading, isError, error, refetch } = useAdminQuery<Resp>(
    queryKey,
    `/api/admin/leads?${buildListParams(q, status, tier, source, page, pageSize).toString()}`,
  );

  const counts = data?.counts;
  const total = data?.total ?? 0;
  const respPageSize = data?.pageSize ?? pageSize;
  const totalPages = Math.max(1, Math.ceil(total / respPageSize));
  const curPage = data?.page ?? page;
  const grandTotal =
    (counts?.new ?? 0) + (counts?.contacted ?? 0) + (counts?.converted ?? 0) + (counts?.archived ?? 0);

  // Tier/source dropdown options come from the API's distinct-values block, plus
  // a "Semua" clear option. If the active value is no longer in the distinct list
  // (e.g. last row of that value just changed) keep it selectable so the filter
  // doesn't silently flip to "Semua".
  const tierOptions = useMemo<Option[]>(() => {
    const vals = data?.filters?.tiers ?? [];
    const merged = tier && !vals.includes(tier) ? [tier, ...vals] : vals;
    return [{ value: "", label: "Semua tier" }, ...merged.map((v) => ({ value: v, label: v }))];
  }, [data?.filters?.tiers, tier]);
  const sourceOptions = useMemo<Option[]>(() => {
    const vals = data?.filters?.sources ?? [];
    const merged = source && !vals.includes(source) ? [source, ...vals] : vals;
    return [{ value: "", label: "Semua sumber" }, ...merged.map((v) => ({ value: v, label: v }))];
  }, [data?.filters?.sources, source]);

  // Inline status change: optimistic cache write + rollback on error + Undo toast.
  // Kept as a raw useMutation (not useAdminMutation) because Undo/rollback need
  // the onMutate snapshot + previous-value capture the wrapper doesn't expose.
  const updateStatus = useMutation<
    { ok: boolean; status: string },
    unknown,
    { id: string; status: string; prevStatus: string; silent?: boolean },
    { key: readonly unknown[]; prev: Resp | undefined }
  >({
    mutationFn: ({ id, status }) =>
      apiFetch(`/api/admin/leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    onMutate: ({ id, status: next }) => {
      setSavingId(id);
      const key = queryKey;
      const prev = qc.getQueryData<Resp>(key);
      if (prev) {
        qc.setQueryData<Resp>(key, {
          ...prev,
          rows: prev.rows.map((r) => (r.id === id ? { ...r, status: next } : r)),
        });
      }
      return { key, prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast(errorToBahasa(err), { tone: "bad" });
    },
    onSuccess: (_data, vars) => {
      if (vars.silent) return;
      toast(`Status -> ${STATUS_MAP[vars.status]?.label ?? vars.status}`, {
        tone: "ok",
        action: {
          label: "Undo",
          onClick: () =>
            updateStatus.mutate({
              id: vars.id,
              status: vars.prevStatus,
              prevStatus: vars.status,
              silent: true,
            }),
        },
      });
    },
    onSettled: () => {
      setSavingId(null);
      void qc.invalidateQueries({ queryKey: ["admin", "leads"] });
    },
  });

  const onExport = async () => {
    if (total === 0 || exporting) return;
    setExporting(true);
    try {
      // Export route consumes q/status only; tier/source/pageSize are list-only.
      const params = buildListParams(q, status, "", "");
      const res = await fetch(`/api/admin/leads/export?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const suffix = status ? `-${STATUS_MAP[status]?.label ?? status}` : "";
      a.download = `leads${suffix}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`CSV diunduh (${total.toLocaleString("id-ID")} baris).`, { tone: "ok" });
    } catch (err) {
      toast(errorToBahasa(err), { tone: "bad" });
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo<Column<Lead>[]>(
    () => [
      {
        key: "name",
        header: "Nama",
        cell: (l) => (
          <div className="min-w-0">
            <div className="font-medium text-zinc-200">{l.name}</div>
            {l.note && (
              <div className="mt-0.5 max-w-xs truncate text-[11px] text-zinc-500" title={l.note}>
                {l.note}
              </div>
            )}
          </div>
        ),
      },
      {
        key: "contact",
        header: "Kontak",
        cell: (l) => (
          <div className="min-w-0">
            <div className="truncate text-zinc-300">{l.email}</div>
            {l.whatsapp && <div className="text-[11px] text-zinc-500">{l.whatsapp}</div>}
          </div>
        ),
      },
      {
        key: "tier",
        header: "Tier",
        cell: (l) =>
          l.tier ? (
            <button
              type="button"
              title="Klik untuk cari nilai ini"
              onClick={() => setQ(l.tier)}
              className="text-zinc-400 underline-offset-2 hover:text-cyan-300 hover:underline"
            >
              {l.tier}
            </button>
          ) : (
            <span className="text-zinc-600">—</span>
          ),
      },
      {
        key: "source",
        header: "Sumber",
        cell: (l) =>
          l.source ? (
            <button
              type="button"
              title="Klik untuk cari nilai ini"
              onClick={() => setQ(l.source)}
              className="text-zinc-500 underline-offset-2 hover:text-cyan-300 hover:underline"
            >
              {l.source}
            </button>
          ) : (
            <span className="text-zinc-600">—</span>
          ),
      },
      {
        key: "createdAt",
        header: "Tanggal",
        cell: (l) => <span className="whitespace-nowrap text-zinc-500">{fmtDate(l.createdAt)}</span>,
      },
      {
        key: "status",
        header: "Status",
        cell: (l) => (
          <div className="flex items-center gap-2">
            <StatusBadge value={l.status} map={STATUS_MAP} />
            <div className="w-36">
              <RoleGate need="admin" role={role} fallbackTitle="Ubah status khusus admin">
                <Select
                  value={l.status}
                  disabled={savingId === l.id || isReadOnly}
                  onChange={(next) => {
                    if (next === l.status) return;
                    updateStatus.mutate({ id: l.id, status: next, prevStatus: l.status });
                  }}
                  options={STATUS_OPTIONS}
                />
              </RoleGate>
            </div>
            {savingId === l.id && <Loader2 className="size-3.5 animate-spin text-zinc-500" />}
          </div>
        ),
      },
    ],
    // updateStatus / qc are stable enough for this memo; role+savingId drive cells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, savingId, isReadOnly],
  );

  const tableEmpty =
    q || status || tier || source ? (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title={`Tak ada lead${status ? ` di tahap "${STATUS_MAP[status]?.label ?? status}"` : ""} untuk filter ini.`}
        body="Coba ubah kata kunci atau bersihkan filter."
        action={
          <button
            type="button"
            onClick={() => {
              setQ("");
              setStatus("");
              setTier("");
              setSource("");
            }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500"
          >
            Bersihkan filter
          </button>
        }
      />
    ) : (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title="Belum ada lead."
        body="Lead masuk otomatis dari form early-access di landing."
      />
    );

  return (
    <div className="space-y-4">
      <TabIntro
        eyebrow="OPS · MARKETING"
        title="Lead Early-Access"
        what="Pipeline lead early-access dari landing page — pantau jumlah per tahap, cari/filter, geser status lead, dan export CSV."
        canDo={[
          "Lihat ringkasan per tahap: Baru -> Dihubungi -> Konversi / Arsip.",
          "Cari lead (email/nama/WhatsApp) dan filter per status.",
          "Ubah status lead langsung dari baris (tersimpan seketika, ada Undo).",
          "Export CSV sesuai filter aktif.",
        ]}
        how="1) Klik kartu tahap untuk filter cepat, atau pakai dropdown. 2) Cari lead. 3) Geser status di baris (auto-simpan + Undo). 4) Export bila perlu. Alur normal: Baru -> Dihubungi -> Konversi (deal) atau Arsip (mati)."
        legend={STATUS_ORDER.map((s) => ({ tone: STATUS_MAP[s].tone, label: STATUS_MAP[s].label }))}
        warning={
          isReadOnly
            ? "Mode baca-saja (Support): kamu bisa melihat & export, tapi ubah status lead khusus admin."
            : undefined
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {TABS.map((t) => (
          <StatusTab
            key={t.value || "all"}
            label={t.label}
            count={t.countKey ? counts?.[t.countKey] ?? 0 : grandTotal}
            total={grandTotal}
            tone={t.tone}
            active={status === t.value}
            onClick={() => setStatus(t.value)}
          />
        ))}
      </div>

      <Section>
        <FilterBar
          actions={
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">
                {isLoading ? "memuat…" : `${total.toLocaleString("id-ID")} lead`}
              </span>
              <button
                type="button"
                onClick={onExport}
                disabled={total === 0 || exporting}
                title={
                  total === 0
                    ? "Tak ada lead untuk diexport"
                    : `Export ${total.toLocaleString("id-ID")} baris sesuai filter aktif (kolom: tanggal, nama, email, WhatsApp, tier, sumber, UTM, status, note).`
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {exporting && <Loader2 className="size-3.5 animate-spin" />}
                {exporting ? "Menyiapkan…" : "Export CSV"}
              </button>
            </div>
          }
        >
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="Cari email, nama, atau WhatsApp…"
            scopeHint="email, nama, WhatsApp"
          />
          <div className="w-44">
            <Select value={status} onChange={setStatus} options={FILTER_OPTIONS} placeholder="Semua status" />
          </div>
          <div className="w-44">
            <Select value={tier} onChange={setTier} options={tierOptions} placeholder="Semua tier" />
          </div>
          <div className="w-44">
            <Select value={source} onChange={setSource} options={sourceOptions} placeholder="Semua sumber" />
          </div>
        </FilterBar>

        {isError && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <span>{errorToBahasa(error)}</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-200 hover:bg-red-500/20"
            >
              Coba lagi
            </button>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(l) => l.id}
          isLoading={isLoading && !data}
          empty={tableEmpty}
        />

        <Pagination
          page={curPage}
          totalPages={totalPages}
          onPage={setPage}
          pageSize={respPageSize}
          onPageSize={setPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          total={total}
        />
      </Section>
    </div>
  );
}
