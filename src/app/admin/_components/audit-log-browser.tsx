"use client";

import { useState } from "react";
import { Download, ScrollText } from "lucide-react";
import {
  useAdminQuery,
  fmtDateTime,
  errorToBahasa,
  useToast,
  Badge,
  StatusBadge,
  TabIntro,
  Section,
  EmptyState,
  FilterBar,
  Combobox,
  DateField,
  FormRow,
  DataTable,
  Pagination,
  Drawer,
  KeyValueGrid,
  type Option,
  type StatusMap,
  type Column,
} from "./ui";

type Row = {
  id: string;
  ts: string;
  event: string;
  outcome: string;
  actorHash: string | null;
  targetHash: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
};
type Resp = { rows: Row[]; page: number; pageSize: number; total: number; events: string[] };

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Outcome enum from the route (audit-log/route.ts eq exact). Tone + Bahasa label
// + tooltip distinguishing "ditolak" (intentional block) vs "error" (system fail).
const OUTCOME_MAP: StatusMap = {
  ok: { tone: "ok", label: "Berhasil", hint: "Aksi berhasil dijalankan." },
  reject: {
    tone: "warn",
    label: "Ditolak",
    hint: "Aksi sengaja dicegah (mis. izin kurang / validasi gagal).",
  },
  error: {
    tone: "bad",
    label: "Error",
    hint: "Sistem gagal tak terduga saat menjalankan aksi.",
  },
};

const OUTCOME_FILTER: { value: string; label: string }[] = [
  { value: "", label: "Semua outcome" },
  { value: "ok", label: "Berhasil (ok)" },
  { value: "reject", label: "Ditolak (reject)" },
  { value: "error", label: "Error (error)" },
];

function HashCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-600">—</span>;
  return (
    <span title={value} className="font-mono text-[11px] text-zinc-500">
      {value.length > 12 ? `${value.slice(0, 12)}…` : value}
    </span>
  );
}

