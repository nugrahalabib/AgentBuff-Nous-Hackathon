"use client";

import { useMemo, useState } from "react";
import { Ticket, Trash2, Wand2 } from "lucide-react";
import {
  apiFetch,
  Badge,
  ConfirmDialog,
  CurrencyField,
  DataTable,
  DateField,
  EmptyState,
  errorToBahasa,
  fmtDate,
  FormRow,
  NumberStepper,
  SegmentedControl,
  Select,
  Section,
  StatusBadge,
  Toggle,
  useAdminMutation,
  useAdminQuery,
  useFieldId,
  type Column,
  type Option,
} from "./ui";

// D10/D14 — promo coupon manager (sub-panel inside the Harga page). Create codes
// (percent or fixed Rp, optional tier-scope / max-uses / expiry), toggle active,
// edit inline, delete. Restyled to the dark admin kit + spec controls
// (segmented type, stepper/currency value, tier dropdown, unlimited/no-expiry
// toggles, confirm-dialog delete). API contract unchanged.

type Coupon = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
  tierScope: string;
  maxUses: number | null;
  used: number;
  expiresAt: string | null;
  active: boolean;
};

type CouponType = "percent" | "fixed";
type TierScope = "" | "op_buff" | "full_managed";

// Mirrors the API guardrails (createSchema / editSchema in the route).
const MAX_FIXED_VALUE_RP = 100_000_000;
const PERCENT_MIN = 1;
const PERCENT_MAX = 100;
const CODE_MAX = 40;

const QK = ["admin", "coupons"] as const;

const TYPE_OPTIONS: Option<CouponType>[] = [
  { value: "percent", label: "Persen %", hint: "Persen dari tagihan" },
  { value: "fixed", label: "Potongan Rp", hint: "Potongan nominal tetap" },
];

const TIER_OPTIONS: Option<TierScope>[] = [
  { value: "", label: "Semua tier", hint: "Berlaku untuk semua plan" },
  { value: "op_buff", label: "OP Buff", hint: "Rp 99k/bln" },
  { value: "full_managed", label: "Full Managed", hint: "Rp 449k/bln" },
];

const ACTIVE_STATUS_MAP = {
  active: { tone: "ok" as const, label: "Aktif", hint: "Bisa dipakai di checkout" },
  inactive: { tone: "muted" as const, label: "Mati", hint: "Dinonaktifkan — tidak dipakai" },
};

