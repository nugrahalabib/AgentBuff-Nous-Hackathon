"use client";

import { useState } from "react";
import { Activity, BarChart3, Download, RefreshCw } from "lucide-react";
import {
  Badge,
  type Column,
  DataTable,
  EmptyState,
  FilterBar,
  type Option,
  SegmentedControl,
  Section,
  TabIntro,
  Toggle,
  useAdminQuery,
  useToast,
} from "./ui";

// --- Wire shapes (frozen contract — do NOT change; mirrors the API routes) ---

type Funnel = {
  snapshot: {
    users: number;
    onboarded: number;
    trialActive: number;
    subscribed: number;
  };
  registrations: { last7d: number; last30d: number };
  events: { last7d: Record<string, number>; last30d: Record<string, number> };
};

type Trend = { days: string[]; metrics: Record<string, number[]> };

// --- Friendly labels (no raw event keys reach the operator) ---

const METRIC_LABELS: Record<string, string> = {
  "users.new": "Registrasi baru",
  "event.register": "Event: register",
  "event.onboard_complete": "Event: onboarding selesai",
  "event.paid": "Event: pembayaran",
  "revenue.settled": "Pendapatan",
};

function metricLabel(m: string): string {
  return METRIC_LABELS[m] ?? m;
}

const FEATURED_METRICS = [
  "users.new",
  "event.register",
  "event.onboard_complete",
  "event.paid",
  "revenue.settled",
];

// Time-range options map 1:1 onto the trend route's `?days=` param (MAX 90).
const RANGE_OPTIONS: Option<"7" | "14" | "30" | "90">[] = [
  { value: "7", label: "7 hari" },
  { value: "14", label: "14 hari" },
  { value: "30", label: "30 hari" },
  { value: "90", label: "90 hari" },
];

const idNum = (n: number) => n.toLocaleString("id-ID");
const rupiah = (n: number) => `Rp ${idNum(n)}`;

function pct(a: number, b: number): number {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

// --- Snapshot mini cards ---

function MiniCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      title={hint}
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5"
    >
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">{value}</div>
    </div>
  );
}

// --- Funnel stage bar ---

function Stage({ label, value, base }: { label: string; value: number; base: number }) {
  const p = pct(value, base);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-zinc-300">{label}</span>
        <span className="tabular-nums text-zinc-400">
          {idNum(value)} <span className="text-[11px] text-zinc-600">({p}%)</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500"
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}

// --- Daily sparkbars ---

function Sparkbars({
  days,
  values,
  money,
}: {
  days: string[];
  values: number[];
  money: boolean;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-10 items-end gap-0.5">
      {values.map((v, i) => (
        <div
          key={days[i] ?? String(i)}
          className="flex-1 rounded-sm bg-gradient-to-t from-cyan-500/30 to-fuchsia-500/70"
          style={{ height: `${Math.max(3, (v / max) * 100)}%` }}
          title={`${days[i]}: ${money ? rupiah(v) : idNum(v)}`}
        />
      ))}
    </div>
  );
}

// --- Trend section (per-metric time series over the selected window) ---

