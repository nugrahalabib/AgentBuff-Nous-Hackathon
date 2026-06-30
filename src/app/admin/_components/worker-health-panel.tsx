"use client";

import { useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  LifeBuoy,
} from "lucide-react";
import {
  useAdminQuery,
  useToast,
  Section,
  StatusBadge,
  EmptyState,
  DataTable,
  fmtDateTime,
  type StatusMap,
  type Column,
  type Tone,
} from "./ui";

type Worker = {
  name: string;
  lastRunAt: string;
  lastOk: boolean;
  lastError: string | null;
  intervalMs: number;
  runs: number;
  fails: number;
  ageMs: number;
  stale: boolean;
};

type Resp = { workers: Worker[]; missing: string[] };

// One synthetic status string per row so we can lean on StatusBadge + a single
// enum->tone+label+hint map (mirrors the plan's legend table).
type RowStatus = "ok" | "error" | "stale" | "missing";

// A unified row shape covering both reported workers and expected-but-missing
// ones, so the table renders from a single list.
type Row = {
  name: string;
  status: RowStatus;
  lastRunAt: string | null;
  runs: number | null;
  fails: number | null;
  ageMs: number | null;
  lastError: string | null;
};

const STATUS_MAP: StatusMap = {
  ok: { tone: "ok", label: "ok", hint: "Worker melapor & tick terakhir sehat." },
  error: {
    tone: "warn",
    label: "error",
    hint: "Tick terakhir gagal (lihat Error terakhir).",
  },
  stale: {
    tone: "bad",
    label: "stale",
    hint: "Tidak melapor dalam max(3×interval, 90 dtk) — kemungkinan macet.",
  },
  missing: {
    tone: "bad",
    label: "missing",
    hint: "Worker yang diharapkan belum pernah melapor — kemungkinan server.ts gagal boot worker ini.",
  },
};

// What each background worker actually does (plan: missingGuidance / tooltips).
const WORKER_TASK: Record<string, string> = {
  "trial-worker":
    "Cek masa trial user, kirim reminder H-3/2/1, stop kontainer saat trial habis.",
  reconcile: "Sinkron ulang status transaksi/pembayaran yang tertinggal.",
  "skill-retry": "Pasang ulang skill berbayar yang gagal install (self-heal).",
  "renewal-worker": "Proses perpanjangan langganan + reminder jatuh tempo.",
  rollup: "Agregasi event analitik jadi ringkasan harian.",
};

const STATUS_LEGEND: { tone: Tone; label: string }[] = [
  { tone: "ok", label: "ok — sehat" },
  { tone: "warn", label: "error — tick gagal" },
  { tone: "bad", label: "stale / missing — macet" },
];

function ageLabel(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

function statusOf(w: Worker): RowStatus {
  if (w.stale) return "stale";
  if (!w.lastOk) return "error";
  return "ok";
}

function toRows(resp: Resp | undefined): Row[] {
  const reported: Row[] = (resp?.workers ?? []).map((w) => ({
    name: w.name,
    status: statusOf(w),
    lastRunAt: w.lastRunAt,
    runs: w.runs,
    fails: w.fails,
    ageMs: w.ageMs,
    lastError: w.lastError,
  }));
  const missing: Row[] = (resp?.missing ?? []).map((name) => ({
    name,
    status: "missing" as const,
    lastRunAt: null,
    runs: null,
    fails: null,
    ageMs: null,
    lastError: null,
  }));
  return [...reported, ...missing];
}

// --- Expandable last-error cell with copy-to-clipboard ---

function ErrorCell({ error }: { error: string | null }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  if (!error) return <span className="text-zinc-600">—</span>;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error);
      toast("Error disalin ke clipboard.", { tone: "ok" });
    } catch {
      toast("Gagal menyalin. Salin manual dari teks.", { tone: "bad" });
    }
  };

  return (
    <div className="max-w-md">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 shrink-0 text-zinc-500 hover:text-zinc-200"
          title={open ? "Sembunyikan" : "Lihat penuh"}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span
          className={open ? "break-words text-amber-300/90" : "block max-w-[16rem] truncate text-zinc-400"}
          title={open ? undefined : error}
        >
          {error}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="ml-auto shrink-0 text-zinc-500 hover:text-zinc-200"
          aria-label="Salin error"
          title="Salin error"
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// --- Contextual recovery runbook (shown only when something is unhealthy) ---

function RecoveryRunbook({ names }: { names: string[] }) {
  const list = names.join(", ");
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
      <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
        <LifeBuoy className="size-3.5" /> Langkah pemulihan
      </div>
      <p className="text-xs text-amber-200/90">
        Worker bermasalah: <span className="font-mono">{list}</span>. Panel ini read-only
        by design — tidak ada tombol restart karena worker dikelola oleh{" "}
        <span className="font-mono">server.ts</span> (bukan oleh engine).
      </p>
      <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-xs text-amber-200/80">
        <li>
          Cek log server (<span className="font-mono">server.ts</span>) untuk error boot worker.
        </li>
        <li>Pastikan worker ter-boot saat server start (bukan di-skip / crash diam).</li>
        <li>Restart proses server bila perlu; refresh otomatis 10 dtk konfirmasi pulih.</li>
      </ol>
    </div>
  );
}