export function AuditLogBrowser() {
  const { toast } = useToast();
  const [event, setEvent] = useState("");
  const [outcome, setOutcome] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);

  // Build the query params the route reads: event=ilike substring (combobox
  // value), outcome=eq exact, from/to inclusive day bounds, page + pageSize.
  const buildParams = () => {
    const p = new URLSearchParams();
    if (event) p.set("event", event);
    if (outcome) p.set("outcome", outcome);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p;
  };

  const listParams = buildParams();
  listParams.set("page", String(page));
  listParams.set("pageSize", String(pageSize));
  const url = `/api/admin/audit-log?${listParams.toString()}`;

  const { data, isFetching, isError, refetch } = useAdminQuery<Resp>(
    ["admin", "audit", event, outcome, from, to, page, pageSize],
    url,
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const respPageSize = data?.pageSize ?? pageSize;
  const totalPages = Math.max(1, Math.ceil(total / respPageSize));
  const curPage = data?.page ?? page;
  const hasFilters = Boolean(event || outcome || from || to);

  // Distinct event names from the route → combobox options (search still works
  // via Combobox's built-in substring filter; allowCustom keeps free-text).
  const eventOptions: Option[] = (data?.events ?? []).map((e) => ({ value: e, label: e }));

  const setEventFilter = (v: string) => {
    setEvent(v);
    setPage(1);
  };
  const setOutcomeFilter = (v: string) => {
    setOutcome(v);
    setPage(1);
  };
  const setFromFilter = (v: string) => {
    setFrom(v);
    setPage(1);
  };
  const setToFilter = (v: string) => {
    setTo(v);
    setPage(1);
  };
  const setPageSizeFilter = (n: number) => {
    setPageSize(n);
    setPage(1);
  };
  const resetFilters = () => {
    setEvent("");
    setOutcome("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const csvParams = buildParams();
      csvParams.set("format", "csv");
      const res = await fetch(`/api/admin/audit-log?${csvParams.toString()}`);
      if (res.status === 429) {
        toast(errorToBahasa("RATE_LIMITED"), { tone: "bad" });
        return;
      }
      if (!res.ok) {
        toast(errorToBahasa(`HTTP ${res.status}`), { tone: "bad" });
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "audit-log.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      toast("Ekspor CSV dimulai.", { tone: "ok" });
    } catch (err) {
      toast(errorToBahasa(err), { tone: "bad" });
    } finally {
      setExporting(false);
    }
  };

  const copyDetail = async (r: Row) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r.details ?? {}, null, 2));
      toast("Detail JSON disalin.", { tone: "ok" });
    } catch {
      toast("Gagal menyalin.", { tone: "bad" });
    }
  };

  const columns: Column<Row>[] = [
    {
      key: "ts",
      header: "Waktu",
      cell: (r) => <span className="whitespace-nowrap text-zinc-500">{fmtDateTime(r.ts)}</span>,
      className: "whitespace-nowrap",
    },
    {
      key: "event",
      header: "Event",
      cell: (r) => <span className="font-mono text-[12px] text-zinc-200">{r.event}</span>,
    },
    {
      key: "outcome",
      header: "Outcome",
      cell: (r) => <StatusBadge value={r.outcome} map={OUTCOME_MAP} />,
    },
    {
      key: "actorHash",
      header: "Pelaku",
      cell: (r) => <HashCell value={r.actorHash} />,
    },
    {
      key: "targetHash",
      header: "Target",
      cell: (r) => <HashCell value={r.targetHash} />,
    },
    {
      key: "details",
      header: "Detail",
      cell: (r) =>
        r.details ? (
          <span className="text-[11px] text-cyan-400/80">Lihat detail →</span>
        ) : (
          <span className="text-zinc-600">—</span>
        ),
    },
  ];

  return (
    <div>
      <TabIntro
        eyebrow="OPS · AUDIT LOG"
        title="Jejak Audit"
        what="Catatan semua aksi penting di sistem. Identifier pelaku & target di-hash demi melindungi PII."
        canDo={[
          "Cari & saring jejak per event dan hasil (outcome).",
          "Klik baris untuk lihat konteks lengkap kejadian (bukan JSON mentah).",
          "Salin detail JSON satu kejadian untuk investigasi.",
        ]}
        how="Ketik kata kunci event (mis. 'cms', 'payout') + pilih outcome → klik baris untuk detail. Telusuri antar halaman di bawah tabel."
        legend={[
          { tone: "ok", label: "Berhasil (ok)" },
          { tone: "warn", label: "Ditolak (reject)" },
          { tone: "bad", label: "Error (error)" },
        ]}
        warning="Identifier di-hash demi privasi. Pemetaan hash→user hanya lewat tools internal saat investigasi resmi."
      />

      <Section title="Audit log" desc={`${total.toLocaleString("id-ID")} baris tercatat`}>
        <FilterBar
          actions={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void exportCsv()}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-50"
              >
                <Download className="size-3.5" />
                {exporting ? "Mengekspor…" : "Ekspor CSV"}
              </button>
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
              >
                {isFetching ? "Memuat…" : "Refresh"}
              </button>
            </div>
          }
        >
          <div className="w-48">
            <Combobox
              value={event}
              onChange={setEventFilter}
              options={eventOptions}
              allowCustom
              loading={isFetching && eventOptions.length === 0}
              placeholder="Semua event"
            />
          </div>
          <select
            value={outcome}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            aria-label="Filter outcome"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30 [color-scheme:dark]"
          >
            {OUTCOME_FILTER.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="w-40">
            <FormRow label="Dari tanggal" htmlFor="audit-from">
              <DateField id="audit-from" value={from} onChange={setFromFilter} />
            </FormRow>
          </div>
          <div className="w-40">
            <FormRow label="Sampai tanggal" htmlFor="audit-to">
              <DateField id="audit-to" value={to} onChange={setToFilter} />
            </FormRow>
          </div>
        </FilterBar>

        {isError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {errorToBahasa("Gagal memuat.")}{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium underline">
              Coba lagi
            </button>
          </div>
        ) : (
          <DataTable<Row>
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            isLoading={isFetching && rows.length === 0}
            onRowClick={(r) => setDetail(r)}
            empty={
              hasFilters ? (
                <EmptyState
                  icon={<ScrollText className="size-8" />}
                  title="Tidak ada log cocok filter ini."
                  body="Longgarkan event, outcome, atau rentang tanggal."
                  action={
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Reset filter
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<ScrollText className="size-8" />}
                  title="Belum ada aktivitas tercatat."
                  body="Aksi admin & sistem akan muncul di sini setelah terjadi."
                />
              )
            }
          />
        )}

        {total > 0 && (
          <Pagination
            page={curPage}
            totalPages={totalPages}
            onPage={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
            pageSize={respPageSize}
            onPageSize={setPageSizeFilter}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            total={total}
          />
        )}
      </Section>

      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title="Detail kejadian"
        subtitle={detail ? detail.event : undefined}
        width="max-w-lg"
      >
        {detail && (
          <div className="space-y-4">
            <KeyValueGrid
              items={[
                { label: "Waktu", value: fmtDateTime(detail.ts) },
                {
                  label: "Event",
                  value: <span className="font-mono text-[12px]">{detail.event}</span>,
                },
                {
                  label: "Outcome",
                  value: <StatusBadge value={detail.outcome} map={OUTCOME_MAP} />,
                },
                {
                  label: "Pelaku (hash)",
                  value: detail.actorHash ? (
                    <span className="break-all font-mono text-[11px]">{detail.actorHash}</span>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Target (hash)",
                  value: detail.targetHash ? (
                    <span className="break-all font-mono text-[11px]">{detail.targetHash}</span>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "IP",
                  value: detail.ip ? <span className="font-mono text-[11px]">{detail.ip}</span> : "—",
                },
              ]}
            />

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  Konteks
                </span>
                {detail.details ? (
                  <button
                    type="button"
                    onClick={() => void copyDetail(detail)}
                    className="text-xs font-medium text-cyan-400 hover:text-cyan-300"
                  >
                    Salin JSON
                  </button>
                ) : null}
              </div>
              {detail.details && Object.keys(detail.details).length > 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <dl className="space-y-1">
                    {Object.entries(detail.details).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 text-xs">
                        <dt className="shrink-0 font-mono text-zinc-500">{k}</dt>
                        <dd className="break-all text-right font-medium text-zinc-200">
                          {typeof v === "object" ? JSON.stringify(v) : String(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : (
                <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-500">
                  Tidak ada konteks tambahan.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 border-t border-zinc-800 pt-3">
              <Badge tone="muted">id: {detail.id.slice(0, 8)}</Badge>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
