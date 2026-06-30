"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import {
  fmtDate,
  Badge,
  StatusBadge,
  Section,
  TabIntro,
  EmptyState,
  SegmentedControl,
  Select,
  FilterBar,
  Pagination,
  DataTable,
  useAdminQuery,
  type Option,
  type StatusMap,
  type Column,
} from "./ui";

const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
const PAGE_SIZE = 25;

// --- Enums (anti-drift: filter dropdowns derive from these) ---

const SUB_STATUS_OPTIONS: Option[] = [
  { value: "active", label: "Active", hint: "Berlangganan & masih berlaku", tone: "ok" },
  { value: "expired", label: "Expired", hint: "Periode habis", tone: "warn" },
  { value: "canceled", label: "Canceled", hint: "Dibatalkan user/admin", tone: "muted" },
];

// PLANS minus starter — starter gratis tidak punya baris langganan.
const SUB_TIER_OPTIONS: Option[] = [
  { value: "op_buff", label: "OP Buff", hint: "Rp 99k/bln", tone: "info" },
  { value: "full_managed", label: "Full Managed", hint: "Rp 449k/bln", tone: "info" },
  { value: "guild_master", label: "Guild Master", hint: "Enterprise · custom", tone: "ok" },
];

const TRIAL_STATUS_OPTIONS: Option[] = [
  { value: "active", label: "Active", hint: "Trial 14 hari berjalan", tone: "ok" },
  { value: "converted", label: "Converted", hint: "Berhasil jadi pelanggan", tone: "info" },
  { value: "expired", label: "Expired", hint: "Trial habis tanpa upgrade", tone: "warn" },
];

const SUB_STATUS_MAP: StatusMap = {
  active: { tone: "ok", label: "Active", hint: "Berlangganan & masih berlaku" },
  expired: { tone: "warn", label: "Expired", hint: "Periode habis" },
  canceled: { tone: "muted", label: "Canceled", hint: "Dibatalkan" },
  pending: { tone: "info", label: "Pending", hint: "Menunggu pembayaran" },
  grace: { tone: "warn", label: "Grace", hint: "Masa tenggang" },
};

const TRIAL_STATUS_MAP: StatusMap = {
  active: { tone: "ok", label: "Active", hint: "Trial 14 hari berjalan" },
  converted: { tone: "info", label: "Converted", hint: "Berhasil jadi pelanggan" },
  expired: { tone: "warn", label: "Expired", hint: "Trial habis tanpa upgrade" },
};

function MiniCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2" title={hint}>
      <div className="flex items-center gap-1 text-[11px] text-zinc-500">
        {label}
        {hint && <Info className="size-3 text-zinc-600" />}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}

function ReadOnlyBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Tab ini <span className="font-semibold">hanya baca</span>. Cancel / perpanjang langganan
        dilakukan dari menu terkait (User Hub / Kontainer).
      </span>
    </div>
  );
}

function ErrorBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      <span>Gagal memuat data.</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-500/20"
      >
        Coba lagi
      </button>
    </div>
  );
}

export function SubscriptionsBrowser() {
  const [tab, setTab] = useState<"subs" | "trials">("subs");
  return (
    <div className="space-y-4">
      <TabIntro
        eyebrow="OPS · LANGGANAN & TRIAL"
        title="Langganan & Trial"
        what="Pantauan siapa berlangganan apa & status trial 14 hari. Ini layar pantau, bukan layar tindak."
        canDo={[
          "Saring & baca daftar langganan (tier, siklus, harga, kadaluarsa, auto-renew, status).",
          "Baca kartu jumlah aktif per tier.",
          "Pantau funnel trial: aktif, konversi, expired, conversion rate, ledger anti-farm.",
        ]}
        how="Saring untuk menemukan baris lalu baca. Untuk mencabut/perpanjang langganan atau kontainer, buka menu Kontainer / User Hub — tab ini sengaja tanpa aksi mutasi."
        legend={[
          { tone: "ok", label: "Active / Converted" },
          { tone: "warn", label: "Expired" },
          { tone: "muted", label: "Canceled" },
          { tone: "info", label: "Pending" },
        ]}
      />

      <SegmentedControl<"subs" | "trials">
        value={tab}
        onChange={setTab}
        options={[
          { value: "subs", label: "Langganan" },
          { value: "trials", label: "Trial" },
        ]}
      />

      <ReadOnlyBanner />

      {tab === "subs" ? <SubsView /> : <TrialsView />}
    </div>
  );
}