const COLUMNS: Column<Row>[] = [
  {
    key: "name",
    header: "Worker",
    cell: (r) => (
      <span className="font-mono text-xs text-zinc-200" title={WORKER_TASK[r.name] ?? undefined}>
        {r.name}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => <StatusBadge value={r.status} map={STATUS_MAP} />,
  },
  {
    key: "lastRunAt",
    header: "Tick terakhir",
    cell: (r) => {
      if (r.status === "missing") {
        return <span className="text-zinc-600">Belum pernah lapor — worker tidak jalan?</span>;
      }
      return (
        <span className="text-zinc-400">
          {ageLabel(r.ageMs)}
          <span className="ml-1 text-zinc-600">({fmtDateTime(r.lastRunAt)})</span>
        </span>
      );
    },
  },
  {
    key: "runs",
    header: "Runs",
    align: "right",
    cell: (r) =>
      r.runs === null ? (
        <span className="text-zinc-600">—</span>
      ) : (
        <span className="tabular-nums text-zinc-400">{r.runs.toLocaleString("id-ID")}</span>
      ),
  },
  {
    key: "fails",
    header: "Gagal",
    align: "right",
    cell: (r) => {
      if (r.fails === null) return <span className="text-zinc-600">—</span>;
      return r.fails > 0 ? (
        <span className="tabular-nums text-amber-400">{r.fails}</span>
      ) : (
        <span className="tabular-nums text-zinc-600">0</span>
      );
    },
  },
  {
    key: "lastError",
    header: "Error terakhir",
    cell: (r) => <ErrorCell error={r.lastError} />,
  },
];

export function WorkerHealthPanel() {
  const { data, isLoading, isError, isFetching, refetch } = useAdminQuery<Resp>(
    ["admin", "workers"],
    "/api/admin/workers",
    { refetchInterval: 10_000 },
  );

  const rows = toRows(data);
  const unhealthyRows = rows.filter((r) => r.status !== "ok");
  const breakdown = {
    stale: rows.filter((r) => r.status === "stale").length,
    error: rows.filter((r) => r.status === "error").length,
    missing: rows.filter((r) => r.status === "missing").length,
  };
  const unhealthy = unhealthyRows.length;

  const statusStrip: ReactNode = (
    <div className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs">
      <span
        className={
          "size-2 rounded-full " +
          (isLoading
            ? "bg-zinc-500"
            : unhealthy > 0
              ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]"
              : "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]")
        }
      />
      {isLoading ? (
        <span className="text-zinc-500">Memuat…</span>
      ) : unhealthy > 0 ? (
        <span className="text-red-300">
          {unhealthy} bermasalah
          <span className="ml-1 text-zinc-500">
            ({[
              breakdown.stale ? `${breakdown.stale} stale` : null,
              breakdown.error ? `${breakdown.error} error` : null,
              breakdown.missing ? `${breakdown.missing} missing` : null,
            ]
              .filter(Boolean)
              .join(" · ")})
          </span>
        </span>
      ) : (
        <span className="text-emerald-300">Semua sehat</span>
      )}
      {isFetching && !isLoading && <span className="text-zinc-600">· memuat…</span>}
    </div>
  );

  return (
    <Section
      title="Kesehatan Worker"
      desc="Status hidup-mati 5 worker latar (read-only, auto-refresh 10 dtk) yang menjalankan otomasi penting di belakang layar."
      actions={statusStrip}
    >
      <div className="space-y-3">
        {/* Status legend — what ok / error / stale / missing mean */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          {STATUS_LEGEND.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span
                className={
                  "size-1.5 rounded-full " +
                  (l.tone === "ok"
                    ? "bg-emerald-500"
                    : l.tone === "warn"
                      ? "bg-amber-500"
                      : "bg-red-500")
                }
              />
              {l.label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 text-zinc-600">
            <Activity className="size-3" /> Hover nama worker untuk lihat tugasnya.
          </span>
        </div>

        {isError && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <span className="inline-flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              Gagal memuat status worker.
            </span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="shrink-0 rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20"
            >
              Coba lagi
            </button>
          </div>
        )}

        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.name}
          isLoading={isLoading}
          empty={
            <EmptyState
              icon={<Activity className="size-8" />}
              title="Belum ada data worker"
              body="Worker belum pernah melapor sama sekali — kemungkinan server.ts belum mem-boot worker latar."
            />
          }
        />

        {!isLoading && unhealthy > 0 && (
          <RecoveryRunbook names={unhealthyRows.map((r) => r.name)} />
        )}
      </div>
    </Section>
  );
}
