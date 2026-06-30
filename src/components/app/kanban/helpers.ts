/**
 * Kanban (Papan Tugas) — shared types + status metadata.
 *
 * Mirrors the engine's agentic task board (hermes_cli.kanban_db) via the
 * bridge `kanban.*` RPCs. Status lifecycle + transitions are engine-driven:
 * tasks created as `ready`/`running`/`blocked`, the dispatcher claims + runs
 * them, and manual transitions are limited to the semantic ones the engine
 * exposes (block/unblock/complete/archive/promote). The board surfaces all
 * nine statuses as columns; drag-drop only fires transitions the engine
 * accepts and reports a friendly message otherwise.
 */

export type KanbanStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "archived";

export type KanbanTask = {
  id: string;
  title: string;
  body?: string | null;
  assignee?: string | null;
  status: KanbanStatus;
  priority: number;
  created_by?: string | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  updated_at?: number | null;
  current_run_id?: number | null;
  model_override?: string | null;
  session_id?: string | null;
  skills?: string[] | null;
  board?: string | null;
  workspace_kind?: string | null;
  workspace_path?: string | null;
  worker_pid?: number | null;
  result?: string | null;
  last_failure_error?: string | null;
  consecutive_failures?: number | null;
  max_runtime_seconds?: number | null;
  max_retries?: number | null;
  last_heartbeat_at?: number | null;
};

export type KanbanTaskRef = {
  id: string;
  title: string;
  status: KanbanStatus;
  assignee?: string | null;
};

export type KanbanNotifySub = {
  platform: string;
  chat_id: string;
  thread_id?: string | null;
  [k: string]: unknown;
};

export type KanbanBoard = {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  archived?: boolean;
};

export type KanbanComment = {
  id: number;
  author?: string;
  body: string;
  created_at?: number | null;
};

export type KanbanEvent = {
  id?: number;
  kind?: string;
  type?: string;
  actor?: string;
  detail?: string;
  body?: string;
  created_at?: number | null;
  [k: string]: unknown;
};

export type KanbanRun = {
  id?: number;
  run_id?: number;
  task_id?: string;
  profile?: string | null;
  step_key?: string | null;
  status?: string;
  outcome?: string | null;
  summary?: string | null;
  error?: string | null;
  worker_pid?: number | null;
  started_at?: number | null;
  ended_at?: number | null;
  [k: string]: unknown;
};

export type KanbanTasksResult = {
  tasks: KanbanTask[];
  stats: {
    by_status?: Record<string, number>;
    by_assignee?: Record<string, number>;
    oldest_ready_age_seconds?: number | null;
    now?: number;
  };
  statuses: string[];
  board?: string;
  error?: string;
};

export type KanbanBoardsResult = {
  boards: KanbanBoard[];
  current: string;
  error?: string;
};

export type KanbanDetailResult = {
  task?: KanbanTask;
  comments?: KanbanComment[];
  events?: KanbanEvent[];
  runs?: KanbanRun[];
  parents?: KanbanTaskRef[];
  children?: KanbanTaskRef[];
  notify?: KanbanNotifySub[];
  workerLog?: string | null;
  error?: string;
};

