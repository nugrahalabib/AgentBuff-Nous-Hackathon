"use client";

/**
 * CronRunsStrip — feed riwayat lari semua-job di bawah tab.
 * Lazy fetch (refetch tiap 30s + on broadcast event). Compact display.
 */
import {
  AlertCircle,
  CheckCircle2,
  History,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useCronRunsList } from "@/hooks/use-cron-actions";
import {
  type CronJob,
  type CronRunLogEntry,
  formatDuration,
  formatRelativePast,
  statusLabel,
  statusTone,
} from "./helpers";

export function CronRunsStrip({
  jobsById,
  onOpenJob,
  now,
}: {
  jobsById: Record<string, CronJob>;
  onOpenJob: (job: CronJob) => void;
  /** Shared clock from the tab's 30s tick. When omitted, falls back to a
   *  per-render Date.now() so the strip still shows current "X ago" labels. */
  now?: number;
}) {
  const [limit, setLimit] = useState(25);
  const runs = useCronRunsList({
    scope: "all",
    limit,
    sortDir: "desc",
  });

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md">
      <header className="flex items-center justify-between gap-2 border-b border-white/[0.04] px-5 py-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-fuchsia-300" aria-hidden />
          <h2 className="text-sm font-semibold text-white/90">
            Riwayat Lari (Semua Rutinitas)
          </h2>
          {runs.data ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
              · {runs.data.entries.length} terbaru
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void runs.refetch()}
          disabled={runs.isFetching}
          aria-label="Refresh"
          className="rounded-md p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white disabled:opacity-50"
        >
          <RefreshCw
            className={cn("size-3.5", runs.isFetching && "animate-spin")}
            aria-hidden
          />
        </button>
      </header>

      <div className="p-4">
        {runs.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-white/55">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Memuat...
          </div>
        ) : runs.error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-100">
            Gagal load riwayat: {(runs.error as Error).message}
          </div>
        ) : !runs.data || runs.data.entries.length === 0 ? (
          <p className="py-4 text-center text-[11px] italic text-white/40">
            Belum ada lari yang tercatat.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {runs.data.entries.map((entry, i) => (
                <CompactRunRow
                  key={`${entry.ts}-${entry.jobId}-${i}`}
                  entry={entry}
                  job={jobsById[entry.jobId]}
                  now={now}
                  onClick={() => {
                    const j = jobsById[entry.jobId];
                    if (j) onOpenJob(j);
                  }}
                />
              ))}
            </ul>
            {runs.data.hasMore ? (
              <button
                type="button"
                onClick={() => setLimit((l) => l + 25)}
                className="mt-3 w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 hover:border-cyan-400/40 hover:text-cyan-200"
              >
                Muat 25 lagi
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function CompactRunRow({
  entry,
  job,
  onClick,
  now,
}: {
  entry: CronRunLogEntry;
  job?: CronJob;
  onClick: () => void;
  now?: number;
}) {
  const tone = statusTone(entry.status);
  const Icon =
    entry.status === "ok"
      ? CheckCircle2
      : entry.status === "error"
        ? XCircle
        : AlertCircle;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={!job}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition",
          job && "hover:border-cyan-400/30 hover:bg-white/[0.04]",
          !job && "cursor-default opacity-65",
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            tone === "emerald"
              ? "text-emerald-300"
              : tone === "red"
                ? "text-red-300"
                : "text-amber-300",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
            <span className="truncate text-[12px] font-semibold text-white/90">
              {job?.name ?? entry.jobName ?? "(Rutinitas dihapus)"}
            </span>
            <span
              className={cn(
                "font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
                tone === "emerald"
                  ? "text-emerald-200"
                  : tone === "red"
                    ? "text-red-200"
                    : "text-amber-200",
              )}
            >
              · {statusLabel(entry.status)}
            </span>
          </div>
          {entry.summary || entry.error ? (
            <p
              className={cn(
                "mt-0.5 truncate text-[11px]",
                entry.error ? "text-red-200" : "text-white/55",
              )}
            >
              {entry.error || entry.summary}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
          <div>{formatRelativePast((now ?? Date.now()) - entry.ts)} lalu</div>
          {entry.durationMs != null ? (
            <div>{formatDuration(entry.durationMs)}</div>
          ) : null}
        </div>
      </button>
    </li>
  );
}