// A native <input type=date> gives "YYYY-MM-DD". Send the END of that day in
// local time as ISO so the coupon stays valid all day, not just until midnight.
function dateToEndOfDayIso(yyyyMmDd: string): string | null {
  if (!yyyyMmDd) return null;
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function isoToDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function generateCode(len = 8): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const arr = new Uint32Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
  } else {
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function discountLabel(c: Pick<Coupon, "type" | "value">): string {
  return c.type === "percent" ? `${c.value}%` : `Rp ${c.value.toLocaleString("id-ID")}`;
}

// --- Shared value control: stepper for percent, currency for fixed ---

function ValueControl({
  id,
  type,
  value,
  onChange,
}: {
  id?: string;
  type: CouponType;
  value: number | null;
  onChange: (v: number) => void;
}) {
  if (type === "percent") {
    return (
      <NumberStepper
        id={id}
        value={value}
        onChange={onChange}
        min={PERCENT_MIN}
        max={PERCENT_MAX}
        step={1}
        unit="%"
        presets={[5, 10, 20, 50]}
        placeholder="1–100"
      />
    );
  }
  return <CurrencyField id={id} value={value} onChange={onChange} min={1} max={MAX_FIXED_VALUE_RP} />;
}

export function CouponManager() {
  const { data, isLoading, error, refetch } = useAdminQuery<{ coupons: Coupon[] }>(QK, "/api/admin/coupons");
  const coupons = useMemo(() => data?.coupons ?? [], [data]);

  // --- Create form ---
  const codeId = useFieldId();
  const valueId = useFieldId();
  const [code, setCode] = useState("");
  const [type, setType] = useState<CouponType>("percent");
  const [value, setValue] = useState<number | null>(null);
  const [tierScope, setTierScope] = useState<TierScope>("");
  const [maxUses, setMaxUses] = useState<number | null>(100);
  const [unlimited, setUnlimited] = useState(true);
  const [expiry, setExpiry] = useState(""); // YYYY-MM-DD
  const [noExpiry, setNoExpiry] = useState(true);
  // Field-scoped error codes so 409/400 land on the right input.
  const [createErr, setCreateErr] = useState<string | null>(null);

  const existingCodes = useMemo(
    () => new Set(coupons.map((c) => c.code.toUpperCase())),
    [coupons],
  );
  const trimmedCode = code.trim().toUpperCase();
  const codeTaken = trimmedCode.length > 0 && existingCodes.has(trimmedCode);

  const resetCreateForm = () => {
    setCode("");
    setValue(null);
    setType("percent");
    setTierScope("");
    setMaxUses(100);
    setUnlimited(true);
    setExpiry("");
    setNoExpiry(true);
    setCreateErr(null);
  };

  const create = useAdminMutation<void, { ok: true; id: string }>(
    () =>
      apiFetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: trimmedCode,
          type,
          value: value ?? 0,
          tierScope,
          maxUses: unlimited ? null : maxUses,
          expiresAt: noExpiry ? null : dateToEndOfDayIso(expiry),
        }),
      }),
    {
      successMessage: "Kupon dibuat.",
      invalidate: [QK],
      onSuccess: resetCreateForm,
      onError: (err) => setCreateErr(err instanceof Error ? err.message : String(err)),
    },
  );

  const codeError =
    codeTaken || (createErr && createErr.toUpperCase().includes("CODE_EXISTS"))
      ? "Kode sudah ada — pilih kode lain."
      : null;
  const valueError =
    createErr && (createErr.toUpperCase().includes("INVALID_PERCENT") || createErr.toUpperCase().includes("VALIDATION"))
      ? "Nilai tidak valid. Periksa rentang."
      : null;

  const valueValid =
    value != null &&
    value > 0 &&
    (type === "percent" ? value >= PERCENT_MIN && value <= PERCENT_MAX : value <= MAX_FIXED_VALUE_RP);
  const canCreate = !create.isPending && trimmedCode.length > 0 && !codeTaken && valueValid;

  const handleCreate = () => {
    setCreateErr(null);
    create.mutate();
  };

  // --- Toggle active ---
  const toggle = useAdminMutation<{ id: string; active: boolean }>(
    (v) =>
      apiFetch(`/api/admin/coupons/${v.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: v.active }),
      }),
    { invalidate: [QK] },
  );

  // --- Inline edit (full field edit via PATCH; code + used are read-only) ---
  const [editId, setEditId] = useState<string | null>(null);
  const [eType, setEType] = useState<CouponType>("percent");
  const [eValue, setEValue] = useState<number | null>(null);
  const [eTier, setETier] = useState<TierScope>("");
  const [eMax, setEMax] = useState<number | null>(null);
  const [eUnlimited, setEUnlimited] = useState(true);
  const [eExpiry, setEExpiry] = useState("");
  const [eNoExpiry, setENoExpiry] = useState(true);
  const [editErr, setEditErr] = useState<string | null>(null);
  const eValueId = useFieldId();

  function startEdit(c: Coupon) {
    setEditId(c.id);
    setEType(c.type);
    setEValue(c.value);
    setETier((c.tierScope as TierScope) || "");
    setEMax(c.maxUses);
    setEUnlimited(c.maxUses == null);
    setEExpiry(isoToDateInput(c.expiresAt));
    setENoExpiry(c.expiresAt == null);
    setEditErr(null);
  }
  const closeEdit = () => {
    setEditId(null);
    setEditErr(null);
  };

  const edit = useAdminMutation<string>(
    (id) =>
      apiFetch(`/api/admin/coupons/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: eType,
          value: eValue ?? 0,
          tierScope: eTier,
          maxUses: eUnlimited ? null : eMax,
          expiresAt: eNoExpiry ? null : dateToEndOfDayIso(eExpiry),
        }),
      }),
    {
      successMessage: "Kupon diperbarui.",
      invalidate: [QK],
      onSuccess: closeEdit,
      onError: (err) => setEditErr(err instanceof Error ? err.message : String(err)),
    },
  );
  const eValueValid =
    eValue != null &&
    eValue > 0 &&
    (eType === "percent" ? eValue >= PERCENT_MIN && eValue <= PERCENT_MAX : eValue <= MAX_FIXED_VALUE_RP);

  // --- Delete (confirm dialog; 409 COUPON_IN_USE surfaced on the row) ---
  const [pendingDelete, setPendingDelete] = useState<Coupon | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);

  const remove = useAdminMutation<Coupon>(
    (c) => apiFetch(`/api/admin/coupons/${c.id}`, { method: "DELETE" }),
    {
      successMessage: "Kupon dihapus.",
      invalidate: [QK],
      onSuccess: () => {
        setPendingDelete(null);
        setRowError(null);
      },
      onError: (err, c) => {
        const raw = err instanceof Error ? err.message : String(err);
        const inUse = raw.toUpperCase().includes("COUPON_IN_USE");
        setRowError({
          id: c.id,
          msg: inUse
            ? "Tidak bisa dihapus — sedang dipakai transaksi pending. Matikan saja (nonaktifkan)."
            : errorToBahasa(err),
        });
        setPendingDelete(null);
      },
    },
  );

  // --- Table columns ---
  const columns: Column<Coupon>[] = [
    {
      key: "code",
      header: "Kode",
      cell: (c) => <span className="font-mono text-zinc-100">{c.code}</span>,
    },
    {
      key: "discount",
      header: "Diskon",
      cell: (c) => <span className="text-zinc-300">{discountLabel(c)}</span>,
    },
    {
      key: "tier",
      header: "Tier",
      cell: (c) => (
        <span className="text-zinc-400">
          {c.tierScope === "op_buff"
            ? "OP Buff"
            : c.tierScope === "full_managed"
              ? "Full Managed"
              : "Semua"}
        </span>
      ),
    },
    {
      key: "used",
      header: "Pakai",
      align: "right",
      cell: (c) => (
        <span className="tabular-nums text-zinc-400">
          {c.used}
          {c.maxUses != null ? ` / ${c.maxUses}` : " / ∞"}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Kadaluarsa",
      cell: (c) => <span className="text-zinc-500">{c.expiresAt ? fmtDate(c.expiresAt) : "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => (
        <Toggle
          checked={c.active}
          disabled={toggle.isPending}
          onChange={(next) => toggle.mutate({ id: c.id, active: next })}
        />
      ),
    },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (c) => (
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => (editId === c.id ? closeEdit() : startEdit(c))}
            className="text-cyan-300 transition hover:text-cyan-200"
          >
            {editId === c.id ? "Tutup" : "Edit"}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              setRowError(null);
              setPendingDelete(c);
            }}
            className="inline-flex items-center gap-1 text-red-400 transition hover:text-red-300 disabled:opacity-40"
          >
            <Trash2 className="size-3.5" /> Hapus
          </button>
        </div>
      ),
    },
  ];

  const editing = editId ? coupons.find((c) => c.id === editId) ?? null : null;

  return (
    <Section
      title="Kupon Promo"
      desc="Kode promo persen atau potongan Rp, dengan batas tier, pemakaian, dan kadaluarsa. Perubahan langsung dipakai checkout."
    >
      <div className="space-y-5">
        {/* Inline note about the discount cap (spec section B note). */}
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
          Potongan otomatis dibatasi tidak melebihi nominal tagihan — kupon Rp 100jt tidak membuat order gratis tak
          terhingga; potongan maksimal = total tagihan.
        </p>

        {/* Create form */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Buat kupon</div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormRow
              label="Kode"
              required
              htmlFor={codeId}
              help="Huruf & angka. Klik Generate untuk kode acak."
              error={codeError}
            >
              <div className="flex items-stretch gap-2">
                <input
                  id={codeId}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, CODE_MAX))}
                  placeholder="PROMO20"
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-sm uppercase tracking-wide text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                />
                <button
                  type="button"
                  onClick={() => {
                    setCode(generateCode());
                    setCreateErr(null);
                  }}
                  title="Buat kode acak"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
                >
                  <Wand2 className="size-3.5" /> Generate
                </button>
              </div>
            </FormRow>

            <FormRow label="Tipe diskon" help="Persen dari tagihan atau potongan nominal tetap.">
              <SegmentedControl<CouponType> value={type} onChange={setType} options={TYPE_OPTIONS} />
            </FormRow>

            <FormRow
              label="Nilai diskon"
              required
              htmlFor={valueId}
              help={
                type === "percent"
                  ? "1–100% dari tagihan."
                  : "Potongan nominal, maks Rp 100.000.000."
              }
              error={valueError}
            >
              <ValueControl id={valueId} type={type} value={value} onChange={setValue} />
            </FormRow>

            <FormRow label="Tier scope" help="Batasi kupon ke tier tertentu, atau berlaku semua.">
              <Select<TierScope> value={tierScope} onChange={setTierScope} options={TIER_OPTIONS} />
            </FormRow>

            <FormRow label="Max pakai" help="Berapa kali total kupon boleh dipakai.">
              <div className="space-y-2">
                <NumberStepper
                  value={maxUses}
                  onChange={setMaxUses}
                  min={1}
                  step={1}
                  presets={[10, 50, 100, 500]}
                  placeholder="100"
                />
                <Toggle checked={unlimited} onChange={setUnlimited} label="Tak terbatas" />
              </div>
            </FormRow>

            <FormRow label="Kadaluarsa" help="Kupon hangus akhir hari (23:59 WIB) pada tanggal ini.">
              <div className="space-y-2">
                <DateField value={expiry} onChange={setExpiry} />
                <Toggle checked={noExpiry} onChange={setNoExpiry} label="Tanpa kadaluarsa" />
              </div>
            </FormRow>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={!canCreate}
              onClick={handleCreate}
              className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-40"
            >
              {create.isPending ? "Membuat…" : "Buat kupon"}
            </button>
            {!valueValid && trimmedCode.length > 0 && (
              <span className="text-[11px] text-zinc-500">
                Isi nilai diskon yang valid untuk membuat kupon.
              </span>
            )}
          </div>
        </div>

        {/* List */}
        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <p>Gagal memuat kupon.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 rounded-md border border-red-500/40 bg-red-500/15 px-3 py-1 text-xs text-red-200 transition hover:bg-red-500/25"
            >
              Coba lagi
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <DataTable
              columns={columns}
              rows={coupons}
              rowKey={(c) => c.id}
              isLoading={isLoading}
              empty={
                <EmptyState
                  icon={<Ticket className="size-8" />}
                  title="Belum ada kupon"
                  body="Buat kupon pertama di form di atas."
                />
              }
            />
            {rowError && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                {rowError.msg}
              </p>
            )}
          </div>
        )}

        {/* Inline edit panel */}
        {editing && (
          <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
                Edit kupon
              </div>
              <button type="button" onClick={closeEdit} className="text-xs text-zinc-400 hover:text-zinc-100">
                Tutup
              </button>
            </div>

            {/* Read-only identity (code + used cannot change). */}
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span className="font-mono text-zinc-100">{editing.code}</span>
              <Badge tone="muted">dipakai {editing.used}×</Badge>
              <StatusBadge value={editing.active ? "active" : "inactive"} map={ACTIVE_STATUS_MAP} />
              <span className="text-zinc-500">Kode &amp; jumlah pakai tidak bisa diubah.</span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FormRow label="Tipe diskon">
                <SegmentedControl<CouponType> value={eType} onChange={setEType} options={TYPE_OPTIONS} />
              </FormRow>
              <FormRow
                label="Nilai diskon"
                htmlFor={eValueId}
                help={type === "percent" ? "1–100%." : "Maks Rp 100.000.000."}
                error={
                  editErr && (editErr.toUpperCase().includes("INVALID_PERCENT") || editErr.toUpperCase().includes("VALIDATION"))
                    ? "Nilai tidak valid. Periksa rentang."
                    : null
                }
              >
                <ValueControl id={eValueId} type={eType} value={eValue} onChange={setEValue} />
              </FormRow>
              <FormRow label="Tier scope">
                <Select<TierScope> value={eTier} onChange={setETier} options={TIER_OPTIONS} />
              </FormRow>
              <FormRow label="Max pakai">
                <div className="space-y-2">
                  <NumberStepper value={eMax} onChange={setEMax} min={1} step={1} presets={[10, 50, 100, 500]} />
                  <Toggle checked={eUnlimited} onChange={setEUnlimited} label="Tak terbatas" />
                </div>
              </FormRow>
              <FormRow label="Kadaluarsa">
                <div className="space-y-2">
                  <DateField value={eExpiry} onChange={setEExpiry} />
                  <Toggle checked={eNoExpiry} onChange={setENoExpiry} label="Tanpa kadaluarsa" />
                </div>
              </FormRow>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                disabled={edit.isPending || !eValueValid}
                onClick={() => {
                  setEditErr(null);
                  edit.mutate(editing.id);
                }}
                className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-40"
              >
                {edit.isPending ? "Menyimpan…" : "Simpan"}
              </button>
              <button type="button" onClick={closeEdit} className="text-sm text-zinc-400 hover:text-zinc-100">
                Batal
              </button>
            </div>
          </div>
        )}

        {/* Delete confirmation */}
        <ConfirmDialog
          open={pendingDelete != null}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
          danger
          loading={remove.isPending}
          title="Hapus kupon?"
          confirmLabel="Hapus permanen"
          body={
            <span>
              Hapus permanen. Tidak bisa jika kupon sedang dipakai transaksi pending — matikan saja kalau begitu.
            </span>
          }
          summary={
            pendingDelete
              ? [
                  { label: "Kode", value: pendingDelete.code },
                  { label: "Diskon", value: discountLabel(pendingDelete) },
                  { label: "Sudah dipakai", value: `${pendingDelete.used}×` },
                ]
              : undefined
          }
        />
      </div>
    </Section>
  );
}
