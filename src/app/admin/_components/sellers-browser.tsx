"use client";

import { useMemo, useState } from "react";
import { Store, ShieldCheck, Wallet } from "lucide-react";
import {
  apiFetch,
  fmtDate,
  Badge,
  StatusBadge,
  Section,
  EmptyState,
  RoleGate,
  DataTable,
  FilterBar,
  ConfirmDialog,
  Drawer,
  FormRow,
  NumberStepper,
  Combobox,
  useAdminQuery,
  useAdminMutation,
  useToast,
  errorToBahasa,
  type Column,
  type Option,
  type StatusMap,
} from "./ui";

// --- Types (mirror /api/admin/sellers GET row shape exactly) ---

type Seller = {
  id: string;
  type: string;
  displayName: string;
  status: string;
  commissionPct: number | null;
  ownerUserId: string | null;
  createdAt: string;
  listingCount: number;
};
type SellersResp = { rows: Seller[] };

type UserRow = { id: string; email: string | null; name: string | null };
type UsersResp = { rows: UserRow[] };

// Iris-supported Indonesian bank codes (static client list — the API accepts any
// lowercase string; allowCustom lets ops type a code not in this list). Mirrors
// the codes Midtrans Iris recognizes; keeps admins from memorizing free-text.
const BANK_OPTIONS: Option[] = [
  { value: "bca", label: "BCA", hint: "Bank Central Asia" },
  { value: "bni", label: "BNI", hint: "Bank Negara Indonesia" },
  { value: "bri", label: "BRI", hint: "Bank Rakyat Indonesia" },
  { value: "mandiri", label: "Mandiri", hint: "Bank Mandiri" },
  { value: "cimb", label: "CIMB Niaga" },
  { value: "permata", label: "Permata" },
  { value: "danamon", label: "Danamon" },
  { value: "bii", label: "Maybank", hint: "kode iris: bii" },
  { value: "panin", label: "Panin" },
  { value: "btn", label: "BTN", hint: "Bank Tabungan Negara" },
  { value: "mega", label: "Mega" },
  { value: "bsi", label: "BSI", hint: "Bank Syariah Indonesia" },
  { value: "sinarmas", label: "Sinarmas" },
  { value: "ocbc", label: "OCBC NISP" },
  { value: "gopay", label: "GoPay", hint: "e-wallet" },
];

const SELLER_STATUS: StatusMap = {
  active: { tone: "ok", label: "Aktif", hint: "Seller aktif, payout berjalan" },
  suspended: {
    tone: "bad",
    label: "Suspended",
    hint: "Payout dihentikan",
  },
};

const PRECEDENCE_HINT =
  "Komisi = override seller > rule seller > rule kategori > global > 20%.";

const SELLERS_KEY = ["admin", "sellers"] as const;

function isHouse(s: Seller): boolean {
  return s.type === "first_party";
}

