"use client";

import { useState, type ReactNode } from "react";
import {
  // data
  apiFetch,
  useAdminQuery,
  useAdminMutation,
  useToast,
  // primitives
  TabIntro,
  Section,
  KeyValueGrid,
  Badge,
  StatusBadge,
  EmptyState,
  fmtDate,
  str,
  USER_ROLES,
  type StatusMap,
  // form
  FormRow,
  Select,
  SegmentedControl,
  NumberStepper,
  // table
  DataTable,
  FilterBar,
  SearchInput,
  Pagination,
  type Column,
  // overlay
  Drawer,
  ConfirmDialog,
} from "./ui";

// --------------------------------------------------------------------------
// Types (mirror the admin API shapes — unchanged contract)
// --------------------------------------------------------------------------

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  suspended: boolean | null;
  createdAt: string;
  onboarded: boolean | null;
  nickname: string | null;
  containerStatus: string | null;
  trialStatus: string | null;
  subTier: string | null;
  subStatus: string | null;
};

type ListResp = {
  rows: UserRow[];
  page: number;
  pageSize: number;
  total: number;
};

type Detail = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    suspended: boolean | null;
    suspendedReason: string | null;
    suspendedAt: string | null;
    deletionScheduledAt: string | null;
    deletionReason: string | null;
    createdAt: string;
  };
  profile: Record<string, unknown> | null;
  container: Record<string, unknown> | null;
  trial: { status: string; endsAt: string } | null;
  activeSub: Record<string, unknown> | null;
  energy: { balance: number; maxBalance: number } | null;
  counts: { agents: number; skills: number; transactions: number };
  recentTransactions: {
    id: string;
    type: string;
    description: string;
    amountRp: number;
    status: string;
    createdAt: string;
  }[];
};

// --------------------------------------------------------------------------
// Status maps (drive StatusBadge — single source of label + tone + hint)
// --------------------------------------------------------------------------

const CONTAINER_MAP: StatusMap = {
  queued: { tone: "warn", label: "queued", hint: "Antre provisioning" },
  starting: { tone: "warn", label: "starting", hint: "Sedang menyala" },
  "awaiting-health": { tone: "warn", label: "awaiting-health", hint: "Cek sehat" },
  running: { tone: "ok", label: "running", hint: "Aktif" },
  failed: { tone: "bad", label: "failed", hint: "Gagal provisioning" },
  stopped: { tone: "muted", label: "stopped", hint: "Dimatikan" },
  destroyed: { tone: "bad", label: "destroyed", hint: "Dihancurkan" },
};

const TRIAL_MAP: StatusMap = {
  active: { tone: "ok", label: "active", hint: "Trial berjalan" },
  converted: { tone: "info", label: "converted", hint: "Jadi pelanggan" },
  expired: { tone: "warn", label: "expired", hint: "Trial habis" },
};

const SUB_MAP: StatusMap = {
  starter: { tone: "muted", label: "starter", hint: "Gratis" },
  op_buff: { tone: "info", label: "op_buff", hint: "Rp 99k" },
  guild_master: { tone: "ok", label: "guild_master", hint: "Enterprise" },
};

const TX_MAP: StatusMap = {
  completed: { tone: "ok", label: "completed" },
  installed: { tone: "ok", label: "installed" },
  pending: { tone: "warn", label: "pending" },
  failed: { tone: "bad", label: "failed" },
  install_failed: { tone: "bad", label: "install_failed" },
};

// Preset reasons reused by suspend + schedule-delete (plan: same enum).
const REASON_OPTIONS = [
  { value: "fraud", label: "Fraud / Penyalahgunaan" },
  { value: "payment", label: "Masalah pembayaran" },
  { value: "manual_review", label: "Permintaan manual / review" },
  { value: "tos", label: "Pelanggaran ToS" },
  { value: "other", label: "Lainnya" },
] as const;

const REASON_LABEL: Record<string, string> = Object.fromEntries(
  REASON_OPTIONS.map((r) => [r.value, r.label]),
);

