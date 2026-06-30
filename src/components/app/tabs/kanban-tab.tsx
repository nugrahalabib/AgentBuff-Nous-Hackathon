"use client";

/**
 * Papan Tugas (Kanban) — agentic task board. Full mirror of the engine /kanban
 * page: board switcher + orchestration settings (orchestrator profile, default
 * assignee, auto-decompose, profile routing descriptions) + filter bar (search,
 * assignee, tenant, show-archived, lanes-by-profile, nudge dispatcher) + status
 * columns with drag-drop + per-column add + rich task detail drawer.
 *
 * All data via bridge `kanban.*` RPCs (anti-drift: bridge reads the engine's own
 * kanban_db). Engine validates every status transition; the dispatcher claims +
 * runs tasks on agents automatically.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, KanbanSquare, AlertTriangle, ChevronDown, FolderPlus, Check, CheckCircle2, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useRpc } from "@/lib/app/use-rpc";
import { getClient } from "@/lib/app/store";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { EmptyState } from "@/components/app/primitives/empty-state";
import { cn } from "@/lib/utils";
import {
  type KanbanTask,
  type KanbanAction,
  type KanbanStatus,
  type KanbanTasksResult,
  type KanbanBoardsResult,
  STATUS_ORDER,
  statusMeta,
} from "@/components/app/kanban/helpers";
import { TaskCard } from "@/components/app/kanban/task-card";
import { type TaskPrefill } from "@/components/app/kanban/task-templates";
import { ConfirmDialog, PromptDialog, type ConfirmState } from "@/components/app/kanban/kanban-dialogs";
import { CreateWizard } from "@/components/app/kanban/create-wizard";
import { TaskDetailDrawer } from "@/components/app/kanban/task-detail-drawer";
import { KanbanEmpty } from "@/components/app/kanban/kanban-empty";
import { KanbanOrchestration } from "@/components/app/kanban/kanban-orchestration";
import { KanbanFilters, DEFAULT_FILTERS, type KanbanFilterState } from "@/components/app/kanban/kanban-filters";
import { KanbanDiagnostics } from "@/components/app/kanban/kanban-diagnostics";
import { SwarmDialog } from "@/components/app/kanban/swarm-dialog";
import { KanbanHelp } from "@/components/app/kanban/kanban-help";
import { Users, HelpCircle, Settings2 } from "lucide-react";

type AgentOpt = { id: string; name: string };

const POLL_MS = 6000;
const COLUMN_START: Record<string, string> = { triage: "triage", blocked: "blocked" };

export function KanbanTab() {
  const { t } = useI18n();
  const boardLabel = t.app.nav.tabs.kanban;

  const boardsRpc = useRpc<KanbanBoardsResult>({ method: "kanban.boards" });
  const board = boardsRpc.data?.current || "default";

  const [filters, setFilters] = useState<KanbanFilterState>(DEFAULT_FILTERS);

  const tasksRpc = useRpc<KanbanTasksResult>({
    method: "kanban.tasks",
    params: useMemo(() => ({ board, includeArchived: filters.showArchived }), [board, filters.showArchived]),
    deps: [board, filters.showArchived],
  });

  const agentsRpc = useRpc<{ agents?: Array<Record<string, unknown>> }>({ method: "agents.list" });

  const agents: AgentOpt[] = useMemo(() => {
    const raw = agentsRpc.data?.agents ?? [];
    return raw
      .map((a) => {
        const identity = (a.identity as Record<string, unknown> | undefined) ?? {};
        return {
          id: String(a.id ?? a.agentId ?? ""),
          name: String(identity.name ?? a.name ?? a.id ?? "Agen"),
        };
      })
      .filter((a) => a.id);
  }, [agentsRpc.data]);

  const [createOpen, setCreateOpen] = useState(false);
  const [swarmOpen, setSwarmOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [orchOpen, setOrchOpen] = useState(false);
  const [prefill, setPrefill] = useState<TaskPrefill | null>(null);
  const [detailTask, setDetailTask] = useState<KanbanTask | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Success/neutral notice — kept separate from actionError so a success message
  // never renders inside the amber warning banner.
  const [notice, setNotice] = useState<string | null>(null);
  const [nudging, setNudging] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Inline styled confirm / board-name prompt (replaces native window.confirm/prompt).
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [boardPromptOpen, setBoardPromptOpen] = useState(false);

  const refetch = tasksRpc.refetch;
  const pollRef = useRef(refetch);
  pollRef.current = refetch;
  useEffect(() => {
    // Skip the tick while the tab is hidden (don't burn the shared WS + bridge
    // thread pool polling a board nobody is looking at); refresh immediately
    // when the user returns so the board is current.
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void pollRef.current();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const allTasks = tasksRpc.data?.tasks ?? [];

  // Filter (search + assignee + tenant) — client-side.
  const tasks = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return allTasks.filter((task) => {
      if (filters.assignee && (task.assignee ?? "") !== filters.assignee) return false;
      if (filters.tenant && ((task as { tenant?: string }).tenant ?? "") !== filters.tenant) return false;
      if (filters.priority) {
        const p = task.priority ?? 0;
        if (filters.priority === "urgent" && p < 3) return false;
        if (filters.priority === "high" && p !== 2) return false;
        if (filters.priority === "normal" && p > 1) return false;
      }
      if (q) {
        const hay = `${task.title} ${task.body ?? ""} ${task.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allTasks, filters.search, filters.assignee, filters.tenant, filters.priority]);

  const assigneeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t2 of allTasks) if (t2.assignee) set.add(t2.assignee);
    for (const a of agents) set.add(a.id);
    return Array.from(set).sort();
  }, [allTasks, agents]);

  const tenantOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t2 of allTasks) {
      const tn = (t2 as { tenant?: string }).tenant;
      if (tn) set.add(tn);
    }
    return Array.from(set).sort();
  }, [allTasks]);

  const groupByStatus = useCallback((list: KanbanTask[]) => {
    const map = new Map<string, KanbanTask[]>();
    for (const s of STATUS_ORDER) map.set(s, []);
    for (const task of list) {
      const arr = map.get(task.status) ?? map.set(task.status, []).get(task.status)!;
      arr.push(task);
    }
    for (const arr of map.values()) arr.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return map;
  }, []);

  const byStatus = useMemo(() => groupByStatus(tasks), [tasks, groupByStatus]);

  // Engine shows ALL status columns, always — never hide empty ones.
  // archived only appears when "Tampilkan arsip" is on.
  const visibleColumns = useMemo(
    () => STATUS_ORDER.filter((s) => s !== "archived" || filters.showArchived),
    [filters.showArchived],
  );

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const performAction = useCallback(
    async (task: KanbanTask, action: KanbanAction) => {
      setActionError(null);
      markBusy(task.id, true);
      try {
        const res = (await getClient()?.request("kanban.action", { board, taskId: task.id, action })) as
          | { ok?: boolean; error?: string }
          | undefined;
        // The bridge omits `error` when the engine simply REFUSES a transition
        // (e.g. "Selesaikan" on a triage task), so gate on ok alone — otherwise
        // the button looks dead with zero feedback.
        if (!res?.ok) {
          setActionError(res?.error || "Aksi itu tidak bisa dijalankan untuk status tugas saat ini.");
        }
        if (action === "delete" && detailTask?.id === task.id) setDetailTask(null);
        await refetch();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Aksi gagal");
      } finally {
        markBusy(task.id, false);
      }
    },
    [board, refetch, detailTask],
  );

  const runAction = useCallback(
    (task: KanbanTask, action: KanbanAction) => {
      if (action === "delete") {
        setConfirmState({
          title: `Hapus tugas "${task.title}"?`,
          body: "Tindakan ini permanen.",
          onConfirm: () => performAction(task, "delete"),
        });
        return;
      }
      void performAction(task, action);
    },
    [performAction],
  );

  const moveTo = useCallback(
    async (taskId: string, toStatus: string) => {
      const task = allTasks.find((x) => x.id === taskId);
      if (!task || task.status === toStatus) return;
      setActionError(null);
      markBusy(taskId, true);
      try {
        const res = (await getClient()?.request("kanban.moveTask", { board, taskId, toStatus })) as
          | { ok?: boolean; error?: string }
          | undefined;
        if (!res?.ok) setActionError(res?.error || `Tidak bisa memindahkan ke ${statusMeta(toStatus).label}`);
        await refetch();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Pindah gagal");
      } finally {
        markBusy(taskId, false);
      }
    },
    [board, refetch, allTasks],
  );

  const openCreate = useCallback((pf?: TaskPrefill) => {
    setPrefill(pf ?? null);
    setCreateOpen(true);
  }, []);

  const openOrchestrator = useCallback(() => setOrchOpen(true), []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectColumn = useCallback((ids: string[], on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clearSelect = useCallback(() => setSelectedIds(new Set()), []);

  const performBulk = useCallback(
    async (action: KanbanAction, ids: string[]) => {
      if (ids.length === 0) return;
      setBulkBusy(true);
      setActionError(null);
      try {
        // Run independently; a rejected/refused item must not abort the rest.
        const results = await Promise.allSettled(
          ids.map((id) =>
            getClient()
              ?.request("kanban.action", { board, taskId: id, action })
              .then((r) => ({ id, ok: !!(r as { ok?: boolean } | undefined)?.ok })),
          ),
        );
        const failed = ids.filter((id, i) => {
          const r = results[i];
          return r.status === "rejected" || !(r.value && r.value.ok);
        });
        if (failed.length > 0) {
          setActionError(`${failed.length} dari ${ids.length} tugas gagal diproses.`);
          setSelectedIds(new Set(failed)); // keep only the ones that need attention
        } else {
          clearSelect();
        }
        await refetch();
      } finally {
        setBulkBusy(false);
      }
    },
    [board, refetch, clearSelect],
  );

  const bulkAction = useCallback(
    (action: KanbanAction) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      if (action === "delete") {
        setConfirmState({
          title: `Hapus ${ids.length} tugas terpilih?`,
          body: "Tindakan ini permanen.",
          onConfirm: () => performBulk(action, ids),
        });
        return;
      }
      void performBulk(action, ids);
    },
    [selectedIds, performBulk],
  );

  const deleteOne = useCallback(
    async (taskId: string) => {
      markBusy(taskId, true);
      setActionError(null);
      try {
        const res = (await getClient()?.request("kanban.action", { board, taskId, action: "delete" })) as
          | { ok?: boolean; error?: string }
          | undefined;
        if (!res?.ok) setActionError(res?.error || "Tugas tidak bisa dihapus.");
        await refetch();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Gagal menghapus tugas.");
      } finally {
        markBusy(taskId, false);
      }
    },
    [board, refetch],
  );

  // Drag-to-trash: open the styled confirm, then delete on confirm.
  const requestDeleteOne = useCallback(
    (taskId: string) => {
      setConfirmState({
        title: "Hapus tugas ini?",
        body: "Tindakan ini permanen.",
        onConfirm: () => deleteOne(taskId),
      });
    },
    [deleteOne],
  );

  const nudge = useCallback(async () => {
    setNudging(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = (await getClient()?.request("kanban.nudge", { board })) as
        | { ok?: boolean; promoted?: number; reclaimed?: number; error?: string }
        | undefined;
      if (res?.ok) {
        setNotice(`Siap! ${res.promoted ?? 0} tugas didorong untuk dikerjakan sekarang.`);
      } else {
        setActionError(res?.error || "Gagal mendorong tugas. Coba lagi.");
      }
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Gagal mendorong tugas. Coba lagi.");
    } finally {
      setNudging(false);
    }
  }, [board, refetch]);

  const boards = boardsRpc.data?.boards ?? [];
  const switchBoard = useCallback(
    async (slug: string) => {
      if (slug === board) return;
      try {
        await getClient()?.request("kanban.setBoard", { slug });
        await boardsRpc.refetch();
        await refetch();
      } catch {
        /* surfaced on next poll */
      }
    },
    [board, boardsRpc, refetch],
  );

  const slugify = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

  const submitBoard = useCallback(
    async (name: string) => {
      const slug = slugify(name);
      try {
        const res = (await getClient()?.request("kanban.createBoard", { slug, name })) as
          | { ok?: boolean; error?: string }
          | undefined;
        if (!res?.ok) {
          setActionError(res?.error || "Gagal membuat papan");
          return;
        }
        await getClient()?.request("kanban.setBoard", { slug });
        await boardsRpc.refetch();
        await refetch();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Gagal membuat papan");
      }
    },
    [boardsRpc, refetch],
  );

  const createBoard = useCallback(() => setBoardPromptOpen(true), []);

  const performArchiveBoard = useCallback(async () => {
    try {
      await getClient()?.request("kanban.removeBoard", { slug: board });
      await getClient()?.request("kanban.setBoard", { slug: "default" });
      await boardsRpc.refetch();
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Gagal menghapus papan");
    }
  }, [board, boardsRpc, refetch]);

  const archiveBoard = useCallback(() => {
    if (board === "default") {
      setActionError("Papan utama tidak bisa dihapus.");
      return;
    }
    setConfirmState({
      title: `Hapus papan "${board}"?`,
      body: "Tugas di dalamnya ikut tersimpan sebagai arsip, dan kamu kembali ke papan utama.",
      onConfirm: performArchiveBoard,
    });
  }, [board, performArchiveBoard]);

  const stats = tasksRpc.data?.stats?.by_status ?? {};
  const total = allTasks.length;
  const running = stats.running ?? 0;
  // Fingerprint of status distribution + total failure pressure. Diagnostics
  // re-runs when this changes (status churn / new failure loop), not merely on
  // task-count change, while staying stable across no-op polls.
  const diagFingerprint = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let fails = 0;
    for (const tsk of allTasks) {
      byStatus[tsk.status] = (byStatus[tsk.status] ?? 0) + 1;
      fails += tsk.consecutive_failures ?? 0;
    }
    return (
      Object.entries(byStatus)
        .sort()
        .map(([s, n]) => `${s}:${n}`)
        .join(",") + `|f${fails}`
    );
  }, [allTasks]);
  const filtersDirty = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  const columnProps = {
    busyIds,
    dragOver,
    setDragOver,
    dragId,
    setDragId,
    selectedIds,
    onToggleSelect: toggleSelect,
    onSelectColumn: selectColumn,
    onOpen: setDetailTask,
    onAction: runAction,
    onMove: moveTo,
    onAdd: (status: KanbanStatus) =>
      openCreate(COLUMN_START[status] ? ({ title: "" } as TaskPrefill) : undefined),
  };

  // Lanes-by-profile groups: one lane per assignee present in filtered tasks.
  const lanes = useMemo(() => {
    if (!filters.lanesByProfile) return null;
    const map = new Map<string, KanbanTask[]>();
    for (const task of tasks) {
      const key = task.assignee || "—";
      (map.get(key) ?? map.set(key, []).get(key)!).push(task);
    }
    // Group each lane by status ONCE here, instead of re-running groupByStatus
    // for every column on every render (O(lanes x columns x n log n) per render).
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([assignee, laneTasks]) => ({
        assignee,
        count: laneTasks.length,
        grouped: groupByStatus(laneTasks),
      }));
  }, [filters.lanesByProfile, tasks, groupByStatus]);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        eyebrow="TASK BOARD"
        title={boardLabel}
        subtitle="Antrekan pekerjaan untuk agenmu. Mereka mengambil, mengerjakan, dan menyelesaikannya otomatis — kamu tinggal pantau dan arahkan."
        actions={
          <>
            {/* Konteks papan (kiri) */}
            <BoardSwitcher boards={boards} current={board} taskCount={total} onSwitch={switchBoard} onCreate={createBoard} onArchive={archiveBoard} />
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              title="Apa fungsi papan ini & tiap kolomnya?"
              className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-300"
            >
              <HelpCircle className="size-4" />
            </button>

            <span className="mx-0.5 h-6 w-px bg-white/10" />

            {/* Pengaturan + aksi buat (kanan) */}
            <button
              type="button"
              onClick={() => setOrchOpen(true)}
              title="Atur cara agen membagi & mengerjakan tugas"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200"
            >
              <Settings2 className="size-4" />
              Atur Orkestrator
            </button>
            <button
              type="button"
              onClick={() => setSwarmOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fuchsia-400/40 px-3 py-2 text-xs text-fuchsia-200 transition hover:bg-fuchsia-400/10"
              title="Suruh beberapa agen mengerjakan satu tujuan bareng-bareng"
            >
              <Users className="size-3.5" />
              Swarm
            </button>
            <button
              type="button"
              onClick={() => openCreate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 px-3.5 py-2 text-xs font-semibold text-[#0B0E14] shadow-[0_8px_24px_-6px_rgba(99,102,241,0.55)] transition hover:brightness-110"
            >
              <Plus className="size-3.5" />
              Tugas baru
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-[#0B0E14]/30 px-6 py-2.5">
        <StatPill label="Total" value={total} />
        <StatPill label="Berjalan" value={running} accent="emerald" live={running > 0} />
        <StatPill label="Terblokir" value={stats.blocked ?? 0} accent="red" />
        <StatPill label="Selesai" value={stats.done ?? 0} accent="green" />
      </div>

      <KanbanFilters
        state={filters}
        setState={setFilters}
        assignees={assigneeOptions}
        tenants={tenantOptions}
        onNudge={() => void nudge()}
        nudging={nudging}
        onRefresh={() => void refetch()}
        refreshing={tasksRpc.loading}
        onClear={() => setFilters(DEFAULT_FILTERS)}
        dirty={filtersDirty}
      />

      <KanbanDiagnostics board={board} onOpenTask={(tid) => {
        const found = allTasks.find((x) => x.id === tid);
        if (found) setDetailTask(found);
      }} refreshKey={diagFingerprint} />

      {actionError ? (
        <div role="alert" aria-live="assertive" className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-amber-300/70 hover:text-amber-200">
            Tutup
          </button>
        </div>
      ) : null}

      {notice ? (
        <div role="status" aria-live="polite" className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-emerald-300/70 hover:text-emerald-200">
            Tutup
          </button>
        </div>
      ) : null}

      {tasksRpc.error || tasksRpc.data?.error ? (
        // A bridge-embedded error (engine DB locked/corrupt/module-drift) resolves
        // as {tasks:[],error} — without surfacing it the user would see a FAKE
        // empty board ("buat tugas pertama") instead of a real failure state.
        <EmptyState icon={KanbanSquare} title="Tidak bisa memuat papan" subtitle={tasksRpc.error ?? tasksRpc.data?.error} />
      ) : tasksRpc.data == null ? (
        <KanbanBoardSkeleton />
      ) : total === 0 ? (
        <KanbanEmpty onTemplate={(pf) => openCreate(pf)} onBlank={() => openCreate()} />
      ) : lanes ? (
        <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
          {lanes.map((lane) => (
            <div key={lane.assignee}>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-md border border-cyan-400/30 bg-cyan-400/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300/90">
                  {lane.assignee === "—" ? "Tanpa agen" : lane.assignee}
                </span>
                <span className="text-[11px] text-white/40">{lane.count} tugas</span>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {visibleColumns.map((status) => (
                  <BoardColumn key={status} status={status} tasks={lane.grouped.get(status) ?? []} compact {...columnProps} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-max gap-3 px-6 py-4">
            {visibleColumns.map((status) => (
              <BoardColumn key={status} status={status} tasks={byStatus.get(status) ?? []} {...columnProps} />
            ))}
            <DropToDelete dragId={dragId} onDelete={requestDeleteOne} />
          </div>
        </div>
      )}

      {selectedIds.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-[#0B0E14]/95 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
            <span className="text-xs font-medium text-white/85">{selectedIds.size} dipilih</span>
            <div className="h-4 w-px bg-white/15" />
            <button type="button" disabled={bulkBusy} onClick={() => void bulkAction("complete")} className="rounded-lg border border-green-400/40 px-2.5 py-1 text-xs text-green-300 hover:bg-green-400/10 disabled:opacity-50">Selesaikan</button>
            <button type="button" disabled={bulkBusy} onClick={() => void bulkAction("archive")} className="rounded-lg border border-white/12 px-2.5 py-1 text-xs text-white/75 hover:bg-white/[0.06] disabled:opacity-50">Arsipkan</button>
            <button type="button" disabled={bulkBusy} onClick={() => void bulkAction("delete")} className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">Hapus</button>
            <button type="button" onClick={clearSelect} className="rounded-lg px-2 py-1 text-xs text-white/50 hover:text-white/80">Batal</button>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <CreateWizard
          board={board}
          agents={agents}
          startPrefill={prefill}
          onClose={() => {
            setCreateOpen(false);
            setPrefill(null);
          }}
          onCreated={() => void refetch()}
          onPickSwarm={() => setSwarmOpen(true)}
          onPickOrchestrator={openOrchestrator}
        />
      ) : null}

      {helpOpen ? <KanbanHelp onClose={() => setHelpOpen(false)} /> : null}

      {orchOpen ? <KanbanOrchestration board={board} onClose={() => setOrchOpen(false)} /> : null}

      {swarmOpen ? (
        <SwarmDialog
          board={board}
          agents={agents}
          onClose={() => setSwarmOpen(false)}
          onCreated={() => void refetch()}
        />
      ) : null}

      {detailTask ? (
        <TaskDetailDrawer
          board={board}
          task={allTasks.find((x) => x.id === detailTask.id) ?? detailTask}
          agents={agents}
          allTasks={allTasks}
          onClose={() => setDetailTask(null)}
          onChanged={() => void refetch()}
          onAction={runAction}
        />
      ) : null}

      <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />

      <PromptDialog
        open={boardPromptOpen}
        title="Bikin papan baru"
        label="Nama papan"
        placeholder="mis. Proyek Toko"
        confirmLabel="Bikin"
        validate={(v) =>
          !v
            ? "Wajib diisi."
            : slugify(v)
              ? null
              : "Nama harus mengandung huruf atau angka."
        }
        onSubmit={submitBoard}
        onClose={() => setBoardPromptOpen(false)}
      />
    </div>
  );
}

type ColumnProps = {
  busyIds: Set<string>;
  dragOver: string | null;
  setDragOver: (s: string | null) => void;
  dragId: string | null;
  setDragId: (s: string | null) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectColumn: (ids: string[], on: boolean) => void;
  onOpen: (t: KanbanTask) => void;
  onAction: (t: KanbanTask, a: KanbanAction) => void;
  onMove: (taskId: string, toStatus: string) => void;
  onAdd: (status: KanbanStatus) => void;
};

function BoardColumn({
  status,
  tasks,
  compact,
  busyIds,
  dragOver,
  setDragOver,
  dragId,
  setDragId,
  selectedIds,
  onToggleSelect,
  onSelectColumn,
  onOpen,
  onAction,
  onMove,
  onAdd,
}: ColumnProps & { status: KanbanStatus; tasks: KanbanTask[]; compact?: boolean }) {
  const meta = statusMeta(status);
  const isOver = dragOver === status;
  const ids = tasks.map((t) => t.id);
  const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOver !== status) setDragOver(status);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain") || dragId;
        setDragOver(null);
        setDragId(null);
        if (id) onMove(id, status);
      }}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-2xl border bg-white/[0.015] transition",
        compact ? "max-h-80" : "h-full",
        isOver ? "border-cyan-400/50 bg-cyan-400/[0.06]" : "border-white/[0.06]",
      )}
    >
      <div className="border-b border-white/[0.06] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={ids.length === 0}
              onChange={(e) => onSelectColumn(ids, e.target.checked)}
              title="Pilih semua di kolom ini"
              className="size-3.5 accent-cyan-400 disabled:opacity-30"
            />
            <span className={cn("size-2 rounded-full", meta.dot, meta.live && "animate-pulse")} />
            <span className={cn("font-mono text-[11px] uppercase tracking-[0.16em]", meta.text)}>{meta.label}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-white/55">{tasks.length}</span>
            <button
              type="button"
              onClick={() => onAdd(status)}
              title="Tambah tugas"
              className="flex size-5 items-center justify-center rounded-md border border-white/10 text-white/50 transition hover:border-cyan-400/40 hover:text-cyan-300"
            >
              <Plus className="size-3" />
            </button>
          </div>
        </div>
        {!compact ? <p className="mt-1 text-[10px] leading-tight text-white/30">{meta.hint}</p> : null}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
        {tasks.length === 0 ? (
          <p className="px-1 py-5 text-center text-[11px] text-white/20">— kosong —</p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              busy={busyIds.has(task.id)}
              selected={selectedIds.has(task.id)}
              onToggleSelect={onToggleSelect}
              onOpen={onOpen}
              onAction={onAction}
              onDragStart={(t) => setDragId(t.id)}
              onDragEnd={() => {
                setDragId(null);
                setDragOver(null);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DropToDelete({ dragId, onDelete }: { dragId: string | null; onDelete: (id: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain") || dragId;
        setOver(false);
        // Confirmation is handled by the parent's styled dialog (onDelete opens it).
        if (id) onDelete(id);
      }}
      className={cn(
        "flex w-44 shrink-0 flex-col items-center justify-center gap-2 self-stretch rounded-2xl border-2 border-dashed transition",
        over ? "border-red-500/60 bg-red-500/10 text-red-200" : "border-white/10 text-white/30",
      )}
    >
      <Trash2 className={cn("size-6", over && "scale-110")} />
      <span className="text-[11px] font-medium">Tarik ke sini untuk hapus</span>
    </div>
  );
}

function BoardSwitcher({
  boards,
  current,
  taskCount,
  onSwitch,
  onCreate,
  onArchive,
}: {
  boards: { slug: string; name: string }[];
  current: string;
  taskCount: number;
  onSwitch: (slug: string) => void;
  onCreate: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const currentName = boards.find((b) => b.slug === current)?.name || current || "Default";
  // Esc closes the open dropdown (was only closeable via the click-away layer).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Papan aktif: ${currentName}. Ganti papan`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/80 transition hover:bg-white/[0.06]"
      >
        <KanbanSquare className="size-3.5 text-cyan-300" />
        <span className="max-w-32 truncate">{currentName}</span>
        <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-white/50">{taskCount}</span>
        <ChevronDown className="size-3.5 text-white/40" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14] py-1 shadow-2xl">
            <p className="px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">Papan</p>
            {boards.map((b) => (
              <button
                key={b.slug}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSwitch(b.slug);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-white/80 transition hover:bg-white/[0.06]"
              >
                <span className="truncate">{b.name || b.slug}</span>
                {b.slug === current ? <Check className="size-3.5 text-cyan-300" /> : null}
              </button>
            ))}
            <div className="my-1 h-px bg-white/[0.06]" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-cyan-300 transition hover:bg-white/[0.06]"
            >
              <FolderPlus className="size-3.5" /> Papan baru
            </button>
            {current !== "default" ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onArchive();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-300 transition hover:bg-white/[0.06]"
              >
                <Trash2 className="size-3.5" /> Hapus papan ini
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// Initial-load placeholder so a cold WS connect never flashes the false
// "board kosong, buat tugas pertama" hero before the first fetch resolves.
function KanbanBoardSkeleton() {
  return (
    <div className="flex flex-1 gap-3 overflow-hidden px-6 py-4" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="w-72 shrink-0 space-y-2">
          <div className="h-6 w-32 animate-pulse rounded-md bg-white/[0.05]" />
          {Array.from({ length: 3 - (i % 3) }).map((__, j) => (
            <div
              key={j}
              className="h-20 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.03]"
              style={{ animationDelay: `${(i * 3 + j) * 60}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function StatPill({
  label,
  value,
  accent,
  live,
}: {
  label: string;
  value: number;
  accent?: "emerald" | "red" | "green";
  live?: boolean;
}) {
  const dot =
    accent === "emerald"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
      : accent === "red"
        ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]"
        : accent === "green"
          ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.7)]"
          : "bg-white/40";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/65">
      <span className={cn("size-1.5 rounded-full", dot, live && "animate-pulse")} />
      <span className="font-mono uppercase tracking-[0.14em] text-white/40">{label}</span>
      <span className="font-semibold text-white/85">{value}</span>
    </span>
  );
}
