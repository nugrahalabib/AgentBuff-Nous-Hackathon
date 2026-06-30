"use client";

/**
 * Cron tab — "Rutinitas" mass-market UX.
 *
 * Layout:
 *  1. SectionHeader dengan "+ Bikin Rutinitas" + Refresh
 *  2. CronOverviewStrip (3-tile)
 *  3. CronQuickPresets (prominent kalau zero job)
 *  4. CronFiltersBar (search + filter + sort)
 *  5. CronJobCard list (filtered + sorted)
 *  6. CronRunsStrip (cross-job history)
 *
 * Drawers (slide-in):
 *  - CronCreateWizard (3-step, preset-prefilled)
 *  - CronEditDrawer (full form)
 *  - CronRunHistoryDrawer (per-job)
 */
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useI18n } from "@/lib/i18n/context";
import { useRpc, useRpcEvent } from "@/lib/app/use-rpc";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { EmptyState } from "@/components/app/primitives/empty-state";
import { cn } from "@/lib/utils";
import { useCronActions } from "@/hooks/use-cron-actions";
import {
  type CronBroadcast,
  type CronJob,
  type CronListResult,
  type CronListUiFilters,
  type CronStatusResult,
  DEFAULT_LIST_FILTERS,
  cleanEngineError,
} from "@/components/app/cron/helpers";
import { CronOverviewStrip } from "@/components/app/cron/cron-overview-strip";
import { CronFiltersBar } from "@/components/app/cron/cron-filters-bar";
import { CronJobCard } from "@/components/app/cron/cron-job-card";
import { CronRunsStrip } from "@/components/app/cron/cron-runs-strip";
import { CronCreateWizard } from "@/components/app/cron/cron-create-wizard";
import { CronEditDrawer } from "@/components/app/cron/cron-edit-drawer";
import { CronRunHistoryDrawer } from "@/components/app/cron/cron-run-history-drawer";
import {
  useAgentsList,
  formatAgentLabel,
} from "@/components/app/channels/use-agents-list";