export function absoluteTime(ts?: number | null): string {
  if (!ts) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  try {
    return new Date(ms).toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function formatDuration(start?: number | null, end?: number | null): string {
  if (!start) return "";
  const s = start < 1e12 ? start * 1000 : start;
  const e = end ? (end < 1e12 ? end * 1000 : end) : Date.now();
  const sec = Math.max(0, Math.floor((e - s) / 1000));
  if (sec < 60) return `${sec}d`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}d`;
  const h = Math.floor(m / 60);
  return `${h}j ${m % 60}m`;
}

/** Column order = engine lifecycle order. */
export const STATUS_ORDER: KanbanStatus[] = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
];

type StatusMeta = {
  label: string;
  hint: string;
  /** tailwind accent classes */
  dot: string;
  ring: string;
  text: string;
  /** running gets a live pulse */
  live?: boolean;
};

export const STATUS_META: Record<KanbanStatus, StatusMeta> = {
  triage: {
    label: "Perlu dirinci",
    hint: "Ide mentah — akan dirinci & dipecah dulu",
    dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]",
    ring: "border-amber-400/30",
    text: "text-amber-300",
  },
  todo: {
    label: "Antre",
    hint: "Menunggu dependensi / belum ada agen",
    dot: "bg-slate-400 shadow-[0_0_8px_rgba(148,163,184,0.6)]",
    ring: "border-slate-400/25",
    text: "text-slate-300",
  },
  scheduled: {
    label: "Dijadwalkan",
    hint: "Menunggu jadwal / waktu tertentu",
    dot: "bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.7)]",
    ring: "border-indigo-400/30",
    text: "text-indigo-300",
  },
  ready: {
    label: "Siap",
    hint: "Siap — tinggal di-dispatch ke agen",
    dot: "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.75)]",
    ring: "border-cyan-400/30",
    text: "text-cyan-300",
  },
  running: {
    label: "Dikerjakan",
    hint: "Sedang dikerjakan agen",
    dot: "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.85)]",
    ring: "border-emerald-400/35",
    text: "text-emerald-300",
    live: true,
  },
  blocked: {
    label: "Butuh kamu",
    hint: "Agen butuh jawaban / bantuanmu untuk lanjut",
    dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.75)]",
    ring: "border-red-500/35",
    text: "text-red-300",
  },
  review: {
    label: "Dicek",
    hint: "Menunggu dicek sebelum dianggap selesai",
    dot: "bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.75)]",
    ring: "border-fuchsia-400/30",
    text: "text-fuchsia-300",
  },
  done: {
    label: "Selesai",
    hint: "Tugas tuntas",
    dot: "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.7)]",
    ring: "border-green-400/30",
    text: "text-green-300",
  },
  archived: {
    label: "Arsip",
    hint: "Diarsipkan",
    dot: "bg-zinc-500",
    ring: "border-zinc-500/25",
    text: "text-zinc-400",
  },
};

export function statusMeta(s: string): StatusMeta {
  return STATUS_META[(s as KanbanStatus)] ?? STATUS_META.todo;
}

export type KanbanAction =
  | "complete"
  | "block"
  | "unblock"
  | "promote"
  | "archive"
  | "delete";

/** Which manual transitions the engine accepts from a given status. */
export function allowedActions(status: KanbanStatus): KanbanAction[] {
  switch (status) {
    case "running":
    case "ready":
      return ["block", "complete", "archive", "delete"];
    case "blocked":
      return ["unblock", "promote", "complete", "archive", "delete"];
    case "todo":
      return ["promote", "block", "complete", "archive", "delete"];
    case "review":
      return ["complete", "block", "archive", "delete"];
    case "triage":
      return ["archive", "delete"];
    case "scheduled":
      return ["block", "archive", "delete"];
    case "done":
      return ["archive", "delete"];
    case "archived":
      return ["delete"];
    default:
      return ["delete"];
  }
}

export const ACTION_LABEL: Record<KanbanAction, string> = {
  complete: "Tandai selesai",
  block: "Tahan dulu",
  unblock: "Lanjutkan",
  promote: "Jadikan siap",
  archive: "Arsipkan",
  delete: "Hapus",
};

const PRIORITY_META: { min: number; label: string; cls: string }[] = [
  { min: 3, label: "Mendesak", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  { min: 2, label: "Tinggi", cls: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  { min: 1, label: "Sedang", cls: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300" },
];

export function priorityMeta(p: number): { label: string; cls: string } | null {
  if (!p || p <= 0) return null;
  for (const m of PRIORITY_META) if (p >= m.min) return { label: m.label, cls: m.cls };
  return null;
}

export function relativeTime(ts?: number | null): string {
  if (!ts) return "";
  // engine stores epoch seconds
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const diff = Date.now() - ms;
  if (diff < 0) return "baru saja";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} hr lalu`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} bln lalu`;
  return `${Math.floor(mo / 12)} thn lalu`;
}
