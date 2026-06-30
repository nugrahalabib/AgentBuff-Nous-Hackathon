"use client";

import { useState } from "react";
import {
  Banknote,
  Download,
  HelpCircle,
  Info,
  MoreVertical,
  RefreshCw,
  Undo2,
} from "lucide-react";
import {
  apiFetch,
  Badge,
  ConfirmDialog,
  Combobox,
  DataTable,
  EmptyState,
  errorToBahasa,
  FilterBar,
  fmtDateTime,
  FormRow,
  Pagination,
  RoleGate,
  SearchInput,
  Select,
  StatusBadge,
  TabIntro,
  useAdminMutation,
  useAdminQuery,
  useToast,
  type Column,
  type Option,
  type StatusMap,
  type Tone,
} from "./ui";

type Row = {
  id: string;
  email: string | null;
  type: string;
  description: string;
  amountRp: number;
  status: string;
  paymentMethod: string | null;
  midtransOrderId: string | null;
  paidAt: string | null;
  createdAt: string;
};
type Resp = { rows: Row[]; page: number; pageSize: number; total: number };
type Metrics = {
  mrr: number;
  arpu: number;
  activeSubs: number;
  revenueCompleted: number;
  pendingCount: number;
  refundedTotal: number;
  undeliveredTotal: number;
  undeliveredCount: number;
};

// --- Enums (grounded in the action route + schema). Single source so the
// filter dropdowns, status badge, and refundable check never drift. ---

const TRANSACTION_TYPES: Option[] = [
  { value: "subscription", label: "Langganan", hint: "subscription" },
  { value: "topup", label: "Top-up", hint: "topup" },
  { value: "skill-install", label: "Install skill", hint: "skill-install" },
];

// Status -> tone + label + hint. install_failed added (was missing from the
// old <select>) — it is refundable (REFUNDABLE in the action route) and is what
// the "Belum terkirim" card counts.
const TRANSACTION_STATUS_MAP: StatusMap = {
  pending: { tone: "warn", label: "Pending", hint: "Menunggu pembayaran / webhook" },
  completed: { tone: "ok", label: "Completed", hint: "Lunas & ter-settle" },
  installed: { tone: "ok", label: "Installed", hint: "Lunas & skill terpasang" },
  install_failed: {
    tone: "bad",
    label: "Install failed",
    hint: "Dibayar tapi skill gagal install — bisa di-refund",
  },
  failed: { tone: "bad", label: "Failed", hint: "Pembayaran gagal / dibatalkan" },
  refunded: { tone: "info", label: "Refunded", hint: "Sudah ditandai dikembalikan" },
};

const TRANSACTION_STATUSES: Option[] = Object.entries(TRANSACTION_STATUS_MAP).map(
  ([value, e]) => ({ value, label: e.label, hint: e.hint, tone: e.tone }),
);

// Money-received statuses an admin can refund (mirrors REFUNDABLE in the action
// route). install_failed = paid but the skill never installed — still refundable.
const PAID_STATUSES = new Set(["completed", "installed", "install_failed"]);

// Preset refund reasons (stored verbatim as text into refundReason, cap 300).
const REFUND_REASON_PRESETS: Option[] = [
  { value: "Duplikat", label: "Duplikat" },
  { value: "Permintaan user", label: "Permintaan user" },
  { value: "Skill rusak / gagal", label: "Skill rusak / gagal" },
  { value: "Indikasi fraud", label: "Indikasi fraud" },
];

const PAGE_SIZE = 25; // default page size; backend clamps to [25, 50, 100].
const MAX_Q = 100;
const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

const STATUS_LEGEND: { tone: Tone; label: string }[] = Object.values(
  TRANSACTION_STATUS_MAP,
).map((e) => ({ tone: e.tone, label: e.label }));

// --- Metric card with a "?" definition tooltip ---

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-1 text-xs text-zinc-500">
        {label}
        <HelpCircle className="size-3 text-zinc-600" aria-label={hint}>
          <title>{hint}</title>
        </HelpCircle>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-white">{value}</div>
      <div className="mt-1 text-[11px] text-zinc-600">{hint}</div>
    </div>
  );
}

// --- Per-row kebab menu (Refund / Cek status / no-action) ---

