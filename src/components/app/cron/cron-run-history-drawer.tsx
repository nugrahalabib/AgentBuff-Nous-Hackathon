"use client";

/**
 * CronRunHistoryDrawer (now centered MODAL) — per-job run history viewer.
 * Sticky filter bar di header, scroll body buat run list.
 */
import {
  AlertCircle,
  CheckCircle2,
  History,
  Loader2,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useCronRunsList } from "@/hooks/use-cron-actions";
import {
  type CronJob,
  type CronRunLogEntry,
  type CronRunStatus,
  deliveryStatusLabel,
  formatDuration,
  formatRelativePast,
  statusLabel,
  statusTone,
} from "./helpers";
import { CronModalShell } from "./cron-modal-shell";

export function CronRunHistoryDrawer({
  open,
  job,
  onClose,
}: {
  open: boolean;
  job: CronJob | null;
  onClose: () => void;
}) {
  return (
    <CronModalShell
      open={open && !!job}
      onClose={onClose}
      width="2xl"
      eyebrow="Riwayat lari"
      title={job?.name ?? "Rutinitas"}
      subtitle={job ? `${job.id}` : ""}
    >
      {job ? <HistoryBody job={job} /> : null}
    </CronModalShell>
  );
}

function HistoryBody({ job }: { job: CronJob }) {
  const [statusFilter, setStatusFilter] = useState<
    CronRunStatus[] | undefined
  >(undefined);
  const [query, setQuery] = useState("");
  const runs = useCronRunsList({
    scope: "job",
    jobId: job.id,
    limit: 100,
    sortDir: "desc",
    statuses: statusFilter,
    query: query.trim() || undefined,
  });

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-white/40"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari summary atau error..."
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-9 pr-3 text-[12px] text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
        </div>
        <StatusFilter value={statusFilter} onChange={setStatusFilter} />
        <button
          type="button"
          onClick={() => void runs.refetch()}
          disabled={runs.isFetching}
          aria-label="Refresh"
          title="Refresh"
          className="rounded-md border border-white/10 bg-white/[0.04] p-2 text-white/55 hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
        >
          <RefreshCw
            className={cn("size-3.5", runs.isFetching && "animate-spin")}
            aria-hidden
          />
        </button>
      </div>

      {/* List */}
      {runs.isLoading ? (
        <Loader />
      ) : runs.error ? (
        <ErrorBox msg={(runs.error as Error).message} />
      ) : !runs.data || runs.data.entries.length === 0 ? (
        <Empty msg="Belum ada lari yang tercatat untuk rutinitas ini." />
      ) : (
        <>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
            {runs.data.entries.length} entri ditampilkan
          </p>
          <ul className="space-y-2">
            {runs.data.entries.map((entry, i) => (
              <RunRow key={`${entry.ts}-${i}`} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: CronRunStatus[] | undefined;
  onChange: (v: CronRunStatus[] | undefined) => void;
}) {
  const choices: Array<{ value: CronRunStatus; label: string }> = [
    { value: "ok", label: "Sukses" },
    { value: "error", label: "Gagal" },
    { value: "skipped", label: "Dilewat" },
  ];
  function toggle(s: CronRunStatus) {
    const current = new Set(value ?? []);
    if (current.has(s)) current.delete(s);
    else current.add(s);
    const next = Array.from(current);
    onChange(next.length === 0 ? undefined : next);
  }
  return (
    <div className="flex gap-1">
      {choices.map((c) => {
        const active = value?.includes(c.value);
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => toggle(c.value)}
            className={cn(
              "rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] transition",
              active
                ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-100"
                : "border-white/10 bg-white/[0.03] text-white/55 hover:text-white",
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function RunRow({ entry }: { entry: CronRunLogEntry }) {
  const tone = statusTone(entry.status);
  const cls =
    tone === "emerald"
      ? "border-emerald-400/25 bg-emerald-400/[0.04]"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/[0.05]"
        : "border-amber-400/25 bg-amber-400/[0.04]";
  const Icon =
    entry.status === "ok"
      ? CheckCircle2
      : entry.status === "error"
        ? XCircle
        : AlertCircle;
  return (
    <li className={cn("rounded-xl border px-4 py-3", cls)}>
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tone === "emerald"
              ? "text-emerald-300"
              : tone === "red"
                ? "text-red-300"
                : "text-amber-300",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span
              className={cn(
                "font-mono text-[10px] font-bold uppercase tracking-[0.18em]",
                tone === "emerald"
                  ? "text-emerald-200"
                  : tone === "red"
                    ? "text-red-200"
                    : "text-amber-200",
              )}
            >
              {statusLabel(entry.status)}
            </span>
            <span className="font-mono text-[10px] text-white/55">
              {formatRelativePast(Date.now() - entry.ts)} lalu
            </span>
            {entry.durationMs != null ? (
              <span className="font-mono text-[10px] text-white/55">
                · {formatDuration(entry.durationMs)}
              </span>
            ) : null}
            {entry.deliveryStatus ? (
              <span className="font-mono text-[10px] text-white/55">
                · {deliveryStatusLabel(entry.deliveryStatus)}
              </span>
            ) : null}
          </div>

          {entry.summary ? (
            <p className="mt-1 text-[12px] leading-snug text-white/85">
              {entry.summary}
            </p>
          ) : null}

          {entry.error ? (
            <p className="mt-1 text-[11px] leading-snug text-red-200">
              {entry.error}
            </p>
          ) : null}

          {entry.usage ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-white/55">
              {entry.usage.input_tokens != null ? (
                <span>↑ {entry.usage.input_tokens} in</span>
              ) : null}
              {entry.usage.output_tokens != null ? (
                <span>↓ {entry.usage.output_tokens} out</span>
              ) : null}
              {entry.usage.cache_read_tokens != null &&
              entry.usage.cache_read_tokens > 0 ? (
                <span>⚡ {entry.usage.cache_read_tokens} cache</span>
              ) : null}
              {entry.model ? <span>· {entry.model}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Loader() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-[12px] text-white/55">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Memuat riwayat...
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-4 py-3 text-[12px] text-red-100">
      Gagal memuat: {msg}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-center text-[12px] text-white/55">
      <History className="mx-auto mb-2 size-5 text-white/35" aria-hidden />
      {msg}
    </div>
  );
}