function effectiveCommissionLabel(s: Seller): string {
  if (isHouse(s)) return "0% (house)";
  if (s.commissionPct === null) return "global (≈20%)";
  return `${s.commissionPct}%`;
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

// `role` optional so the existing call site `<SellersBrowser />` keeps working.
export function SellersBrowser({ role = "admin" }: { role?: string }) {
  const { data, isLoading, error, refetch } = useAdminQuery<SellersResp>(
    SELLERS_KEY,
    "/api/admin/sellers",
  );
  const rows = data?.rows ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [payoutFor, setPayoutFor] = useState<Seller | null>(null);

  const columns = useMemo<Column<Seller>[]>(
    () => [
      {
        key: "seller",
        header: "Seller",
        cell: (s) => (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-zinc-200">{s.displayName}</span>
            {isHouse(s) ? (
              <Badge tone="info">house</Badge>
            ) : (
              <Badge tone="muted">3rd-party</Badge>
            )}
          </div>
        ),
      },
      {
        key: "listings",
        header: "Listing",
        align: "right",
        cell: (s) => <span className="tabular-nums text-zinc-400">{s.listingCount}</span>,
      },
      {
        key: "commission",
        header: "Komisi efektif",
        align: "right",
        cell: (s) => <CommissionCell seller={s} role={role} />,
      },
      {
        key: "status",
        header: "Status",
        cell: (s) =>
          isHouse(s) ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <StatusBadge value={s.status} map={SELLER_STATUS} />
          ),
      },
      {
        key: "actions",
        header: "Aksi",
        cell: (s) =>
          isHouse(s) ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <SellerActions
              seller={s}
              role={role}
              onOpenPayout={() => setPayoutFor(s)}
            />
          ),
      },
      {
        key: "createdAt",
        header: "Dibuat",
        cell: (s) => (
          <span className="whitespace-nowrap text-zinc-500">{fmtDate(s.createdAt)}</span>
        ),
      },
    ],
    [role],
  );

  return (
    <Section
      title="Seller"
      desc={`House + 3rd-party. Atur komisi, suspend, dan rekening payout. ${PRECEDENCE_HINT}`}
      actions={
        <RoleGate need="admin" role={role} fallbackTitle="Buat seller khusus admin">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
          >
            + Seller 3rd-party
          </button>
        </RoleGate>
      }
    >
      <FilterBar>
        <span className="text-xs text-zinc-500">
          {isLoading ? "memuat…" : `${rows.length} seller`}
        </span>
      </FilterBar>

      {error ? (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {errorToBahasa(error)}{" "}
          <button
            type="button"
            onClick={() => void refetch()}
            className="ml-1 font-medium text-red-200 underline-offset-2 hover:underline"
          >
            Coba lagi
          </button>
        </div>
      ) : null}

      <DataTable<Seller>
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        isLoading={isLoading}
        empty={
          <EmptyState
            icon={<Store className="size-8" />}
            title="Belum ada seller."
            body="Buat seller 3rd-party untuk mulai mengelola komisi & payout."
            action={
              <RoleGate need="admin" role={role}>
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
                >
                  + Seller 3rd-party
                </button>
              </RoleGate>
            }
          />
        }
      />

      <CreateSellerDrawer open={showCreate} onClose={() => setShowCreate(false)} />

      {payoutFor ? (
        <PayoutDrawer
          seller={payoutFor}
          role={role}
          onClose={() => setPayoutFor(null)}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Commission cell — PctStepper, auto-save on commit (no separate Set button)
// ---------------------------------------------------------------------------

function CommissionCell({ seller, role }: { seller: Seller; role: string }) {
  const { toast } = useToast();

  const setPct = useAdminMutation<number | null, unknown>(
    (commissionPct) =>
      apiFetch(`/api/admin/sellers/${seller.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commissionPct }),
      }),
    {
      invalidate: [SELLERS_KEY],
      onSuccess: (_d, commissionPct) =>
        toast(
          commissionPct === null
            ? `Komisi ${seller.displayName} = pakai global`
            : `Komisi ${seller.displayName} = ${commissionPct}%`,
          { tone: "ok" },
        ),
    },
  );

  if (isHouse(seller)) {
    return <span className="text-zinc-600">0% (house)</span>;
  }

  // Read-only for support: show the effective label only.
  if (role !== "admin") {
    return (
      <span title={PRECEDENCE_HINT} className="text-zinc-300">
        {effectiveCommissionLabel(seller)}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <NumberStepper
        value={seller.commissionPct}
        onChange={(v) => setPct.mutate(v)}
        min={0}
        max={100}
        step={1}
        unit="%"
        placeholder="global"
      />
      <span className="text-[10px] text-zinc-500">
        {seller.commissionPct === null
          ? "kosong = pakai global (≈20%)"
          : "override aktif"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions — suspend/activate (confirm) + open payout drawer
// ---------------------------------------------------------------------------

function SellerActions({
  seller,
  role,
  onOpenPayout,
}: {
  seller: Seller;
  role: string;
  onOpenPayout: () => void;
}) {
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  const setStatus = useAdminMutation<"active" | "suspended", unknown>(
    (status) =>
      apiFetch(`/api/admin/sellers/${seller.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    {
      invalidate: [SELLERS_KEY],
      successMessage: (_d, status) =>
        status === "suspended"
          ? `${seller.displayName} disuspend.`
          : `${seller.displayName} diaktifkan.`,
      onSuccess: () => setConfirmSuspend(false),
    },
  );

  const isActive = seller.status === "active";

  return (
    <div className="flex items-center gap-1.5">
      <RoleGate need="admin" role={role} fallbackTitle="Ubah status khusus admin">
        {isActive ? (
          <button
            type="button"
            disabled={setStatus.isPending}
            onClick={() => setConfirmSuspend(true)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-40"
          >
            Suspend
          </button>
        ) : (
          <button
            type="button"
            disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("active")}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-40"
          >
            Aktifkan
          </button>
        )}
      </RoleGate>

      <button
        type="button"
        onClick={onOpenPayout}
        className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-cyan-500/50 hover:text-cyan-200"
      >
        <Wallet className="size-3" /> Rekening
      </button>

      <ConfirmDialog
        open={confirmSuspend}
        onCancel={() => setConfirmSuspend(false)}
        onConfirm={() => setStatus.mutate("suspended")}
        title={`Suspend ${seller.displayName}?`}
        body="Suspend menyetop semua payout seller ini. Bisa diaktifkan lagi nanti."
        danger
        loading={setStatus.isPending}
        confirmLabel="Suspend"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create seller drawer — name (counter), commission (stepper), owner (combobox)
// ---------------------------------------------------------------------------

const NAME_MAX = 80;

function CreateSellerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [commissionPct, setCommissionPct] = useState<number | null>(null);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  // Reset fields each open without an effect (adjust-state-during-render).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDisplayName("");
      setCommissionPct(null);
      setOwnerUserId("");
      setNameError(null);
    }
  }

  // Owner picker: search users; only fetch while drawer is open.
  const { data: usersData, isLoading: usersLoading } = useAdminQuery<UsersResp>(
    ["admin", "users", "owner-picker"],
    "/api/admin/users",
    { enabled: open },
  );
  const ownerOptions: Option[] = useMemo(
    () =>
      (usersData?.rows ?? []).map((u) => ({
        value: u.id,
        label: u.name || u.email || u.id,
        hint: u.email ?? undefined,
      })),
    [usersData],
  );

  const create = useAdminMutation<void, unknown>(
    () =>
      apiFetch("/api/admin/sellers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          commissionPct,
          ownerUserId: ownerUserId || null,
        }),
      }),
    {
      invalidate: [SELLERS_KEY],
      successMessage: () => `Seller "${displayName.trim()}" dibuat.`,
      onSuccess: () => onClose(),
    },
  );

  const submit = () => {
    const name = displayName.trim();
    if (!name) {
      setNameError("Nama seller wajib diisi.");
      return;
    }
    setNameError(null);
    create.mutate();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Seller 3rd-party baru"
      subtitle="Komisi kosong = pakai rule global saat ini."
    >
      <div className="space-y-4">
        <FormRow
          label="Nama seller"
          required
          help={`Nama tampilan seller. Maks ${NAME_MAX} karakter.`}
          error={nameError}
          htmlFor="seller-name"
        >
          <div className="relative">
            <input
              id="seller-name"
              value={displayName}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="mis. Studio Kreatif"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 pr-14 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-zinc-500">
              {displayName.length} / {NAME_MAX}
            </span>
          </div>
        </FormRow>

        <FormRow
          label="Komisi %"
          help="Kosong = pakai rule global saat ini (mis. 20%). Tidak disimpan sebagai 20."
        >
          <NumberStepper
            value={commissionPct}
            onChange={(v) => setCommissionPct(v)}
            min={0}
            max={100}
            step={1}
            unit="%"
            placeholder="global"
          />
        </FormRow>

        <FormRow
          label="Owner (opsional)"
          help="Hubungkan seller ke akun user (nama/email). Boleh dikosongkan."
        >
          <Combobox
            value={ownerUserId}
            onChange={(v) => setOwnerUserId(v)}
            options={ownerOptions}
            loading={usersLoading}
            placeholder="Pilih akun user…"
            emptyText="Tidak ada user cocok"
          />
        </FormRow>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending || !displayName.trim()}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {create.isPending ? "Membuat…" : "Buat seller"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Payout drawer — bank combobox + account (digit-only) + holder + email,
// per-field errors, then validate via Iris (disabled when info incomplete)
// ---------------------------------------------------------------------------

type ValidateResult =
  | { kind: "ok"; accountName: string; matches: boolean }
  | { kind: "error"; message: string };

function ValidateResultBanner({ result }: { result: ValidateResult }) {
  if (result.kind === "error") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
        {result.message}
      </div>
    );
  }
  return (
    <div
      className={
        result.matches
          ? "flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
          : "flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
      }
    >
      <ShieldCheck className="size-3.5 shrink-0" />
      <span>
        {result.accountName} —{" "}
        {result.matches ? "cocok" : "TIDAK cocok dengan nama pemilik"}
      </span>
    </div>
  );
}

function PayoutDrawer({
  seller,
  role,
  onClose,
}: {
  seller: Seller;
  role: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [vres, setVres] = useState<ValidateResult | null>(null);

  const canEdit = role === "admin";

  const validateFields = (): boolean => {
    const next: Record<string, string | null> = {};
    if (!bankCode.trim()) next.bankCode = "Kode bank wajib.";
    if (!accountNumber.trim()) next.accountNumber = "No. rekening wajib.";
    else if (!/^[0-9]+$/.test(accountNumber)) next.accountNumber = "Hanya angka.";
    if (!accountName.trim()) next.accountName = "Nama pemilik wajib.";
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = "Format email tidak valid.";
    setErrors(next);
    return Object.values(next).every((e) => !e);
  };

  const save = useAdminMutation<void, unknown>(
    () =>
      apiFetch(`/api/admin/sellers/${seller.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payoutInfo: {
            bankCode: bankCode.trim().toLowerCase(),
            accountNumber: accountNumber.trim(),
            accountName: accountName.trim(),
            ...(email.trim() ? { email: email.trim() } : {}),
          },
        }),
      }),
    {
      successMessage: "Rekening tersimpan.",
      onSuccess: () => setVres(null),
    },
  );

  // Validate beneficiary via Iris — custom queryFn-style mutation hitting the
  // dedicated POST route; raw apiFetch so we can read accountName/matches.
  const validate = useAdminMutation<
    void,
    { kind: "ok"; accountName: string; matches: boolean }
  >(
    () =>
      apiFetch<{ accountName?: string; matches?: boolean }>(
        `/api/admin/sellers/${seller.id}/validate-beneficiary`,
        { method: "POST" },
      ).then((d) => ({
        kind: "ok" as const,
        accountName: d.accountName ?? "?",
        matches: !!d.matches,
      })),
    {
      onSuccess: (res) => {
        setVres(res);
        toast(
          res.matches ? "Rekening cocok." : "Nama rekening TIDAK cocok.",
          { tone: res.matches ? "ok" : "bad" },
        );
      },
      onError: (err) => {
        setVres({ kind: "error", message: errorToBahasa(err) });
      },
    },
  );

  const handleSave = () => {
    if (!validateFields()) return;
    save.mutate();
  };

  // Validate disabled until the (locally entered) bank+account are filled.
  const validateDisabled =
    validate.isPending || !bankCode.trim() || !accountNumber.trim();

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Rekening payout — ${seller.displayName}`}
      subtitle="Bank dari daftar Iris. Validasi cek akun ada + nama cocok."
      width="max-w-lg"
    >
      <div className="space-y-4">
        <FormRow
          label="Kode bank"
          required
          help="Pilih bank tujuan. Daftar resmi Iris."
        >
          <Combobox
            value={bankCode}
            onChange={(v) => {
              setBankCode(v.toLowerCase());
              setErrors((e) => ({ ...e, bankCode: null }));
            }}
            options={BANK_OPTIONS}
            allowCustom
            disabled={!canEdit}
            placeholder="Pilih bank…"
            emptyText="Tidak ada bank cocok"
          />
          {errors.bankCode ? (
            <p className="text-[11px] text-red-400">{errors.bankCode}</p>
          ) : null}
        </FormRow>

        <FormRow
          label="No. rekening"
          required
          help="Hanya angka."
          error={errors.accountNumber}
          htmlFor="payout-account"
        >
          <input
            id="payout-account"
            inputMode="numeric"
            value={accountNumber}
            disabled={!canEdit}
            onChange={(e) => {
              setAccountNumber(e.target.value.replace(/[^\d]/g, ""));
              setErrors((er) => ({ ...er, accountNumber: null }));
            }}
            placeholder="1234567890"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm tabular-nums text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-zinc-900/50 disabled:text-zinc-600"
          />
        </FormRow>

        <FormRow
          label="Nama pemilik"
          required
          help="Sesuai nama persis di rekening bank (dicocokkan saat validasi Iris)."
          error={errors.accountName}
          htmlFor="payout-holder"
        >
          <input
            id="payout-holder"
            value={accountName}
            disabled={!canEdit}
            onChange={(e) => {
              setAccountName(e.target.value);
              setErrors((er) => ({ ...er, accountName: null }));
            }}
            placeholder="mis. Budi Santoso"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-zinc-900/50 disabled:text-zinc-600"
          />
        </FormRow>

        <FormRow
          label="Email beneficiary (opsional)"
          help="Opsional. Untuk notifikasi payout."
          error={errors.email}
          htmlFor="payout-email"
        >
          <input
            id="payout-email"
            type="email"
            value={email}
            disabled={!canEdit}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((er) => ({ ...er, email: null }));
            }}
            placeholder="payout@contoh.com"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-zinc-900/50 disabled:text-zinc-600"
          />
        </FormRow>

        {vres ? <ValidateResultBanner result={vres} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <RoleGate
            need="admin"
            role={role}
            fallbackTitle="Validasi rekening khusus admin"
          >
            <button
              type="button"
              onClick={() => validate.mutate()}
              disabled={validateDisabled}
              title={
                validateDisabled
                  ? "Isi kode bank & no. rekening dulu"
                  : "Cek lewat Iris: akun ada & nama cocok."
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-cyan-500/50 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ShieldCheck className="size-3.5" />
              {validate.isPending ? "Memvalidasi…" : "Validasi rekening"}
            </button>
          </RoleGate>

          <RoleGate
            need="admin"
            role={role}
            fallbackTitle="Simpan rekening khusus admin"
          >
            <button
              type="button"
              onClick={handleSave}
              disabled={save.isPending}
              className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {save.isPending ? "Menyimpan…" : "Simpan rekening"}
            </button>
          </RoleGate>
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-500">
          Validasi mengecek rekening yang sudah tersimpan di server. Simpan dulu
          jika baru mengubah field di atas.
        </p>
      </div>
    </Drawer>
  );
}
