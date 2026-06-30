"use client";

import { useState } from "react";
import { Banknote, Inbox, RefreshCw } from "lucide-react";
import {
  Badge,
  Combobox,
  ConfirmDialog,
  EmptyState,
  FormRow,
  Section,
  StatusBadge,
  apiFetch,
  errorToBahasa,
  fmtDateTime,
  useAdminMutation,
  useAdminQuery,
  type Option,
  type StatusMap,
} from "./ui";

// C3 Phase C — payout admin surface (Marketplace · Payout sub-panel). Shows the
// commission ledger grouped by seller (eligible = hold elapsed), lets an admin
// set a seller's bank details, create a disbursement batch (CREATOR), approve it
// (a DIFFERENT admin — APPROVER, dual control), and sync Iris status. Live
// actions are disabled until Iris keys are configured.

type LedgerRow = {
  id: string;
  sellerId: string;
  sellerName: string | null;
  grossRp: number;
  commissionRp: number;
  netRp: number;
  period: string;
  status: string;
  eligible: boolean;
};
type BatchRow = {
  id: string;
  sellerId: string;
  sellerName: string | null;
  totalNetRp: number;
  status: string;
  createdBy: string | null;
  approvedBy: string | null;
  submittedAt: string | null;
  approvedAt?: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
};
type PayoutData = { configured: boolean; ledger: LedgerRow[]; batches: BatchRow[] };

// PRD D4 floor: a batch is only created once eligible balance reaches this.
const PAYOUT_MIN_RP = 50_000;
const PAYOUTS_KEY = ["admin", "payouts"] as const;

const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

// Iris-supported beneficiary banks/e-wallets (lowercase codes per Iris API).
// allowCustom keeps niche codes usable without a redeploy.
const BANK_OPTIONS: Option[] = [
  { value: "bca", label: "BCA", hint: "Bank Central Asia" },
  { value: "bni", label: "BNI", hint: "Bank Negara Indonesia" },
  { value: "bri", label: "BRI", hint: "Bank Rakyat Indonesia" },
  { value: "mandiri", label: "Mandiri", hint: "Bank Mandiri" },
  { value: "cimb", label: "CIMB Niaga" },
  { value: "permata", label: "Permata Bank" },
  { value: "danamon", label: "Danamon" },
  { value: "bsi", label: "BSI", hint: "Bank Syariah Indonesia" },
  { value: "btn", label: "BTN", hint: "Bank Tabungan Negara" },
  { value: "mega", label: "Bank Mega" },
  { value: "gopay", label: "GoPay", hint: "E-wallet" },
  { value: "ovo", label: "OVO", hint: "E-wallet" },
  { value: "dana", label: "DANA", hint: "E-wallet" },
  { value: "shopeepay", label: "ShopeePay", hint: "E-wallet" },
];

// Ledger status (pending/batched/paid/failed) — legend + badge.
const LEDGER_STATUS_MAP: StatusMap = {
  pending: { tone: "muted", label: "Pending", hint: "Belum dimasukkan ke batch payout." },
  batched: { tone: "info", label: "Batched", hint: "Sudah masuk batch, menunggu pencairan." },
  paid: { tone: "ok", label: "Paid", hint: "Sudah dicairkan ke seller." },
  failed: { tone: "bad", label: "Failed", hint: "Pencairan gagal — saldo dikembalikan ke pending." },
};

// Batch lifecycle (created/submitted/approved/completed/failed) — legend + badge.
const BATCH_STATUS_MAP: StatusMap = {
  created: { tone: "muted", label: "Created", hint: "Batch dibuat, belum dikirim ke Iris." },
  submitted: { tone: "warn", label: "Submitted", hint: "Terkirim ke Iris, menunggu persetujuan admin lain." },
  approved: { tone: "info", label: "Approved", hint: "Disetujui — Iris memproses transfer." },
  completed: { tone: "ok", label: "Completed", hint: "Transfer selesai." },
  failed: { tone: "bad", label: "Failed", hint: "Gagal di Iris — cek pesan error." },
};

