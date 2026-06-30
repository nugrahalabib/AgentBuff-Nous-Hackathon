"use client";

/**
 * AgentRutinitasPanel — Tab "Jadwal" (per-agent cron, INLINE).
 *
 * Lists every cron job whose agentId matches this agent + full lifecycle:
 * Run / Pause-Resume / Edit (CronEditDrawer) / Delete (2-click) / Bikin
 * Rutinitas (CronCreateWizard locked to THIS agent). "Buka tab Cron" stays
 * as a secondary link for the cross-agent overview.
 */
import {
  ArrowUpRight,
  Calendar,
  Clock,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRpc, useRpcEvent } from "@/lib/app/use-rpc";
import {
  type CronJob,
  type CronListResult,
  formatNextRun,
  humanizeSchedule,
} from "@/components/app/cron/helpers";
import { CronCreateWizard } from "@/components/app/cron/cron-create-wizard";
import { CronEditDrawer } from "@/components/app/cron/cron-edit-drawer";
import { useCronActions } from "@/hooks/use-cron-actions";
import { cn } from "@/lib/utils";
import { getAgentDisplayName, type AgentRow } from "./helpers";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

export function AgentRutinitasPanel({
  agent,
  defaultId,
  setToast,
}: {
  agent: AgentRow;
  defaultId: string;
  setToast: ToastSetter;
}) {
  const listParams = useMemo(
    () => ({
      enabled: "all" as const,
      sortBy: "nextRunAtMs" as const,
      sortDir: "asc" as const,
      limit: 100,
    }),
    [],
  );
  const list = useRpc<CronListResult, typeof listParams>({
    method: "cron.list",
    params: listParams,
  });

  const actions = useCronActions();
  const [now, setNow] = useState(Date.now());
  const [createOpen, setCreateOpen] = useState(false);
  const [editJob, setEditJob] = useState<CronJob | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const agentLabel = getAgentDisplayName(agent);

  // Keep relative "next run" times fresh between cron events. (Audit MED.)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useRpcEvent("cron", () => {
    void list.refetch();
    setNow(Date.now());
  });

  const isAgentDefault = agent.id === defaultId;
  const filteredJobs = useMemo(() => {
    const jobs = list.data?.jobs ?? [];
    const seen = new Set<string>();
    const out: CronJob[] = [];
    for (const j of jobs) {
      const a = j.agentId;
      if (a ? a !== agent.id : !isAgentDefault) continue;
      const key = j.id || `${j.name}-${j.createdAtMs ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(j);
    }
    return out;
  }, [list.data, agent.id, isAgentDefault]);

  const handleRun = async (job: CronJob) => {
    const res = await actions.run(job.id, "force");
    if (res.ok) {
      setToast({ kind: "success", text: `Running "${job.name}"` });
      void list.refetch();
    } else {
      setToast({ kind: "error", text: `Failed to run: ${res.error}` });
    }
  };

  const handleToggle = async (job: CronJob) => {
    const res = await actions.toggleEnabled(job.id, !job.enabled);
    if (res.ok) {
      setToast({
        kind: "success",
        text: !job.enabled ? "Routine activated" : "Routine paused",
      });
      void list.refetch();
    } else {
      setToast({ kind: "error", text: res.error });
    }
  };

  const handleDelete = async (job: CronJob) => {
    const res = await actions.remove(job.id);
    setConfirmDelete(null);
    if (res.ok) {
      setToast({ kind: "success", text: `Routine "${job.name}" deleted` });
      void list.refetch();
    } else {
      setToast({ kind: "error", text: `Failed to delete: ${res.error}` });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.06] via-[#0B0E14]/40 to-fuchsia-400/[0.04] p-5">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-white">
              This agent&apos;s routines
            </h3>
            <p className="mt-1 text-[12.5px] text-white/65">
              Scheduled tasks run automatically by{" "}
              <span className="font-semibold text-white/85">{agentLabel}</span>
              . Manage them right here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3.5 py-1.5 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.5)] transition hover:brightness-110"
            >
              <Plus className="size-3.5" aria-hidden />
              New Routine
            </button>
            <Link
              href="/app/cron"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-100"
              title="View all routines across agents"
            >
              All
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </header>
      </section>

      {list.loading && filteredJobs.length === 0 ? (
        <div className="space-y-2">
          <div className="h-24 animate-pulse rounded-xl bg-white/[0.02]" />
          <div className="h-24 animate-pulse rounded-xl bg-white/[0.02]" />
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-10 text-center">
          <Calendar className="mx-auto size-8 text-white/30" aria-hidden />
          <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
            No routines yet
          </div>
          <p className="mt-1 max-w-sm mx-auto text-[12.5px] text-white/55">
            Create the first routine for {agentLabel} — this agent will run
            tasks automatically on schedule.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-2 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.5)] transition hover:brightness-110"
          >
            <Plus className="size-3.5" aria-hidden />
            New Routine
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {filteredJobs.map((job) => {
            const isRunning = !!job.state?.runningAtMs;
            const runBusy = actions.busyAction === `run-${job.id}`;
            const toggleBusy = actions.busyAction === `update-${job.id}`;
            const delBusy = actions.busyAction === `remove-${job.id}`;
            // Mirror the dedup memo's identity formula so the React key matches
            // the dedup key (stable across re-order/insert when id is absent).
            const stableKey = job.id || `${job.name ?? "anon"}-${job.createdAtMs ?? ""}`;
            const confirming = confirmDelete === job.id;
            return (
              <li
                key={stableKey}
                className={cn(
                  "rounded-xl border bg-white/[0.02] p-4 transition",
                  isRunning
                    ? "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                    : "border-white/[0.06] hover:border-white/15",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
                    <Sparkles className="size-4 text-cyan-300/85" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="truncate text-[13.5px] font-semibold text-white/90">
                        {job.name}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0 font-mono text-[9px] uppercase tracking-[0.16em]",
                          isRunning
                            ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                            : job.enabled
                              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                              : "border-amber-400/30 bg-amber-400/10 text-amber-100",
                        )}
                      >
                        {isRunning
                          ? "running"
                          : job.enabled
                            ? "active"
                            : "paused"}
                      </span>
                    </div>
                    {job.description ? (
                      <p className="mt-0.5 text-[11.5px] text-white/55">
                        {job.description}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="size-3" aria-hidden />
                        <span className="normal-case tracking-normal">
                          {humanizeSchedule(job.schedule)}
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" aria-hidden />
                        <span className="normal-case tracking-normal">
                          {formatNextRun(job.state.nextRunAtMs, now)}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleRun(job)}
                      disabled={runBusy}
                      title="Run now"
                      aria-label="Run now"
                      className="inline-flex items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 p-1.5 text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {runBusy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Play className="size-3.5" aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggle(job)}
                      disabled={toggleBusy}
                      title={job.enabled ? "Pause" : "Enable"}
                      aria-label={job.enabled ? "Pause" : "Enable"}
                      className={cn(
                        "inline-flex items-center justify-center rounded-lg border p-1.5 transition disabled:cursor-not-allowed disabled:opacity-50",
                        job.enabled
                          ? "border-amber-400/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20"
                          : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20",
                      )}
                    >
                      {toggleBusy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : job.enabled ? (
                        <Pause className="size-3.5" aria-hidden />
                      ) : (
                        <Power className="size-3.5" aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditJob(job)}
                      title="Edit routine"
                      aria-label="Edit routine"
                      className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] p-1.5 text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-100"
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                    {confirming ? (
                      <div className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-1">
                        <button
                          type="button"
                          onClick={() => void handleDelete(job)}
                          disabled={delBusy}
                          className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
                        >
                          {delBusy ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden />
                          ) : null}
                          Confirm?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
                          aria-label="Cancel"
                        >
                          <X className="size-2.5" aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(job.id)}
                        title="Delete routine"
                        aria-label="Delete routine"
                        className="inline-flex items-center justify-center rounded-lg border border-red-500/25 bg-red-500/[0.06] p-1.5 text-red-200/85 transition hover:border-red-500/50 hover:bg-red-500/15"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <CronCreateWizard
        open={createOpen}
        initial={null}
        onClose={() => setCreateOpen(false)}
        onCreated={(_id, name) => {
          setCreateOpen(false);
          setToast({ kind: "success", text: `Routine "${name}" created` });
          void list.refetch();
        }}
        lockedAgentId={agent.id}
        lockedAgentLabel={agentLabel}
      />

      <CronEditDrawer
        open={!!editJob}
        job={editJob}
        onClose={() => setEditJob(null)}
        onSaved={() => {
          setEditJob(null);
          setToast({ kind: "success", text: "Routine updated" });
          void list.refetch();
        }}
      />
    </div>
  );
}