const TRIAL_PRESETS = [7, 14, 30];

// --------------------------------------------------------------------------
// UsersBrowser — top-level tab
// --------------------------------------------------------------------------

export function UsersBrowser({ role }: { role?: "admin" | "support" } = {}) {
  const canMutate = role !== "support";
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useAdminQuery<ListResp>(
    ["admin", "users", q, page, pageSize],
    `/api/admin/users?${new URLSearchParams({
      ...(q ? { q } : {}),
      page: String(page),
      pageSize: String(pageSize),
    }).toString()}`,
  );

  const total = data?.total ?? 0;
  const effectivePageSize = data?.pageSize ?? pageSize;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const curPage = data?.page ?? page;
  const rows = data?.rows ?? [];

  const onPageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const onSearch = (v: string) => {
    setQ(v.trim().slice(0, 100));
    setPage(1);
  };

  const columns: Column<UserRow>[] = [
    {
      key: "email",
      header: "Email",
      cell: (u) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-zinc-200">{u.email ?? "—"}</span>
          {u.suspended ? <Badge tone="bad">suspend</Badge> : null}
        </span>
      ),
    },
    {
      key: "name",
      header: "Nama",
      cell: (u) => <span className="text-zinc-400">{u.nickname ?? u.name ?? "—"}</span>,
    },
    {
      key: "role",
      header: "Role",
      cell: (u) =>
        u.role === "admin" ? (
          <Badge tone="ok">admin</Badge>
        ) : u.role === "support" ? (
          <Badge tone="info">support</Badge>
        ) : (
          <span className="text-zinc-600">user</span>
        ),
    },
    {
      key: "onboarded",
      header: "Onboard",
      cell: (u) => (u.onboarded ? <Badge tone="ok">ya</Badge> : <Badge tone="muted">belum</Badge>),
    },
    {
      key: "trial",
      header: "Trial",
      cell: (u) => <StatusBadge value={u.trialStatus} map={TRIAL_MAP} />,
    },
    {
      key: "sub",
      header: "Langganan",
      cell: (u) => <StatusBadge value={u.subTier} map={SUB_MAP} />,
    },
    {
      key: "container",
      header: "Kontainer",
      cell: (u) => <StatusBadge value={u.containerStatus} map={CONTAINER_MAP} />,
    },
    {
      key: "createdAt",
      header: "Dibuat",
      cell: (u) => <span className="text-zinc-500">{fmtDate(u.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <TabIntro
        eyebrow="OPS · PENGGUNA"
        title="Pengguna"
        what="Pusat kendali semua akun pengguna AgentBuff — telusuri, periksa detail, dan jalankan aksi admin (role, trial, suspend, hapus, kontainer)."
        canDo={[
          "Cari user (email/nama) lalu buka kartu detail: akun, profil, kontainer, langganan/trial, statistik, transaksi.",
          "Ubah role (user/support/admin), perpanjang trial (1–90 hari), tangguhkan / cabut, jadwalkan hapus (grace 1–30 hari) / batalkan.",
          "Masuk sebagai user (impersonate) untuk reproduksi masalah.",
          "Reprovision / Destroy kontainer user.",
        ]}
        how="1) Ketik di kotak cari → 2) Klik baris user → kartu detail kebuka di kanan → 3) Pilih aksi; aksi berbahaya minta konfirmasi yang menyebut target. Aksi suspend/hapus/perpanjang otomatis stop/start kontainer user."
        legend={[
          { tone: "ok", label: "running / active" },
          { tone: "warn", label: "starting / expired" },
          { tone: "bad", label: "failed / suspend" },
          { tone: "muted", label: "stopped / belum" },
        ]}
      />

      <Section
        title="Daftar pengguna"
        desc="Cari di email & nama saja (bukan nickname/ID/WhatsApp). Maks 100 karakter."
        actions={
          <span className="text-xs tabular-nums text-zinc-500">
            {isLoading ? "memuat…" : `${total.toLocaleString("id-ID")} pengguna`}
          </span>
        }
      >
        <FilterBar>
          <SearchInput
            value={q}
            onChange={onSearch}
            placeholder="Cari email atau nama…"
            scopeHint="email & nama"
          />
        </FilterBar>

        <DataTable<UserRow>
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          isLoading={isLoading}
          onRowClick={(u) => setSelectedId(u.id)}
          empty={
            isError ? (
              <EmptyState
                title="Gagal memuat pengguna"
                body="Terjadi kesalahan saat mengambil data."
                action={
                  <button
                    type="button"
                    onClick={() => void refetch()}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                  >
                    Coba lagi
                  </button>
                }
              />
            ) : (
              <EmptyState
                title={q ? `Tak ada user cocok "${q}"` : "Belum ada pengguna"}
                body={q ? "Coba kata kunci lain atau bersihkan pencarian." : undefined}
                action={
                  q ? (
                    <button
                      type="button"
                      onClick={() => onSearch("")}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                    >
                      Bersihkan pencarian
                    </button>
                  ) : undefined
                }
              />
            )
          }
        />

        <Pagination
          page={curPage}
          totalPages={totalPages}
          onPage={(p) => setPage(Math.max(1, Math.min(totalPages, p)))}
          pageSize={effectivePageSize}
          onPageSize={onPageSize}
          total={total}
        />
      </Section>

      {selectedId ? (
        <UserDetailDrawer
          id={selectedId}
          canMutate={canMutate}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// UserDetailDrawer — detail + admin actions
// --------------------------------------------------------------------------

type ActionPayload = {
  action: string;
  role?: string;
  days?: number;
  reason?: string;
};

function UserDetailDrawer({
  id,
  canMutate = true,
  onClose,
}: {
  id: string;
  canMutate?: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const {
    data: detail,
    isLoading,
    isError,
  } = useAdminQuery<Detail>(["admin", "user", id], `/api/admin/users/${id}`);

  const invalidate = [
    ["admin", "user", id],
    ["admin", "users"],
  ];

  // --- mutations (same endpoints + payloads as before) ---
  const act = useAdminMutation<ActionPayload>(
    (payload) =>
      apiFetch(`/api/admin/users/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    { invalidate },
  );

  const impersonate = useAdminMutation<void, { redirect?: string }>(
    () =>
      apiFetch<{ redirect?: string }>(`/api/admin/users/${id}/impersonate`, {
        method: "POST",
      }),
    {
      onSuccess: (r) => {
        // Hard navigation so the new session cookie is picked up everywhere.
        window.location.href = r.redirect ?? "/app";
      },
    },
  );

  const containerAct = useAdminMutation<string>(
    (action) =>
      apiFetch(`/api/admin/containers/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    {
      invalidate: [
        ["admin", "user", id],
        ["admin", "containers"],
      ],
    },
  );

  // --- form state ---
  const [roleSel, setRoleSel] = useState<string>("");
  const [trialDays, setTrialDays] = useState<number>(7);
  const [suspendReason, setSuspendReason] = useState<string>("fraud");
  const [suspendNote, setSuspendNote] = useState<string>("");
  const [deleteReason, setDeleteReason] = useState<string>("fraud");
  const [deleteNote, setDeleteNote] = useState<string>("");
  const [graceDays, setGraceDays] = useState<number>(7);

  // --- confirm dialogs ---
  const [confirm, setConfirm] = useState<
    | null
    | { kind: "role"; role: string }
    | { kind: "impersonate" }
    | { kind: "suspend" }
    | { kind: "delete" }
    | { kind: "destroy"; containerName: string }
  >(null);

  if (!detail) {
    return (
      <Drawer open onClose={onClose} title="Detail pengguna">
        {isLoading ? (
          <p className="text-sm text-zinc-500">Memuat…</p>
        ) : isError ? (
          <p className="text-sm text-red-300">Gagal memuat detail.</p>
        ) : null}
      </Drawer>
    );
  }

  const u = detail.user;
  const p = detail.profile;
  const c = detail.container;
  const s = detail.activeSub;
  // Support is read-only: every mutating button shares the `busy` disable path,
  // so locking it here disables them all (server also enforces via getAdminMutator).
  const busy =
    !canMutate || act.isPending || impersonate.isPending || containerAct.isPending;
  const effectiveRole = roleSel || u.role;

  const buildReason = (reasonKey: string, note: string): string => {
    const label = REASON_LABEL[reasonKey] ?? reasonKey;
    return note.trim() ? `${label} — ${note.trim()}` : label;
  };

  const runRole = () => {
    const role = (confirm as { role: string }).role;
    act.mutate(
      { action: "set-role", role },
      { onSuccess: () => toast("Role tersimpan.", { tone: "ok" }) },
    );
    setConfirm(null);
  };

  const runSuspend = () => {
    act.mutate(
      { action: "suspend", reason: buildReason(suspendReason, suspendNote) },
      { onSuccess: () => toast("Akun ditangguhkan, kontainer di-stop.", { tone: "ok" }) },
    );
    setConfirm(null);
  };

  const runDelete = () => {
    act.mutate(
      {
        action: "schedule-delete",
        reason: buildReason(deleteReason, deleteNote),
        days: graceDays,
      },
      { onSuccess: () => toast("Penghapusan dijadwalkan (grace aktif).", { tone: "ok" }) },
    );
    setConfirm(null);
  };

  const runImpersonate = () => {
    impersonate.mutate();
    setConfirm(null);
  };

  const runDestroy = () => {
    containerAct.mutate("destroy", {
      onSuccess: () => toast("Kontainer dihancurkan.", { tone: "ok" }),
    });
    setConfirm(null);
  };

  const extendTrial = () => {
    act.mutate(
      { action: "extend-trial", days: trialDays },
      { onSuccess: () => toast(`Trial diperpanjang ${trialDays} hari.`, { tone: "ok" }) },
    );
  };

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={u.email ?? "Detail pengguna"}
        subtitle={
          <span className="inline-flex items-center gap-2 font-mono">
            {id.slice(0, 12)}
            {u.suspended ? <Badge tone="bad">suspend</Badge> : null}
          </span>
        }
        width="max-w-lg"
      >
        <div className="space-y-4">
          {/* --- Akun --- */}
          <DetailSection title="Akun">
            <KeyValueGrid
              items={[
                { label: "Nama", value: str(u.name) },
                { label: "Role", value: <Badge tone="info">{u.role}</Badge> },
                { label: "Dibuat", value: fmtDate(u.createdAt) },
              ]}
            />
          </DetailSection>

          {/* --- Profil --- */}
          {p ? (
            <DetailSection title="Profil">
              <KeyValueGrid
                items={[
                  { label: "Nickname", value: str(p.nickname) },
                  {
                    label: "Onboarded",
                    value: p.onboarded
                      ? "ya"
                      : `belum (step ${str(p.onboardingStep) ?? "0"})`,
                  },
                  { label: "Timezone", value: str(p.timezone) },
                  {
                    label: "Kota / Negara",
                    value:
                      [str(p.city), str(p.country)].filter(Boolean).join(", ") || null,
                  },
                  { label: "Focus", value: str(p.focus) },
                  { label: "WhatsApp", value: str(p.whatsapp) },
                  { label: "Sumber", value: str(p.referralSource) },
                ]}
              />
            </DetailSection>
          ) : null}

          {/* --- Kontainer --- */}
          <DetailSection title="Kontainer">
            {c ? (
              <KeyValueGrid
                items={[
                  {
                    label: "Status",
                    value: <StatusBadge value={str(c.status)} map={CONTAINER_MAP} />,
                  },
                  { label: "Port", value: str(c.port) },
                  { label: "Image", value: str(c.imageVersion) },
                  { label: "Provision attempts", value: str(c.provisionAttempts) ?? "0" },
                  {
                    label: "Last health",
                    value: c.lastHealthAt ? fmtDate(String(c.lastHealthAt)) : null,
                  },
                  ...(c.errorMessage
                    ? [
                        {
                          label: "Error",
                          value: (
                            <span className="text-red-300">{String(c.errorMessage)}</span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              <p className="text-sm text-zinc-600">User belum punya kontainer.</p>
            )}
          </DetailSection>

          {/* --- Langganan & Trial --- */}
          <DetailSection title="Langganan & Trial">
            {s ? (
              <KeyValueGrid
                items={[
                  { label: "Tier", value: <StatusBadge value={str(s.tier)} map={SUB_MAP} /> },
                  { label: "Siklus", value: str(s.billingCycle) },
                  {
                    label: "Berakhir",
                    value: s.expiresAt ? fmtDate(String(s.expiresAt)) : null,
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-zinc-500">Tidak ada langganan aktif.</p>
            )}
            {detail.trial ? (
              <div className="mt-1">
                <KeyValueGrid
                  items={[
                    {
                      label: "Trial",
                      value: <StatusBadge value={detail.trial.status} map={TRIAL_MAP} />,
                    },
                    { label: "Trial berakhir", value: fmtDate(detail.trial.endsAt) },
                  ]}
                />
              </div>
            ) : null}
          </DetailSection>

          {/* --- Statistik --- */}
          <DetailSection title="Statistik">
            <KeyValueGrid
              cols={2}
              items={[
                { label: "Agen", value: String(detail.counts.agents) },
                { label: "Skill terpasang", value: String(detail.counts.skills) },
                { label: "Transaksi", value: String(detail.counts.transactions) },
                ...(detail.energy
                  ? [
                      {
                        label: "Saldo",
                        value: `Rp ${detail.energy.balance.toLocaleString("id-ID")} / Rp ${detail.energy.maxBalance.toLocaleString("id-ID")}`,
                      },
                    ]
                  : []),
              ]}
            />
          </DetailSection>

          {/* --- Aksi admin --- */}
          <DetailSection title="Aksi admin">
            <div className="space-y-4">
              {!canMutate ? (
                <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-3 text-[11px] leading-relaxed text-zinc-400">
                  Role <span className="text-zinc-200">support</span> hanya baca — semua aksi
                  admin di bawah dinonaktifkan.
                </div>
              ) : null}

              {/* Impersonate */}
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-[11px] leading-relaxed text-amber-200/90">
                  Masuk sebagai user ini (login-as). Sesi admin-mu jadi sesi dia sampai
                  logout. Semua tindakan di sesi itu tercatat sebagai impersonasi olehmu.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "impersonate" })}
                  className="mt-2 rounded-md border border-amber-500/50 px-3 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-500/10 disabled:opacity-40"
                >
                  Masuk sebagai user
                </button>
              </div>

              {/* Role */}
              <FormRow
                label="Role"
                help="User=pemakai biasa · Support=baca-saja panel admin · Admin=bisa ubah semua."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl
                    value={effectiveRole}
                    onChange={(v) => setRoleSel(v)}
                    options={USER_ROLES}
                    size="sm"
                  />
                  <button
                    type="button"
                    disabled={busy || effectiveRole === u.role}
                    onClick={() => {
                      if (effectiveRole === "admin") {
                        setConfirm({ kind: "role", role: effectiveRole });
                      } else {
                        act.mutate(
                          { action: "set-role", role: effectiveRole },
                          { onSuccess: () => toast("Role tersimpan.", { tone: "ok" }) },
                        );
                      }
                    }}
                    className="rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-40"
                  >
                    Simpan role
                  </button>
                </div>
              </FormRow>

              {/* Extend trial — only if user has a trial */}
              {detail.trial ? (
                <FormRow
                  label="Perpanjang trial"
                  help="Maks 90 hari. Jika trial masih aktif, ditambah dari sisa waktu; jika sudah lewat, mulai dari hari ini."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <NumberStepper
                      value={trialDays}
                      onChange={setTrialDays}
                      min={1}
                      max={90}
                      step={1}
                      unit="hari"
                      presets={TRIAL_PRESETS}
                    />
                    <button
                      type="button"
                      disabled={busy || trialDays < 1 || trialDays > 90}
                      onClick={extendTrial}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Perpanjang
                    </button>
                  </div>
                </FormRow>
              ) : (
                <p className="text-xs text-zinc-600">
                  User ini tak punya trial — bagian perpanjang disembunyikan.
                </p>
              )}

              {/* Suspend / Unsuspend */}
              {u.suspended ? (
                <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                  <div className="text-[11px] text-red-300">
                    Ditangguhkan
                    {u.suspendedAt ? ` sejak ${fmtDate(u.suspendedAt)}` : ""}
                    {u.suspendedReason ? ` — ${u.suspendedReason}` : ""}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act.mutate(
                        { action: "unsuspend" },
                        { onSuccess: () => toast("Penangguhan dicabut.", { tone: "ok" }) },
                      )
                    }
                    className="rounded-md border border-emerald-600/50 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
                  >
                    Cabut penangguhan
                  </button>
                </div>
              ) : (
                <FormRow
                  label="Tangguhkan (suspend)"
                  help="Menangguhkan akan stop kontainer → akses live user terputus."
                >
                  <div className="space-y-2">
                    <Select
                      value={suspendReason}
                      onChange={setSuspendReason}
                      options={REASON_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
                    />
                    <textarea
                      value={suspendNote}
                      onChange={(e) => setSuspendNote(e.target.value.slice(0, 300))}
                      placeholder="Catatan (opsional)"
                      rows={2}
                      className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-600">{suspendNote.length}/300</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirm({ kind: "suspend" })}
                        className="rounded-md border border-red-600/50 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Tangguhkan
                      </button>
                    </div>
                  </div>
                </FormRow>
              )}

              {/* Schedule-delete / Cancel-delete */}
              {u.deletionScheduledAt ? (
                <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                  <div className="text-[11px] text-red-300">
                    Dijadwalkan dihapus pada {fmtDate(u.deletionScheduledAt)}
                    {u.deletionReason ? ` — ${u.deletionReason}` : ""}. Masih bisa
                    dipulihkan sampai tanggal itu.
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act.mutate(
                        { action: "cancel-delete" },
                        { onSuccess: () => toast("Penghapusan dibatalkan.", { tone: "ok" }) },
                      )
                    }
                    className="rounded-md border border-emerald-600/50 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
                  >
                    Batalkan penghapusan
                  </button>
                </div>
              ) : (
                <FormRow
                  label="Jadwalkan hapus"
                  help="Akun dieksekusi-hapus setelah masa grace. Kontainer di-stop sekarang; bisa dibatalkan sampai tanggal eksekusi."
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-zinc-500">Grace</span>
                      <NumberStepper
                        value={graceDays}
                        onChange={setGraceDays}
                        min={1}
                        max={30}
                        step={1}
                        unit="hari"
                      />
                    </div>
                    <Select
                      value={deleteReason}
                      onChange={setDeleteReason}
                      options={REASON_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
                    />
                    <textarea
                      value={deleteNote}
                      onChange={(e) => setDeleteNote(e.target.value.slice(0, 300))}
                      placeholder="Catatan (opsional)"
                      rows={2}
                      className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-600">{deleteNote.length}/300</span>
                      <button
                        type="button"
                        disabled={busy || graceDays < 1 || graceDays > 30}
                        onClick={() => setConfirm({ kind: "delete" })}
                        className="rounded-md border border-red-600/50 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Jadwalkan hapus
                      </button>
                    </div>
                  </div>
                </FormRow>
              )}

              {/* Container lifecycle */}
              {c ? (
                <FormRow
                  label="Kontainer"
                  help="Reprovision = bangun ulang (skill re-install otomatis). Destroy = hancurkan + volume."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        containerAct.mutate("reprovision", {
                          onSuccess: () => toast("Reprovision dimulai.", { tone: "ok" }),
                        })
                      }
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Reprovision
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setConfirm({
                          kind: "destroy",
                          containerName: str(c.containerName) ?? str(c.status) ?? "kontainer",
                        })
                      }
                      className="rounded-md border border-red-600/50 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                    >
                      Destroy
                    </button>
                  </div>
                </FormRow>
              ) : null}
            </div>
          </DetailSection>

          {/* --- Transaksi terakhir --- */}
          {detail.recentTransactions.length > 0 ? (
            <DetailSection title="Transaksi terakhir">
              <div className="space-y-1.5">
                {detail.recentTransactions.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-zinc-400">{t.description}</span>
                    <span className="shrink-0 tabular-nums text-zinc-300">
                      Rp {t.amountRp.toLocaleString("id-ID")}
                    </span>
                    <StatusBadge value={t.status} map={TX_MAP} />
                  </div>
                ))}
              </div>
            </DetailSection>
          ) : null}
        </div>
      </Drawer>

      {/* --- Confirm dialogs --- */}
      <ConfirmDialog
        open={confirm?.kind === "role"}
        onCancel={() => setConfirm(null)}
        onConfirm={runRole}
        loading={act.isPending}
        title="Beri akses admin penuh?"
        body={`Memberi role admin ke ${u.email ?? id} memberi akses penuh ke seluruh panel admin.`}
        summary={[{ label: "Target", value: u.email ?? id }, { label: "Role baru", value: "admin", tone: "ok" }]}
        confirmLabel="Jadikan admin"
      />

      <ConfirmDialog
        open={confirm?.kind === "impersonate"}
        onCancel={() => setConfirm(null)}
        onConfirm={runImpersonate}
        loading={impersonate.isPending}
        title="Masuk sebagai user ini?"
        body={`Kamu akan masuk ke /app sebagai ${u.email ?? id}. Sesi admin-mu diganti sesi user sampai logout. Semua tindakan tercatat sebagai impersonasi olehmu.`}
        summary={[{ label: "Target", value: u.email ?? id, tone: "warn" }]}
        confirmLabel="Masuk sebagai user"
      />

      <ConfirmDialog
        open={confirm?.kind === "suspend"}
        onCancel={() => setConfirm(null)}
        onConfirm={runSuspend}
        loading={act.isPending}
        danger
        title="Tangguhkan akun ini?"
        body="Kontainer akan di-stop dan akses live user terputus."
        summary={[
          { label: "Target", value: u.email ?? id },
          { label: "Alasan", value: buildReason(suspendReason, suspendNote) },
        ]}
        confirmLabel="Tangguhkan"
      />

      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onCancel={() => setConfirm(null)}
        onConfirm={runDelete}
        loading={act.isPending}
        danger
        typeToConfirm="HAPUS"
        title="Jadwalkan penghapusan akun?"
        body={`Akun dieksekusi-hapus setelah ${graceDays} hari grace. Kontainer di-stop sekarang. Bisa dibatalkan sampai tanggal eksekusi.`}
        summary={[
          { label: "Target", value: u.email ?? id, tone: "bad" },
          { label: "Grace", value: `${graceDays} hari` },
          { label: "Alasan", value: buildReason(deleteReason, deleteNote) },
        ]}
        confirmLabel="Jadwalkan hapus"
      />

      <ConfirmDialog
        open={confirm?.kind === "destroy"}
        onCancel={() => setConfirm(null)}
        onConfirm={runDestroy}
        loading={containerAct.isPending}
        danger
        typeToConfirm="DESTROY"
        title="Hancurkan kontainer?"
        body="Kontainer + volume dihancurkan. Skill akan di-install ulang otomatis jika kontainer dibangun lagi."
        summary={[
          {
            label: "Kontainer",
            value: confirm?.kind === "destroy" ? confirm.containerName : "",
            tone: "bad",
          },
          { label: "User", value: u.email ?? id },
        ]}
        confirmLabel="Destroy"
      />
    </>
  );
}

// Small wrapper around Section so drawer blocks share the eyebrow style without
// re-passing the card chrome that Section assumes for top-level use.
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">{children}</div>
    </div>
  );
}