// --- Langganan ---

type SubRow = {
  id: string;
  email: string | null;
  tier: string;
  status: string;
  billingCycle: string;
  priceRp: number;
  startsAt: string;
  expiresAt: string;
  autoRenew: boolean;
  createdAt: string;
};
type SubsResp = {
  rows: SubRow[];
  page: number;
  pageSize: number;
  total: number;
  metrics: { byTier: { tier: string; c: number }[] };
};

function tierLabel(tier: string): string {
  return SUB_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier;
}

function SubsView() {
  const [status, setStatus] = useState("");
  const [tier, setTier] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const qs = (() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (tier) p.set("tier", tier);
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    return p.toString();
  })();

  const { data, isFetching, isError, refetch } = useAdminQuery<SubsResp>(
    ["admin", "subs", status, tier, page, pageSize],
    `/api/admin/subscriptions?${qs}`,
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize ?? pageSize)));
  const curPage = data?.page ?? page;
  const hasFilters = Boolean(status || tier);

  const resetFilters = () => {
    setStatus("");
    setTier("");
    setPage(1);
  };

  const handlePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
  };

  const columns: Column<SubRow>[] = [
    { key: "user", header: "User", cell: (r) => <span className="text-zinc-200">{r.email ?? "—"}</span> },
    { key: "tier", header: "Tier", cell: (r) => <span className="text-zinc-300">{tierLabel(r.tier)}</span> },
    {
      key: "cycle",
      header: "Siklus",
      cell: (r) => <span className="text-zinc-400">{r.billingCycle === "yearly" ? "Tahunan" : "Bulanan"}</span>,
    },
    {
      key: "price",
      header: "Harga",
      align: "right",
      cell: (r) => <span className="whitespace-nowrap tabular-nums text-zinc-200">{rp(r.priceRp)}</span>,
    },
    {
      key: "expires",
      header: "Berakhir",
      cell: (r) => <span className="whitespace-nowrap text-zinc-400">{fmtDate(r.expiresAt)}</span>,
    },
    {
      key: "auto",
      header: (
        <span
          className="inline-flex items-center gap-1"
          title="Model kami sekali bayar per periode. 'Auto' = user menyetujui perpanjangan otomatis bila nanti diaktifkan; mayoritas Manual."
        >
          Auto <Info className="size-3 text-zinc-600" />
        </span>
      ),
      cell: (r) => <Badge tone={r.autoRenew ? "info" : "muted"}>{r.autoRenew ? "Auto" : "Manual"}</Badge>,
    },
    { key: "status", header: "Status", cell: (r) => <StatusBadge value={r.status} map={SUB_STATUS_MAP} /> },
  ];

  return (
    <Section
      title="Daftar langganan"
      desc="Read-only. Filter untuk menemukan baris, lalu baca."
      actions={
        <span className="text-xs text-zinc-500">
          {isFetching ? "memuat…" : `${total.toLocaleString("id-ID")} langganan`}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {data?.metrics.byTier.length ? (
            data.metrics.byTier.map((t) => (
              <MiniCard
                key={t.tier}
                label={`Aktif · ${tierLabel(t.tier)}`}
                value={String(t.c)}
                hint="Hanya menghitung status active. Expired & canceled tidak masuk hitungan."
              />
            ))
          ) : (
            <MiniCard
              label="Langganan aktif"
              value="0"
              hint="Hanya menghitung status active. Expired & canceled tidak masuk hitungan."
            />
          )}
        </div>

        <FilterBar>
          <div className="w-44">
            <Select
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={SUB_STATUS_OPTIONS}
              placeholder="Semua status"
            />
          </div>
          <div className="w-48">
            <Select
              value={tier}
              onChange={(v) => {
                setTier(v);
                setPage(1);
              }}
              options={SUB_TIER_OPTIONS}
              placeholder="Semua tier"
            />
          </div>
          <span className="text-[11px] text-zinc-500">
            Starter tidak muncul — itu tier gratis, tidak punya baris langganan.
          </span>
        </FilterBar>

        {isError && <ErrorBox onRetry={() => refetch()} />}

        <DataTable<SubRow>
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(r) => r.id}
          isLoading={isFetching && !data}
          empty={
            <EmptyState
              title="Belum ada langganan cocok"
              body={hasFilters ? "Tidak ada baris untuk filter ini." : "Belum ada langganan tercatat."}
              action={
                hasFilters ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Reset filter
                  </button>
                ) : undefined
              }
            />
          }
        />

        {total > 0 && (
          <Pagination
            page={curPage}
            totalPages={totalPages}
            onPage={setPage}
            pageSize={data?.pageSize ?? pageSize}
            onPageSize={handlePageSize}
            total={total}
          />
        )}
      </div>
    </Section>
  );
}