// Money-movement error codes -> specific Bahasa guidance (more precise than the
// shared errorToBahasa fallback for the payout flow).
const PAYOUT_ERROR_BAHASA: Record<string, string> = {
  NO_BENEFICIARY: "Isi rekening seller dulu sebelum membuat batch.",
  SELLER_SUSPENDED: "Seller sedang di-suspend — payout dihentikan.",
  FIRST_PARTY_NO_PAYOUT: "Seller house (first-party) tidak punya payout.",
  BELOW_THRESHOLD: `Di bawah minimum payout ${rp(PAYOUT_MIN_RP)}.`,
  NOTHING_ELIGIBLE: "Belum ada saldo eligible (semua masih dalam masa hold).",
  SELF_APPROVAL_FORBIDDEN: "Tidak bisa menyetujui batch yang kamu buat sendiri — minta admin lain.",
  NOT_APPROVABLE: "Batch sudah tidak bisa disetujui (status berubah). Muat ulang.",
  INVALID_SELLER: "Seller tidak valid.",
  SELLER_NOT_FOUND: "Seller tidak ditemukan. Muat ulang.",
};
const payoutError = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const upper = raw.toUpperCase();
  for (const [code, msg] of Object.entries(PAYOUT_ERROR_BAHASA)) {
    if (upper.includes(code)) return msg;
  }
  return errorToBahasa(e);
};

const hhmm = () =>
  new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