function RowActions({
  row,
  role,
  reconciling,
  onRefund,
  onReconcile,
}: {
  row: Row;
  role: string;
  reconciling: boolean;
  onRefund: (r: Row) => void;
  onReconcile: (r: Row) => void;
}) {
  const [open, setOpen] = useState(false);
  const canRefund = PAID_STATUSES.has(row.status);
  const canReconcile = row.status === "pending" && Boolean(row.midtransOrderId);

  if (!canRefund && !canReconcile) {
    return (
      <span
        className="text-zinc-700"
        title="Tidak ada aksi: status bukan refundable & bukan pending."
      >
        —
      </span>
    );
  }

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        aria-label="Aksi transaksi"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-zinc-700 p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
      >
        <MoreVertical className="size-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 py-1 shadow-xl">
            {canRefund && (
              <RoleGate need="admin" role={role} fallbackTitle="Refund khusus admin">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onRefund(row);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-300 hover:bg-zinc-800"
                >
                  <Undo2 className="size-3.5 shrink-0" />
                  Tandai refunded (tidak kirim uang)
                </button>
              </RoleGate>
            )}
            {canReconcile && (
              <RoleGate need="admin" role={role} fallbackTitle="Cek status khusus admin">
                <button
                  type="button"
                  disabled={reconciling}
                  onClick={() => {
                    setOpen(false);
                    onReconcile(row);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                  title="Tarik status terbaru dari Midtrans untuk transaksi pending."
                >
                  <RefreshCw className={reconciling ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"} />
                  Cek status (reconcile)
                </button>
              </RoleGate>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// --- Legend popover ("Arti status") ---

function StatusLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Info className="size-3.5" /> Arti status
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-30 mt-1 w-64 rounded-md border border-zinc-800 bg-zinc-900 p-3 shadow-xl">
            <ul className="space-y-1.5">
              {Object.entries(TRANSACTION_STATUS_MAP).map(([value, e]) => (
                <li key={value} className="flex items-start gap-2 text-[11px]">
                  <Badge tone={e.tone}>{e.label}</Badge>
                  <span className="text-zinc-400">{e.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// `role` is optional so the existing call site `<TransactionsBrowser />` keeps
// working (defaults to admin); real enforcement is server-side getAdminMutator.
export function TransactionsBrowser({ role = "admin" }: { role?: string }) {
  const { toast } = useToast();

  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const metrics = useAdminQuery<Metrics>(["admin", "revenue"], "/api/admin/metrics/revenue");

  // Filter-only params, shared by the list query and the CSV export (export
  // ignores page/pageSize and caps its own row count, so those stay out of here).
  const buildParams = () => {
    const p = new URLSearchParams();
    const trimmed = q.trim().slice(0, MAX_Q);
    if (trimmed) p.set("q", trimmed);
    if (type) p.set("type", type);
    if (status) p.set("status", status);
    return p;
  };

  const list = useAdminQuery<Resp>(
    ["admin", "transactions", q.trim().slice(0, MAX_Q), type, status, page, pageSize],
    "",
    {
      queryFn: () => {
        const p = buildParams();
        p.set("page", String(page));
        p.set("pageSize", String(pageSize));
        return apiFetch<Resp>(`/api/admin/transactions?${p.toString()}`);
      },
    },
  );

  // --- Refund modal state ---
  const [confirmRow, setConfirmRow] = useState<Row | null>(null);
  const [reasonPreset, setReasonPreset] = useState<string>("");
  const [customReason, setCustomReason] = useState("");
  const isCustomReason = reasonPreset === "__other__";

  const closeRefund = () => {
    setConfirmRow(null);
    setReasonPreset("");
    setCustomReason("");
  };

  const act = useAdminMutation<
    { id: string; action: "refund" | "reconcile"; reason?: string },
    { ok: boolean; status: string }
  >(
    (v) =>
      apiFetch<{ ok: boolean; status: string }>(`/api/admin/transactions/${v.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: v.action, reason: v.reason }),
      }),
    {
      invalidate: [
        ["admin", "transactions"],
        ["admin", "revenue"],
      ],
      successMessage: (data, vars) =>
        vars.action === "refund"
          ? "Transaksi ditandai refunded. Lakukan pengembalian uang manual di Midtrans."
          : `Status terbaru: ${data.status}`,
      onSuccess: (_data, vars) => {
        if (vars.action === "refund") closeRefund();
      },
    },
  );

  const doReconcile = (row: Row) => {
    act.mutate({ id: row.id, action: "reconcile" });
  };

  const submitRefund = () => {
    if (!confirmRow) return;
    const reason = (isCustomReason ? customReason.trim() : reasonPreset).slice(0, 300) || undefined;
    act.mutate({ id: confirmRow.id, action: "refund", reason });
  };

  const exportCsv = async () => {
    const p = buildParams();
    try {
      const res = await fetch(`/api/admin/transactions/export?${p.toString()}`);
      if (res.status === 429) {
        toast("Terlalu sering. Coba lagi 1 menit.", { tone: "bad" });
        return;
      }
      if (!res.ok) {
        toast(errorToBahasa(`HTTP ${res.status}`), { tone: "bad" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(errorToBahasa(e), { tone: "bad" });
    }
  };

  const resetFilters = () => {
    setQ("");
    setType("");
    setStatus("");
    setPage(1);
  };

  const onPageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const data = list.data;
  const total = data?.total ?? 0;
  const effectivePageSize = data?.pageSize ?? pageSize;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const curPage = data?.page ?? page;
  const m = metrics.data;
  const hasFilters = Boolean(q.trim() || type || status);

  const reconcilingId =
    act.isPending && act.variables?.action === "reconcile" ? act.variables.id : null;

  const columns: Column<Row>[] = [
    {
      key: "createdAt",
      header: "Waktu",
      cell: (r) => <span className="whitespace-nowrap text-zinc-500">{fmtDateTime(r.createdAt)}</span>,
    },
    { key: "email", header: "User", cell: (r) => <span className="text-zinc-300">{r.email ?? "—"}</span> },
    {
      key: "type",
      header: "Tipe",
      cell: (r) => {
        const known = TRANSACTION_TYPES.find((t) => t.value === r.type);
        return known ? (
          <span className="text-zinc-400">{known.label}</span>
        ) : (
          <Badge tone="muted">tipe lain: {r.type}</Badge>
        );
      },
    },
    {
      key: "description",
      header: "Deskripsi",
      cell: (r) => (
        <span className="block max-w-xs truncate text-zinc-400" title={r.description}>
          {r.description}
        </span>
      ),
    },
    {
      key: "amountRp",
      header: "Nominal",
      align: "right",
      cell: (r) => <span className="whitespace-nowrap tabular-nums text-zinc-200">{rp(r.amountRp)}</span>,
    },
    { key: "paymentMethod", header: "Metode", cell: (r) => <span className="text-zinc-500">{r.paymentMethod ?? "—"}</span> },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge value={r.status} map={TRANSACTION_STATUS_MAP} />,
    },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (r) => (
        <RowActions
          row={r}
          role={role}
          reconciling={reconcilingId === r.id}
          onRefund={(row) => setConfirmRow(row)}
          onReconcile={doReconcile}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <TabIntro
        eyebrow="OPS · TRANSAKSI"
        title="Buku Besar Transaksi & Revenue"
        what="Catatan semua uang masuk (langganan, top-up, install skill) plus 6 kartu kesehatan revenue. Ini cermin DB AgentBuff, bukan dashboard Midtrans."
        canDo={[
          "Cari & saring transaksi (per Order ID, deskripsi, tipe, status).",
          "Baca 6 metrik revenue: MRR, ARPU, settled, pending, refunded, belum-terkirim.",
          "Refund — tandai transaksi refunded di DB kita (TIDAK mengirim uang; refund manual di Midtrans).",
          "Cek status (reconcile) — tarik ulang status pembayaran Midtrans untuk transaksi pending.",
          "Export CSV sesuai filter aktif.",
        ]}
        how="Saring dulu (mis. Status = Install failed untuk lihat yang dibayar tapi gagal install) lalu tindak per baris lewat menu Aksi, atau Export CSV untuk rekap. Refund di sini hanya langkah administratif — refund uang aslinya dilakukan operator di Midtrans."
        legend={STATUS_LEGEND}
        warning="Refund di tab ini hanya menandai status. Pengembalian uang asli dilakukan manual oleh operator di dashboard Midtrans."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="MRR (estimasi)" value={m ? rp(m.mrr) : "…"} hint={`${m?.activeSubs ?? 0} langganan aktif, dinormalkan ke nilai bulanan`} />
        <MetricCard label="ARPU" value={m ? rp(m.arpu) : "…"} hint="Revenue settled dibagi jumlah user berbayar" />
        <MetricCard label="Revenue settled" value={m ? rp(m.revenueCompleted) : "…"} hint="Transaksi completed + installed" />
        <MetricCard label="Pending" value={m ? String(m.pendingCount) : "…"} hint="Menunggu pembayaran / webhook" />
        <MetricCard label="Refunded" value={m ? rp(m.refundedTotal) : "…"} hint="Total sudah ditandai dikembalikan" />
        <MetricCard label="Belum terkirim" value={m ? rp(m.undeliveredTotal) : "…"} hint={`${m?.undeliveredCount ?? 0} dibayar tapi skill gagal install (install_failed) — wajib ditindak`} />
      </div>

      <FilterBar
        actions={
          <>
            <StatusLegend />
            <button
              type="button"
              onClick={exportCsv}
              title="Ekspor mengikuti filter aktif. Maks 10.000 baris. Kolom: tanggal, email, tipe, deskripsi, nominal, status, metode, order ID."
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Download className="size-3.5" /> Export CSV
            </button>
            <span className="text-xs text-zinc-500">
              {list.isFetching ? "memuat…" : `${total.toLocaleString("id-ID")} transaksi`}
            </span>
          </>
        }
      >
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Cari Order ID / deskripsi…"
          scopeHint="Order ID & deskripsi (bukan email — pakai User Hub untuk cari per user)"
        />
        <div className="w-44">
          <Select
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={TRANSACTION_TYPES}
            placeholder="Semua tipe"
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={TRANSACTION_STATUSES}
            placeholder="Semua status"
          />
        </div>
      </FilterBar>

      {list.isError ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>Gagal memuat transaksi.</span>
          <button
            type="button"
            onClick={() => list.refetch()}
            className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-200 hover:bg-red-500/10"
          >
            Coba lagi
          </button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={(r) => r.id}
        isLoading={list.isLoading}
        empty={
          hasFilters ? (
            <EmptyState
              icon={<Banknote className="size-8" />}
              title="Tidak ada transaksi cocok."
              body="Longgarkan filter atau reset."
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
              icon={<Banknote className="size-8" />}
              title="Belum ada transaksi."
              body="Akan muncul begitu ada pembayaran pertama."
            />
          )
        }
      />

      <Pagination
        page={curPage}
        totalPages={totalPages}
        onPage={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
        pageSize={effectivePageSize}
        onPageSize={onPageSize}
        total={total}
      />

      <ConfirmDialog
        open={Boolean(confirmRow)}
        danger
        loading={act.isPending && act.variables?.action === "refund"}
        title="Tandai transaksi refunded?"
        confirmLabel="Ya, tandai refunded"
        onConfirm={submitRefund}
        onCancel={closeRefund}
        body={
          <div className="space-y-3">
            <p>
              Aksi ini hanya menandai status transaksi menjadi{" "}
              <span className="font-semibold text-amber-300">refunded</span> di sistem AgentBuff —
              <span className="font-semibold text-zinc-200"> TIDAK mengirim uang</span>. Pengembalian
              dana dilakukan manual oleh operator di dashboard Midtrans.
            </p>
            {confirmRow?.type === "subscription" && (
              <p className="text-xs text-zinc-500">
                Langganan user (jika ada) TIDAK dibatalkan otomatis — cabut akses lewat menu Kontainer
                kalau perlu.
              </p>
            )}
            <FormRow label="Alasan refund" help="Opsional, tersimpan permanen untuk audit. Maks 300 karakter.">
              <Combobox
                value={reasonPreset}
                onChange={setReasonPreset}
                options={[...REFUND_REASON_PRESETS, { value: "__other__", label: "Lainnya (tulis…)" }]}
                placeholder="Pilih alasan…"
                emptyText="Tidak ada preset cocok"
              />
            </FormRow>
            {isCustomReason && (
              <FormRow label="Tulis alasan" htmlFor="refund-custom-reason">
                <input
                  id="refund-custom-reason"
                  value={customReason}
                  maxLength={300}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="mis. kasus khusus / detail tambahan"
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                />
              </FormRow>
            )}
          </div>
        }
        summary={
          confirmRow
            ? [
                { label: "Order ID", value: confirmRow.midtransOrderId ?? "—" },
                { label: "User", value: confirmRow.email ?? "—" },
                { label: "Deskripsi", value: confirmRow.description },
                { label: "Nominal", value: rp(confirmRow.amountRp) },
                {
                  label: "Status",
                  value: TRANSACTION_STATUS_MAP[confirmRow.status]?.label ?? confirmRow.status,
                  tone: TRANSACTION_STATUS_MAP[confirmRow.status]?.tone ?? "muted",
                },
              ]
            : undefined
        }
      />
    </div>
  );
}