export function CronTab() {
  const { t } = useI18n();

  // ── RPC: cron.list (server-side params kept minimal,
  //  filter UI-side biar responsif tanpa refetch).
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
  // The Hermes engine has no `cron.status` RPC and no global cron on/off toggle
  // — the scheduler tick runs whenever the container is up. So the overview
  // status is DERIVED from cron.list (engine is "on" once we get a response;
  // total + next-run come from the jobs themselves). See cron-tab audit.

  // ── UI state
  const [filters, setFilters] =
    useState<CronListUiFilters>(DEFAULT_LIST_FILTERS);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editJob, setEditJob] = useState<CronJob | null>(null);
  const [historyJob, setHistoryJob] = useState<CronJob | null>(null);
  const [toast, setToast] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const actions = useCronActions();

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // Auto-refresh "now" tick — supaya formatNextRun(...) keep current
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Subscribe to broadcasts
  useRpcEvent("cron", (payload) => {
    const p = payload as CronBroadcast;
    void list.refetch();
    if (p.action === "started") {
      setToast({ kind: "info", text: "Rutinitas dimulai…" });
    } else if (p.action === "finished") {
      if (p.status === "error") {
        setToast({
          kind: "error",
          text: `Lari gagal${p.error ? ": " + cleanEngineError(p.error) : ""}`,
        });
      } else if (p.status === "ok") {
        setToast({ kind: "success", text: "Rutinitas selesai" });
      }
    }
  });

  const refreshAll = useCallback(() => {
    void list.refetch();
  }, [list]);

  // ── Apply client-side filters
  // Defensive: dedupe by id (Hermes reload window can emit dup entries)
  // and skip entries without id so React never sees collision warnings.
  const jobs = useMemo(() => {
    const raw = list.data?.jobs ?? [];
    const seen = new Set<string>();
    const out: typeof raw = [];
    for (const j of raw) {
      if (!j || typeof j !== "object") continue;
      const id = (j as { id?: string }).id;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(j);
    }
    return out;
  }, [list.data?.jobs]);

  const filteredJobs = useMemo(
    () => applyFilters(jobs, filters),
    [jobs, filters],
  );

  // Derived stats — guard against undefined state (bridge transform should
  // always provide it, but humanizePayload/runningAtMs crashes look ugly).
  const enabledCount = useMemo(
    () => jobs.filter((j) => j.enabled).length,
    [jobs],
  );
  const runningCount = useMemo(
    () => jobs.filter((j) => !!j.state?.runningAtMs).length,
    [jobs],
  );

  // Derived cron status (replaces the non-existent cron.status RPC). Engine is
  // "on" once cron.list responds; nextWake = earliest upcoming run.
  const derivedStatus = useMemo<CronStatusResult>(() => {
    let nextWakeAtMs: number | null = null;
    for (const j of jobs) {
      const ts = j.state?.nextRunAtMs;
      if (typeof ts === "number" && ts > 0 && (nextWakeAtMs === null || ts < nextWakeAtMs)) {
        nextWakeAtMs = ts;
      }
    }
    return { enabled: list.data != null, jobs: jobs.length, nextWakeAtMs };
  }, [jobs, list.data]);

  // Job index for cross-job lookup (runs strip)
  const jobsById = useMemo(
    () => Object.fromEntries(jobs.map((j) => [j.id, j])),
    [jobs],
  );

  // Agent display-name map — so a job's agent chip shows "Buff" instead of the
  // raw id ("default"/uuid). Same source as the create wizard's agent picker.
  const agentsQ = useAgentsList();
  const agentLabelById = useMemo(() => {
    const map: Record<string, string> = {};
    const defaultId = agentsQ.data?.defaultId ?? "main";
    for (const a of agentsQ.data?.agents ?? []) {
      if (a?.id) map[a.id] = formatAgentLabel(a, a.id === defaultId);
    }
    return map;
  }, [agentsQ.data]);

  // ── Action handlers
  //
  // NOTE about refetch: `useCronActions` invalidates `["cron-list"]` via
  // TanStack Query's QueryClient, but cron-tab's `list` uses the custom
  // `useRpc` hook (not TanStack Query), so the invalidate is a no-op.
  // The `useRpcEvent("cron", ...)` listener above DOES refetch on engine
  // broadcasts — but there's a race: the local action handler resolves
  // BEFORE the broadcast reaches the WS client. So we explicitly call
  // `list.refetch()` after every action to guarantee instant UI feedback.
  const handleRun = useCallback(
    async (job: CronJob) => {
      const res = await actions.run(job.id, "force");
      if (res.ok) {
        void list.refetch();
      } else {
        setToast({ kind: "error", text: `Gagal jalankan: ${res.error}` });
      }
    },
    [actions, list],
  );
  const handleToggle = useCallback(
    async (job: CronJob) => {
      const res = await actions.toggleEnabled(job.id, !job.enabled);
      if (res.ok) {
        setToast({
          kind: "success",
          text: !job.enabled ? "Rutinitas diaktifkan" : "Rutinitas di-pause",
        });
        void list.refetch();
      } else {
        setToast({ kind: "error", text: res.error });
      }
    },
    [actions, list],
  );
  const handleDelete = useCallback(
    async (job: CronJob) => {
      const res = await actions.remove(job.id);
      if (res.ok) {
        setToast({ kind: "success", text: "Rutinitas dihapus" });
        void list.refetch();
      } else {
        setToast({ kind: "error", text: `Gagal hapus: ${res.error}` });
      }
    },
    [actions, list],
  );

  const error = list.error;
  const hasZeroJobs = list.data && jobs.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow={t.app.cron.eyebrow}
        title="Rutinitas"
        subtitle="Tugas otomatis yang AI kamu kerjain sendiri sesuai jadwal. Set sekali → jalan terus."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3 py-1.5 text-[12px] font-bold text-[#0B0E14] hover:brightness-110"
            >
              <Plus className="size-3.5" aria-hidden />
              Bikin Rutinitas
            </button>
            <button
              type="button"
              onClick={refreshAll}
              disabled={list.loading}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/70 transition hover:border-cyan-400/40 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  (list.loading) && "animate-spin",
                )}
                aria-hidden
              />
              Refresh
            </button>
          </div>
        }
      />

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100"
            >
              <strong>Gagal load: </strong>
              {error}
            </div>
          ) : null}

          {/* Overview strip */}
          <CronOverviewStrip
            status={derivedStatus}
            totalEnabled={enabledCount}
            totalRunning={runningCount}
          />

          {/* Zero-state CTA — kalau belum punya rutinitas */}
          {hasZeroJobs ? <ZeroState onOpen={() => setWizardOpen(true)} /> : null}

          {/* Jobs list — hidden saat zero state karena CTA udah cover it */}
          {hasZeroJobs ? null : (
          <section className="space-y-3">
            <CronFiltersBar
              filters={filters}
              onChange={setFilters}
              total={filteredJobs.length}
            />

            {list.loading && !list.data ? (
              <div className="h-32 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02]" />
            ) : filteredJobs.length === 0 ? (
              jobs.length === 0 ? null : (
                <EmptyState
                  icon={Plus}
                  title="Tidak ada rutinitas cocok"
                  subtitle="Coba reset filter atau bikin rutinitas baru di atas."
                />
              )
            ) : (
              <ul className="space-y-2">
                {filteredJobs.map((job) => (
                  <li key={job.id}>
                    <CronJobCard
                      job={job}
                      now={now}
                      agentLabel={
                        job.agentId ? agentLabelById[job.agentId] : undefined
                      }
                      busy={actions.busyAction !== null && actions.busyAction.includes(job.id)}
                      busyKind={getBusyKind(actions.busyAction, job.id)}
                      onRun={() => handleRun(job)}
                      onToggle={() => handleToggle(job)}
                      onEdit={() => setEditJob(job)}
                      onHistory={() => setHistoryJob(job)}
                      onDelete={() => handleDelete(job)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}

          {/* Cross-job runs feed */}
          {jobs.length > 0 ? (
            <CronRunsStrip
              jobsById={jobsById}
              now={now}
              onOpenJob={(j) => setHistoryJob(j)}
            />
          ) : null}
        </div>
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className={cn(
              "fixed bottom-6 left-1/2 z-[200] -translate-x-1/2 rounded-lg border px-4 py-2 text-[12px] shadow-lg backdrop-blur-xl",
              toast.kind === "success"
                ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                : toast.kind === "error"
                  ? "border-red-500/40 bg-red-500/15 text-red-100"
                  : "border-cyan-400/40 bg-cyan-400/15 text-cyan-100",
            )}
            role="status"
            aria-live="polite"
          >
            {toast.text}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Drawers */}
      <CronCreateWizard
        open={wizardOpen}
        initial={null}
        onClose={() => setWizardOpen(false)}
        onCreated={(_id, name) => {
          setToast({ kind: "success", text: `Rutinitas "${name}" dibuat` });
          void list.refetch();
        }}
      />
      <CronEditDrawer
        open={!!editJob}
        job={editJob}
        onClose={() => setEditJob(null)}
        onSaved={() => {
          setToast({ kind: "success", text: "Perubahan disimpan" });
          void list.refetch();
        }}
      />
      <CronRunHistoryDrawer
        open={!!historyJob}
        job={historyJob}
        onClose={() => setHistoryJob(null)}
      />
    </div>
  );
}

/* ── Filter logic ───────────────────────────────────────────────────── */

function applyFilters(
  jobs: CronJob[],
  filters: CronListUiFilters,
): CronJob[] {
  const q = filters.query.trim().toLowerCase();
  const out = jobs.filter((j) => {
    if (q) {
      const hay = `${j.name} ${j.description ?? ""} ${j.agentId ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.enabled === "enabled" && !j.enabled) return false;
    if (filters.enabled === "disabled" && j.enabled) return false;
    if (filters.scheduleKind !== "all" && j.schedule.kind !== filters.scheduleKind)
      return false;
    if (
      filters.lastStatus !== "all" &&
      j.state.lastRunStatus !== filters.lastStatus
    )
      return false;
    return true;
  });
  out.sort((a, b) => {
    const sign = filters.sortDir === "asc" ? 1 : -1;
    if (filters.sortBy === "name") {
      return sign * a.name.localeCompare(b.name);
    }
    if (filters.sortBy === "updatedAtMs") {
      return sign * (a.updatedAtMs - b.updatedAtMs);
    }
    const av = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    const bv = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
    return sign * (av - bv);
  });
  return out;
}

function ZeroState({ onOpen }: { onOpen: () => void }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="relative overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/[0.05] via-[#0B0E14]/40 to-fuchsia-500/[0.03] p-8 backdrop-blur-xl"
    >
      <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-12 -left-12 size-48 rounded-full bg-cyan-500/15 blur-[80px]" />
      <div className="relative flex flex-col items-start gap-3">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
          ✦ Belum ada rutinitas
        </div>
        <h2 className="max-w-xl font-display text-2xl font-bold leading-tight text-white sm:text-3xl">
          Bikin rutinitas pertama — biarin AI kerja otomatis.
        </h2>
        <p className="max-w-2xl text-[13px] text-white/65">
          Set jadwal (tiap pagi, tiap jam, mingguan, dll) + prompt yang harus
          dikerjain AI tiap waktu itu. Hasilnya bisa diumumin ke WhatsApp /
          Telegram / channel lainnya yang udah kamu pasangkan.
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-5 py-2.5 text-[13px] font-bold text-[#0B0E14] shadow-[0_12px_32px_-12px_rgba(99,102,241,0.6)] transition hover:brightness-110"
        >
          + Bikin rutinitas pertama
        </button>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          Step 1: pilih kapan jalanin · Step 2: tulis tugas · Step 3: kirim ke mana
        </p>
      </div>
    </motion.section>
  );
}

function getBusyKind(
  busyAction: string | null,
  jobId: string,
): "run" | "toggle" | "delete" | "edit" | null {
  if (!busyAction) return null;
  if (busyAction === `run-${jobId}`) return "run";
  if (busyAction === `update-${jobId}`) return "toggle";
  if (busyAction === `remove-${jobId}`) return "delete";
  return null;
}