export function PayoutBrowser() {
  const { data, isLoading, isError } = useAdminQuery<PayoutData>(PAYOUTS_KEY, "/api/admin/payouts");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const sync = useAdminMutation<void, { ok: boolean }>(
    () => apiFetch<{ ok: boolean }>("/api/admin/payouts/sync", { method: "POST" }),
    {
      successMessage: "Status Iris disinkronkan.",
      invalidate: [PAYOUTS_KEY],
      onSuccess: () => setSyncedAt(hhmm()),
    },
  );

  if (isLoading) return <div className="text-sm text-zinc-500">Memuat…</div>;
  if (isError || !data)
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        Gagal memuat payout.
      </div>
    );

  // Group pending ledger by seller for the "create batch" action.
  const bySeller = new Map<string, { name: string | null; eligibleNet: number; pendingNet: number }>();
  for (const r of data.ledger) {
    if (r.status !== "pending") continue;
    const g = bySeller.get(r.sellerId) ?? { name: r.sellerName, eligibleNet: 0, pendingNet: 0 };
    g.pendingNet += r.netRp;
    if (r.eligible) g.eligibleNet += r.netRp;
    bySeller.set(r.sellerId, g);
  }
  const sellers = [...bySeller.entries()];

  const syncBtn = (
    <button
      type="button"
      disabled={!data.configured || sync.isPending}
      onClick={() => sync.mutate()}
      title="Tarik status terbaru batch dari Iris."
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <RefreshCw className={sync.isPending ? "size-3.5 animate-spin" : "size-3.5"} />
      {sync.isPending ? "Sinkron…" : "Sinkron status Iris"}
    </button>
  );

  return (
    <div className="space-y-5">
      {!data.configured && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          Iris belum dikonfigurasi (MIDTRANS_IRIS_CREATOR_KEY + APPROVER_KEY). Ledger tetap tercatat; buat/setujui
          batch nonaktif sampai key diisi.
        </div>
      )}

      <Section
        title="Saldo seller"
        desc={`Komisi platform sudah dipotong. Min. payout ${rp(PAYOUT_MIN_RP)} per seller.`}
        actions={
          <div className="flex flex-col items-end gap-0.5">
            {syncBtn}
            {syncedAt && <span className="text-[10px] text-zinc-500">Terakhir sinkron {syncedAt}</span>}
          </div>
        }
      >
        {sellers.length === 0 ? (
          <EmptyState
            icon={<Banknote className="size-8" />}
            title="Belum ada saldo seller."
            body="Saldo muncul setelah ada penjualan seller 3rd-party yang komisinya tercatat."
          />
        ) : (
          <div className="space-y-3">
            {sellers.map(([sellerId, g]) => (
              <SellerPayoutRow
                key={sellerId}
                sellerId={sellerId}
                name={g.name}
                eligibleNet={g.eligibleNet}
                pendingNet={g.pendingNet}
                configured={data.configured}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Batch payout" desc="Riwayat pencairan. Setujui hanya oleh admin berbeda dari pembuat (kontrol ganda).">
        {data.batches.length === 0 ? (
          <EmptyState icon={<Inbox className="size-8" />} title="Belum ada batch." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="border-b border-zinc-800 bg-zinc-900/60 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Seller</th>
                    <th className="px-3 py-2 font-medium">Net</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Dibuat / Disetujui</th>
                    <th className="px-3 py-2 font-medium">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {data.batches.map((b) => (
                    <BatchRowView key={b.id} batch={b} configured={data.configured} />
                  ))}
                </tbody>
              </table>
            </div>
            <StatusLegend />
          </>
        )}
      </Section>
    </div>
  );
}

// --- Status legend (ledger + batch + hold explanation) ---

function StatusLegend() {
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-[11px] text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">Batch:</span>
        {Object.entries(BATCH_STATUS_MAP).map(([k, v]) => (
          <span key={k} title={v.hint}>
            <Badge tone={v.tone}>{v.label}</Badge>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">Ledger:</span>
        {Object.entries(LEDGER_STATUS_MAP).map(([k, v]) => (
          <span key={k} title={v.hint}>
            <Badge tone={v.tone}>{v.label}</Badge>
          </span>
        ))}
      </div>
      <p className="text-zinc-500">
        <span className="font-medium text-zinc-400">Hold</span> = saldo masih dalam masa tahan, belum bisa
        dicairkan. Hanya saldo eligible (hold lewat) yang masuk batch.
      </p>
    </div>
  );
}

// --- Per-seller payout card: bank form + create batch ---

function SellerPayoutRow({
  sellerId,
  name,
  eligibleNet,
  pendingNet,
  configured,
}: {
  sellerId: string;
  name: string | null;
  eligibleNet: number;
  pendingNet: number;
  configured: boolean;
}) {
  const sellerLabel = name ?? sellerId.slice(0, 8);
  const heldNet = Math.max(0, pendingNet - eligibleNet);
  const belowFloor = eligibleNet < PAYOUT_MIN_RP;

  const [openBank, setOpenBank] = useState(false);
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);

  const acctError =
    accountNumber && !/^[0-9]+$/.test(accountNumber) ? "Hanya angka." : null;
  const bankValid = Boolean(bankCode && accountNumber && accountName && !acctError);

  const saveBank = useAdminMutation<void, unknown>(
    () =>
      apiFetch(`/api/admin/sellers/${sellerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutInfo: { bankCode, accountNumber, accountName } }),
      }),
    {
      successMessage: "Rekening seller disimpan.",
      invalidate: [PAYOUTS_KEY],
      onSuccess: () => setOpenBank(false),
    },
  );

  const createBatch = useAdminMutation<void, unknown>(
    () =>
      apiFetch("/api/admin/payouts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId }),
      }),
    {
      successMessage: `Batch payout ${sellerLabel} dibuat.`,
      invalidate: [PAYOUTS_KEY],
      onSuccess: () => setConfirmBatch(false),
      onError: (e) => {
        setConfirmBatch(false);
        // Surface the precise money-movement code (banner inside the card).
        setBatchErr(payoutError(e));
      },
    },
  );

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-200">{sellerLabel}</div>
          <div className="text-xs text-zinc-500">
            Siap dibayar <span className="font-medium text-zinc-300">{rp(eligibleNet)}</span>
            {heldNet > 0 && <span className="text-zinc-600"> · masih hold {rp(heldNet)}</span>}
            <span className="text-zinc-600"> · Min {rp(PAYOUT_MIN_RP)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpenBank((v) => !v)}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-600"
          >
            Rekening
          </button>
          <button
            type="button"
            disabled={!configured || belowFloor || createBatch.isPending}
            onClick={() => {
              setBatchErr(null);
              setConfirmBatch(true);
            }}
            title={
              !configured
                ? "Iris belum dikonfigurasi"
                : belowFloor
                  ? `Belum capai min ${rp(PAYOUT_MIN_RP)}`
                  : undefined
            }
            className="rounded-md bg-cyan-500 px-3 py-1 text-xs font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {belowFloor ? `Belum capai min ${rp(PAYOUT_MIN_RP)}` : "Buat Batch"}
          </button>
        </div>
      </div>

      {openBank && (
        <div className="grid gap-2 border-t border-zinc-800 pt-3 sm:grid-cols-3">
          <FormRow label="Bank tujuan" help="Pilih bank dari daftar Iris." required>
            <Combobox
              value={bankCode}
              onChange={setBankCode}
              options={BANK_OPTIONS}
              placeholder="Pilih bank…"
              allowCustom
              emptyText="Kode bank tidak dikenal — ketik manual"
            />
          </FormRow>
          <FormRow label="No. rekening" help="Hanya angka." error={acctError} required>
            <input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="1234567890"
              inputMode="numeric"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
          </FormRow>
          <FormRow label="Nama pemilik" help="Sesuai buku tabungan." required>
            <input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="Nama lengkap"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
          </FormRow>
          <div className="sm:col-span-3">
            <button
              type="button"
              disabled={!bankValid || saveBank.isPending}
              onClick={() => saveBank.mutate()}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveBank.isPending ? "Menyimpan…" : "Simpan rekening"}
            </button>
          </div>
        </div>
      )}

      {batchErr && <div className="text-xs text-red-300">{batchErr}</div>}

      <ConfirmDialog
        open={confirmBatch}
        onConfirm={() => createBatch.mutate()}
        onCancel={() => setConfirmBatch(false)}
        title="Buat batch payout?"
        body={
          <>
            Saldo eligible akan dicairkan ke <span className="font-medium text-zinc-200">{sellerLabel}</span> via
            Iris. Pastikan rekening sudah benar.
          </>
        }
        summary={[
          { label: "Seller", value: sellerLabel },
          { label: "Nominal", value: rp(eligibleNet), tone: "ok" },
          { label: "Min. payout", value: rp(PAYOUT_MIN_RP) },
        ]}
        confirmLabel="Cairkan"
        loading={createBatch.isPending}
      />
    </div>
  );
}

// --- Batch row: approve (dual control) ---

function BatchRowView({ batch, configured }: { batch: BatchRow; configured: boolean }) {
  const sellerLabel = batch.sellerName ?? batch.sellerId.slice(0, 8);
  const creator = batch.createdBy ? batch.createdBy.slice(0, 8) : "tidak diketahui";
  const [confirmApprove, setConfirmApprove] = useState(false);

  const approve = useAdminMutation<void, unknown>(
    () => apiFetch(`/api/admin/payouts/batch/${batch.id}/approve`, { method: "POST" }),
    {
      successMessage: `Batch ${sellerLabel} disetujui.`,
      invalidate: [PAYOUTS_KEY],
      onSuccess: () => setConfirmApprove(false),
      onError: () => setConfirmApprove(false),
    },
  );

  return (
    <tr className="border-b border-zinc-800/60 last:border-0">
      <td className="px-3 py-2.5 text-zinc-200">{sellerLabel}</td>
      <td className="px-3 py-2.5 tabular-nums text-zinc-200">{rp(batch.totalNetRp)}</td>
      <td className="px-3 py-2.5">
        <StatusBadge value={batch.status} map={BATCH_STATUS_MAP} />
        {batch.lastError && (
          <div title={batch.lastError} className="mt-0.5 max-w-[220px] truncate text-[10px] text-red-300/80">
            {batch.lastError}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-[11px] text-zinc-500">
        <div>{fmtDateTime(batch.submittedAt ?? batch.createdAt)}</div>
        <div className="text-zinc-600">dibuat oleh {creator}</div>
        {batch.approvedBy && <div className="text-emerald-400/70">disetujui oleh {batch.approvedBy.slice(0, 8)}</div>}
      </td>
      <td className="px-3 py-2.5">
        {batch.status === "submitted" ? (
          <button
            type="button"
            disabled={!configured || approve.isPending}
            onClick={() => setConfirmApprove(true)}
            title="Kontrol ganda: harus admin berbeda dari pembuat."
            className="rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-200 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {approve.isPending ? "…" : "Setujui"}
          </button>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>

      <ConfirmDialog
        open={confirmApprove}
        onConfirm={() => approve.mutate()}
        onCancel={() => setConfirmApprove(false)}
        title="Setujui batch payout?"
        body={
          <>
            Kontrol ganda: kamu harus admin yang <span className="font-medium text-zinc-200">berbeda</span> dari
            pembuat. Persetujuan mengirim transfer ke Iris.
          </>
        }
        summary={[
          { label: "Seller", value: sellerLabel },
          { label: "Nominal", value: rp(batch.totalNetRp), tone: "ok" },
          { label: "Dibuat oleh", value: creator },
        ]}
        confirmLabel="Setujui"
        loading={approve.isPending}
      />
    </tr>
  );
}
