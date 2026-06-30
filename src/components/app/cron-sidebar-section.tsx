"use client";

/**
 * CronSidebarSection — "Tugas Terjadwal" glance docked at the bottom of the
 * chat sub-sidebar. Mirrors the official Nous desktop
 * `app/chat/sidebar/cron-jobs-section.tsx` UX (live countdown, state dot,
 * hover trigger/manage, sort by soonest next-run) but adapted to AgentBuff's
 * dark idiom + Bahasa, and to OUR data path:
 *   - data : `cron.list` via useRpc (shared ["cron-list"] cache w/ the Cron tab)
 *   - run  : useCronActions().run(id, "force")
 *   - label: formatNextRun(state.nextRunAtMs, now)
 * Pure client — no engine change. Hidden entirely when there are no jobs so the
 * sidebar stays clean.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, ChevronRight, Settings2, Zap } from "lucide-react";
import { useRpc } from "@/lib/app/use-rpc";
import { useCronActions } from "@/hooks/use-cron-actions";
import {
  formatNextRun,
  type CronJob,
  type CronListResult,
} from "@/components/app/cron/helpers";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const INITIAL_VISIBLE = 4;
const COLLAPSE_KEY = "agentbuff:app:sidebar-cron-collapsed";

function dotClass(job: CronJob): string {
  if (job.state.runningAtMs) {
    return "bg-cyan-400 animate-pulse shadow-[0_0_6px_rgba(34,211,238,0.7)]";
  }
  if (!job.enabled) return "bg-white/25";
  if (job.state.lastRunStatus === "error") return "bg-red-400";
  return "bg-emerald-400/90";
}

export function CronSidebarSection() {
  const { t } = useI18n();
  const tc = t.app.cronSidebar;
  const router = useRouter();
  const actions = useCronActions();

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

  const jobs = useMemo(() => {
    const raw = list.data?.jobs ?? [];
    // Soonest next-run first; jobs with no next-run sink; then by name.
    return [...raw].sort((a, b) => {
      const an = a.state.nextRunAtMs;
      const bn = b.state.nextRunAtMs;
      if (an != null && bn != null && an !== bn) return an - bn;
      if (an == null && bn != null) return 1;
      if (an != null && bn == null) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [list.data?.jobs]);

  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Hydration-safe clock: 0 until mounted, then ticks 1s while expanded.
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
    if (collapsed || jobs.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [collapsed, jobs.length]);

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  // Keep the sidebar clean when there's nothing scheduled.
  if (jobs.length === 0) return null;

  const shown = showAll ? jobs : jobs.slice(0, INITIAL_VISIBLE);
  const hidden = jobs.length - shown.length;

  return (
    <div className="shrink-0 border-t border-white/[0.06] px-2 pb-2 pt-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition hover:bg-white/[0.03]"
      >
        <AlarmClock className="size-3 shrink-0 text-amber-300/70" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          {tc.title}
        </span>
        <span className="font-mono text-[10px] text-white/30">{jobs.length}</span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 text-white/30 transition",
            !collapsed && "rotate-90",
          )}
          aria-hidden
        />
      </button>

      {!collapsed ? (
        <div className="mt-0.5 flex flex-col gap-px">
          {shown.map((job) => (
            <CronRow
              key={job.id}
              job={job}
              nowMs={nowMs}
              triggerLabel={tc.triggerNow}
              manageLabel={tc.manage}
              busy={actions.busyAction === `run-${job.id}`}
              onManage={() => router.push("/app/cron")}
              onTrigger={() => void actions.run(job.id, "force")}
            />
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-px rounded-md px-2 py-1 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-white/35 transition hover:text-cyan-200"
            >
              {tc.more.replace("{n}", String(hidden))}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CronRow({
  job,
  nowMs,
  triggerLabel,
  manageLabel,
  busy,
  onManage,
  onTrigger,
}: {
  job: CronJob;
  nowMs: number;
  triggerLabel: string;
  manageLabel: string;
  busy: boolean;
  onManage: () => void;
  onTrigger: () => void;
}) {
  return (
    <div className="group/cron flex items-center gap-1.5 rounded-md px-1.5 py-1 transition hover:bg-white/[0.04]">
      <button
        type="button"
        onClick={onManage}
        title={job.name}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass(job))}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-white/75 group-hover/cron:text-white/90">
          {job.name}
        </span>
      </button>
      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-white/40 group-hover/cron:hidden">
        {nowMs ? formatNextRun(job.state.nextRunAtMs, nowMs) : "…"}
      </span>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover/cron:flex">
        <button
          type="button"
          onClick={onTrigger}
          disabled={busy}
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cn(
            "grid size-5 place-items-center rounded-sm text-white/45 transition hover:bg-white/10 hover:text-amber-200",
            busy && "animate-pulse opacity-60",
          )}
        >
          <Zap className="size-3" />
        </button>
        <button
          type="button"
          onClick={onManage}
          aria-label={manageLabel}
          title={manageLabel}
          className="grid size-5 place-items-center rounded-sm text-white/45 transition hover:bg-white/10 hover:text-cyan-200"
        >
          <Settings2 className="size-3" />
        </button>
      </div>
    </div>
  );
}