function TrendSection({
  range,
  autoRefresh,
}: {
  range: "7" | "14" | "30" | "90";
  autoRefresh: boolean;
}) {
  const { data, isLoading, isError } = useAdminQuery<Trend>(
    ["admin", "trend", range],
    `/api/admin/metrics/trend?days=${range}`,
    { refetchInterval: autoRefresh ? 60_000 : undefined },
  );

  if (isLoading && !data) {
    return (
      <Section title={`Tren harian (${range} hari)`}>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-zinc-800/60" />
          ))}
        </div>
      </Section>
    );
  }

  if (isError || !data) {
    return (
      <Section title={`Tren harian (${range} hari)`}>
        <EmptyState
          icon={<BarChart3 className="size-8" />}
          title="Gagal memuat tren"
          body="Tidak bisa mengambil data tren harian. Coba refresh."
        />
      </Section>
    );
  }

  const keys = Object.keys(data.metrics);
  const ordered = [
    ...FEATURED_METRICS.filter((m) => keys.includes(m)),
    ...keys.filter((m) => !FEATURED_METRICS.includes(m)).sort(),
  ];

  const rangeLabel =
    data.days.length > 0 ? `${data.days[0]} → ${data.days[data.days.length - 1]}` : "";

  return (
    <Section
      title={`Tren harian (${range} hari)`}
      desc="Angka per hari, dihitung dari ringkasan harian yang diperbarui otomatis."
      actions={rangeLabel ? <span className="text-[11px] text-zinc-600">{rangeLabel}</span> : undefined}
    >
      {ordered.length === 0 ? (
        <EmptyState
          icon={<BarChart3 className="size-8" />}
          title="Belum ada data tren"
          body="Data tren mulai terisi setelah ada aktivitas. Diperbarui otomatis tiap ~30 menit."
        />
      ) : (
        <div className="space-y-4">
          {ordered.map((m) => {
            const vals = data.metrics[m];
            const money = m.startsWith("revenue.");
            const last = vals[vals.length - 1] ?? 0;
            const total = vals.reduce((a, b) => a + b, 0);
            const fmt = (n: number) => (money ? rupiah(n) : idNum(n));
            return (
              <div key={m}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-zinc-300">{metricLabel(m)}</span>
                  <span className="tabular-nums text-zinc-400">
                    {fmt(total)}
                    <span className="ml-1 text-[11px] text-zinc-600">
                      total · hari ini {fmt(last)}
                    </span>
                  </span>
                </div>
                <Sparkbars days={data.days} values={vals} money={money} />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// --- Event activity row shape (derived from the funnel payload) ---

type EventRow = { event: string; label: string; last7d: number; last30d: number };

function buildEventRows(events: Funnel["events"]): EventRow[] {
  const keys = Array.from(
    new Set([...Object.keys(events.last7d), ...Object.keys(events.last30d)]),
  ).sort();
  return keys.map((k) => ({
    event: k,
    label: metricLabel(k),
    last7d: events.last7d[k] ?? 0,
    last30d: events.last30d[k] ?? 0,
  }));
}

function downloadCsv(filename: string, rows: string[][]) {
  const escape = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// AnalyticsBrowser — top-level Analitik tab (read-only funnel + trend).
// ---------------------------------------------------------------------------

export function AnalyticsBrowser() {
  const { toast } = useToast();
  const [range, setRange] = useState<"7" | "14" | "30" | "90">("14");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useAdminQuery<Funnel>(["admin", "funnel"], "/api/admin/metrics/funnel", {
    refetchInterval: autoRefresh ? 60_000 : undefined,
  });

  const eventRows = data ? buildEventRows(data.events) : [];

  const eventColumns: Column<EventRow>[] = [
    {
      key: "event",
      header: "Event",
      cell: (r) => (
        <div>
          <div className="text-zinc-200">{r.label}</div>
          <div className="font-mono text-[11px] text-zinc-600">{r.event}</div>
        </div>
      ),
    },
    {
      key: "last7d",
      header: "7 hari",
      align: "right",
      cell: (r) => <span className="tabular-nums text-zinc-300">{idNum(r.last7d)}</span>,
    },
    {
      key: "last30d",
      header: "30 hari",
      align: "right",
      cell: (r) => <span className="tabular-nums text-zinc-300">{idNum(r.last30d)}</span>,
    },
  ];

  const handleExport = () => {
    if (!data) return;
    const s = data.snapshot;
    const rows: string[][] = [
      ["Bagian", "Metrik", "Nilai 7 hari", "Nilai 30 hari"],
      ["Snapshot", "Total registrasi", String(s.users), ""],
      ["Snapshot", "Onboarded", String(s.onboarded), ""],
      ["Snapshot", "Trial aktif", String(s.trialActive), ""],
      ["Snapshot", "Berlangganan", String(s.subscribed), ""],
      ["Registrasi", "Registrasi baru", String(data.registrations.last7d), String(data.registrations.last30d)],
      ...eventRows.map((r) => ["Event", r.label, String(r.last7d), String(r.last30d)]),
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`analitik-${stamp}.csv`, rows);
    toast("CSV diunduh.", { tone: "ok" });
  };

  const refreshAction = (
    <FilterBar
      actions={
        <>
          <Toggle checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh" />
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw className={isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!data}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            <Download className="size-3.5" />
            Ekspor CSV
          </button>
        </>
      }
    >
      <span className="text-xs text-zinc-500">Rentang tren</span>
      <SegmentedControl value={range} onChange={setRange} options={RANGE_OPTIONS} size="sm" />
    </FilterBar>
  );

  return (
    <div className="space-y-6">
      <TabIntro
        eyebrow="OPS · ANALITIK"
        title="Analitik akuisisi"
        what="Foto cepat funnel akuisisi (snapshot dari database) plus tren harian dan aktivitas event. Murni baca-saja — tidak ada yang bisa diubah dari sini."
        canDo={[
          "Lihat funnel: dari registrasi → onboarding → trial → berlangganan.",
          "Pantau tren harian per metrik (registrasi, event, pendapatan).",
          "Atur rentang waktu tren (7 / 14 / 30 / 90 hari).",
          "Nyalakan auto-refresh atau refresh manual, dan ekspor angka ke CSV.",
        ]}
        how="Pilih rentang tren di atas, baca funnel & sparkbar di bawah. Klik Ekspor CSV untuk menyimpan angkanya."
        legend={[
          { tone: "info", label: "Registrasi & event" },
          { tone: "ok", label: "Pendapatan" },
          { tone: "muted", label: "Snapshot saat ini" },
        ]}
      />

      {refreshAction}

      {isError && !data ? (
        <Section>
          <EmptyState
            icon={<Activity className="size-8" />}
            title="Gagal memuat analitik"
            body="Tidak bisa mengambil data funnel. Coba refresh halaman."
            action={
              <button
                type="button"
                onClick={() => void refetch()}
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
              >
                <RefreshCw className="size-3.5" /> Coba lagi
              </button>
            }
          />
        </Section>
      ) : (
        <>
          <Section title="Ringkasan" desc="Angka langsung dari database, diperbarui tiap halaman dibuka.">
            {isLoading && !data ? (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-800/60" />
                ))}
              </div>
            ) : data ? (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <MiniCard label="Total registrasi" value={idNum(data.snapshot.users)} />
                <MiniCard label="Onboarded" value={idNum(data.snapshot.onboarded)} />
                <MiniCard
                  label="Registrasi 7 hari"
                  value={idNum(data.registrations.last7d)}
                  hint="Akun baru dalam 7 hari terakhir"
                />
                <MiniCard
                  label="Registrasi 30 hari"
                  value={idNum(data.registrations.last30d)}
                  hint="Akun baru dalam 30 hari terakhir"
                />
              </div>
            ) : null}
          </Section>

          <Section
            title="Funnel akuisisi"
            desc="Persentase dihitung dari total registrasi."
            actions={<Badge tone="muted">Snapshot</Badge>}
          >
            {data ? (
              <div className="space-y-3">
                <Stage label="Registrasi" value={data.snapshot.users} base={data.snapshot.users} />
                <Stage label="Onboarding selesai" value={data.snapshot.onboarded} base={data.snapshot.users} />
                <Stage label="Trial aktif" value={data.snapshot.trialActive} base={data.snapshot.users} />
                <Stage label="Berlangganan" value={data.snapshot.subscribed} base={data.snapshot.users} />
              </div>
            ) : (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-6 animate-pulse rounded bg-zinc-800/60" />
                ))}
              </div>
            )}
          </Section>

          <TrendSection range={range} autoRefresh={autoRefresh} />

          <Section
            title="Aktivitas event"
            desc="Jumlah event yang terekam (self-host analytics)."
          >
            <DataTable
              columns={eventColumns}
              rows={eventRows}
              rowKey={(r) => r.event}
              isLoading={isLoading && !data}
              empty={
                <EmptyState
                  icon={<Activity className="size-8" />}
                  title="Belum ada event terekam"
                  body="Mulai terkumpul saat user registrasi atau menyelesaikan onboarding."
                />
              }
            />
          </Section>
        </>
      )}
    </div>
  );
}