// --- Trial ---

type TrialRow = {
  userId: string;
  email: string | null;
  status: string;
  startedAt: string;
  endsAt: string;
  convertedAt: string | null;
};
type TrialsResp = {
  rows: TrialRow[];
  page: number;
  pageSize: number;
  total: number;
  metrics: {
    active: number;
    converted: number;
    expired: number;
    grantsTotal: number;
  };
};

function TrialsView() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const qs = (() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    p.set("page", String(page));
    return p.toString();
  })();

  const { data, isFetching, isError, refetch } = useAdminQuery<TrialsResp>(
    ["admin", "trials", status, page],
    `/api/admin/trials?${qs}`,
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize ?? PAGE_SIZE)));
  const curPage = data?.page ?? page;
  const m = data?.metrics;
  const convRate =
    m && m.converted + m.expired > 0
      ? Math.round((m.converted / (m.converted + m.expired)) * 100)
      : null;
  const hasFilters = Boolean(status);

  const columns: Column<TrialRow>[] = [
    { key: "user", header: "User", cell: (r) => <span className="text-zinc-200">{r.email ?? "—"}</span> },
    {
      key: "started",
      header: "Mulai",
      cell: (r) => <span className="whitespace-nowrap text-zinc-400">{fmtDate(r.startedAt)}</span>,
    },
    {
      key: "ends",
      header: "Berakhir",
      cell: (r) => <span className="whitespace-nowrap text-zinc-400">{fmtDate(r.endsAt)}</span>,
    },
    {
      key: "converted",
      header: "Konversi",
      cell: (r) => <span className="whitespace-nowrap text-zinc-400">{fmtDate(r.convertedAt)}</span>,
    },
    { key: "status", header: "Status", cell: (r) => <StatusBadge value={r.status} map={TRIAL_STATUS_MAP} /> },
  ];

  return (
    <Section
      title="Funnel trial 14 hari"
      desc="Read-only. Pantau kesehatan konversi trial."
      actions={
        <span className="text-xs text-zinc-500">
          {isFetching ? "memuat…" : `${total.toLocaleString("id-ID")} trial`}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <MiniCard label="Trial aktif" value={String(m?.active ?? 0)} />
          <MiniCard label="Konversi" value={String(m?.converted ?? 0)} />
          <MiniCard label="Expired" value={String(m?.expired ?? 0)} />
          <MiniCard
            label="Conv. rate"
            value={convRate === null ? "—" : `${convRate}%`}
            hint="= konversi ÷ (konversi + expired). Trial yang masih aktif tidak dihitung (belum selesai)."
          />
          <MiniCard
            label="Grant trial (anti-farm)"
            value={String(m?.grantsTotal ?? 0)}
            hint="Jumlah total pemberian trial yang tercatat untuk mencegah 1 orang ambil trial berulang (farming)."
          />
        </div>

        <FilterBar>
          <div className="w-44">
            <Select
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={TRIAL_STATUS_OPTIONS}
              placeholder="Semua status"
            />
          </div>
          <span className="text-[11px] text-zinc-500">Saring per status trial.</span>
        </FilterBar>

        {isError && <ErrorBox onRetry={() => refetch()} />}

        <DataTable<TrialRow>
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(r) => r.userId}
          isLoading={isFetching && !data}
          empty={
            <EmptyState
              title="Belum ada trial cocok"
              body={hasFilters ? "Tidak ada baris untuk filter ini." : "Belum ada trial tercatat."}
              action={
                hasFilters ? (
                  <button
                    type="button"
                    onClick={() => {
                      setStatus("");
                      setPage(1);
                    }}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Reset filter
                  </button>
                ) : undefined
              }
            />
          }
        />

        {total > 0 && (
          <Pagination page={curPage} totalPages={totalPages} onPage={setPage} pageSize={PAGE_SIZE} total={total} />
        )}
      </div>
    </Section>
  );
}
