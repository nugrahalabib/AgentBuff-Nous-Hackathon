"use client";

import { useEffect, useRef, useState } from "react";
import {
  X,
  Loader2,
  MessageSquare,
  Send,
  History,
  ListChecks,
  CalendarClock,
  UserCog,
  Bell,
  GitBranch,
  Terminal,
  RefreshCw,
  Pencil,
  Link2,
  Unlink,
  FolderGit2,
  Split,
  RotateCcw,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/app/store";
import { useDialogA11y } from "./use-dialog-a11y";
import {
  type KanbanTask,
  type KanbanTaskRef,
  type KanbanAction,
  type KanbanDetailResult,
  type KanbanComment,
  type KanbanEvent,
  type KanbanRun,
  type KanbanNotifySub,
  allowedActions,
  ACTION_LABEL,
  statusMeta,
  priorityMeta,
  relativeTime,
  absoluteTime,
  formatDuration,
} from "./helpers";

type AgentOpt = { id: string; name: string };

export function TaskDetailDrawer({
  board,
  task,
  agents,
  allTasks,
  onClose,
  onChanged,
  onAction,
}: {
  board: string;
  task: KanbanTask;
  agents: AgentOpt[];
  allTasks: KanbanTask[];
  onClose: () => void;
  onChanged: () => void;
  onAction: (task: KanbanTask, action: KanbanAction) => void;
}) {
  const [detail, setDetail] = useState<KanbanDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");
  // Mutation error surfaced inline (comment/edit rejected by the engine). The
  // bridge RESOLVES rejections as {ok:false,error} — it never throws — so we
  // must read res.ok and keep the user's text instead of silently clearing it.
  const [mutError, setMutError] = useState<string | null>(null);
  const [addChild, setAddChild] = useState("");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxText, setCtxText] = useState<string | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const load = async () => {
    const client = getClient();
    if (!client) return;
    try {
      const res = (await client.request("kanban.taskDetail", {
        board,
        taskId: task.id,
      })) as KanbanDetailResult;
      setDetail(res);
    } catch {
      setDetail({ error: "Gagal memuat detail" });
    } finally {
      setLoading(false);
    }
  };

  // Open / switch task: full reload + reset transient edit state.
  useEffect(() => {
    setLoading(true);
    setEditing(false);
    setMutError(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // The parent feeds a fresh task row every 6s poll + after every action. When
  // the engine row changes under us (status transition, run start/stop, failure
  // count, completion) reload the detail so the drawer never shows stale status
  // / stale action gates. Does NOT reset edit mode (only task.id switch does).
  const taskSig = `${task.status}:${task.updated_at ?? ""}:${task.completed_at ?? ""}:${task.current_run_id ?? ""}:${task.consecutive_failures ?? ""}:${task.last_heartbeat_at ?? ""}`;
  const firstSig = useRef(taskSig);
  useEffect(() => {
    if (firstSig.current === taskSig) return; // skip the initial mount (load already ran)
    firstSig.current = taskSig;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskSig]);

  // Esc-close + focus-trap + restore. `disabled={editing}` so Esc never discards
  // an in-progress edit (passing the live `editing` value re-registers the
  // handler on change, so there is no stale-closure capture).
  useDialogA11y(panelRef, onClose, editing);

  const refreshLog = async () => {
    setWorking(true);
    try {
      const res = (await getClient()?.request("kanban.workerLog", {
        board,
        taskId: task.id,
      })) as { log?: string | null } | undefined;
      setDetail((d) => (d ? { ...d, workerLog: res?.log ?? null } : d));
    } finally {
      setWorking(false);
    }
  };

  const act = async (method: string, params: Record<string, unknown>) => {
    setWorking(true);
    try {
      await getClient()?.request(method, { board, taskId: task.id, ...params });
      await load();
      onChanged();
    } finally {
      setWorking(false);
    }
  };

  const sendComment = async () => {
    if (!comment.trim() || sending) return;
    setSending(true);
    setMutError(null);
    try {
      const res = (await getClient()?.request("kanban.addComment", {
        board,
        taskId: task.id,
        body: comment.trim(),
      })) as { ok?: boolean; error?: string } | undefined;
      if (res && res.ok === false) {
        // Keep the user's text; surface why it was rejected.
        setMutError(res.error || "Komentar gagal dikirim. Coba lagi.");
        return;
      }
      setComment("");
      await load();
    } catch {
      setMutError("Komentar gagal dikirim. Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async () => {
    setWorking(true);
    setMutError(null);
    try {
      const res = (await getClient()?.request("kanban.editTask", {
        board,
        taskId: task.id,
        body: editBody,
      })) as { ok?: boolean; error?: string } | undefined;
      if (res && res.ok === false) {
        // Keep edit mode + text so the user doesn't lose their changes.
        setMutError(res.error || "Perubahan gagal disimpan. Coba lagi.");
        return;
      }
      setEditing(false);
      await load();
      onChanged();
    } catch {
      setMutError("Perubahan gagal disimpan. Coba lagi.");
    } finally {
      setWorking(false);
    }
  };

  const doDecompose = async () => {
    setWorking(true);
    try {
      const res = (await getClient()?.request("kanban.decompose", { board, taskId: task.id })) as
        | { ok?: boolean; fanout?: number; reason?: string; error?: string }
        | undefined;
      await load();
      onChanged();
      return res;
    } finally {
      setWorking(false);
    }
  };

  const doReclaim = async () => {
    setWorking(true);
    try {
      await getClient()?.request("kanban.reclaim", { board, taskId: task.id });
      await load();
      onChanged();
    } finally {
      setWorking(false);
    }
  };

  const loadContext = async () => {
    if (ctxText !== null) {
      setCtxOpen((v) => !v);
      return;
    }
    setCtxLoading(true);
    setCtxOpen(true);
    try {
      const res = (await getClient()?.request("kanban.context", { board, taskId: task.id })) as
        | { context?: string | null }
        | undefined;
      setCtxText(res?.context ?? "");
    } finally {
      setCtxLoading(false);
    }
  };

  const t = detail?.task ?? task;
  const comments = detail?.comments ?? [];
  const events = detail?.events ?? [];
  const runs = detail?.runs ?? [];
  const parents = detail?.parents ?? [];
  const children = detail?.children ?? [];
  const notify = detail?.notify ?? [];
  const workerLog = detail?.workerLog;
  const meta = statusMeta(t.status);
  const prio = priorityMeta(t.priority);
  const actions = allowedActions(t.status);
  const canEdit = t.status === "triage" || t.status === "done";
  const canDecompose = t.status === "triage";
  const canReclaim = t.status === "running" || t.status === "blocked";

  const childCandidates = allTasks.filter(
    (x) => x.id !== t.id && !children.some((c) => c.id === x.id),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[#030014]/70 backdrop-blur-sm" onClick={onClose} />
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="kanban-drawer-title" className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-[#0B0E14] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-2">
              <span className={cn("size-2 rounded-full", meta.dot, meta.live && "animate-pulse")} />
              <span className={cn("font-mono text-[10px] uppercase tracking-[0.18em]", meta.text)}>
                {meta.label}
              </span>
              <span className="font-mono text-[10px] text-white/25">{t.id}</span>
            </div>
            <h2 id="kanban-drawer-title" className="text-base font-semibold leading-snug text-white/90">{t.title}</h2>
          </div>
          <button type="button" aria-label="Tutup" onClick={onClose} className="rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white/80">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Info table */}
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <InfoRow label="Status" value={<span className={meta.text}>{meta.label}</span>} />
            <InfoRow label="Agen" value={t.assignee || "—"} />
            <InfoRow label="Prioritas" value={prio ? prio.label : "Normal"} />
            {t.model_override ? <InfoRow label="Model" value={t.model_override} mono /> : null}
            <InfoRow
              label="Folder kerja"
              value={t.workspace_path ? `${t.workspace_kind ?? ""}: ${t.workspace_path}` : (t.workspace_kind || "—")}
              mono
            />
            <InfoRow label="Dibuat oleh" value={t.created_by || "—"} />
            <InfoRow label="Dibuat" value={absoluteTime(t.created_at)} />
            {t.started_at ? <InfoRow label="Mulai" value={absoluteTime(t.started_at)} /> : null}
            {t.completed_at ? <InfoRow label="Selesai" value={absoluteTime(t.completed_at)} /> : null}
            {t.session_id ? <InfoRow label="Sesi" value={String(t.session_id)} mono /> : null}
            {t.current_run_id ? <InfoRow label="Pengerjaan ke" value={`#${t.current_run_id}`} /> : null}
            {t.worker_pid ? <InfoRow label="ID proses" value={String(t.worker_pid)} mono /> : null}
            {t.max_runtime_seconds ? <InfoRow label="Batas waktu" value={`${t.max_runtime_seconds}d`} /> : null}
            {t.consecutive_failures ? <InfoRow label="Gagal berturut-turut" value={String(t.consecutive_failures)} /> : null}
          </div>

          {t.last_failure_error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">
              <span className="font-mono text-[10px] uppercase tracking-wide text-red-300/70">Kesalahan terakhir</span>
              <p className="mt-1 whitespace-pre-wrap">{t.last_failure_error}</p>
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                disabled={working}
                onClick={() => onAction(t, a)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-xs transition disabled:opacity-50",
                  a === "delete"
                    ? "border-red-500/40 text-red-300 hover:bg-red-500/10"
                    : a === "complete"
                      ? "border-green-400/40 text-green-300 hover:bg-green-400/10"
                      : "border-white/12 text-white/75 hover:bg-white/[0.06]",
                )}
              >
                {ACTION_LABEL[a]}
              </button>
            ))}
          </div>

          {/* Special ops: decompose / reclaim / context */}
          {(canDecompose || canReclaim) ? (
            <div className="flex flex-wrap gap-2">
              {canDecompose ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={async () => {
                    const r = await doDecompose();
                    if (r && !r.ok) setMutError(`Gagal memecah: ${r.error || "tidak bisa dipecah."}`);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-fuchsia-400/40 px-2.5 py-1.5 text-xs text-fuchsia-200 transition hover:bg-fuchsia-400/10 disabled:opacity-50"
                >
                  <Split className="size-3.5" /> Pecah jadi langkah
                </button>
              ) : null}
              {canReclaim ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void doReclaim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 px-2.5 py-1.5 text-xs text-amber-200 transition hover:bg-amber-400/10 disabled:opacity-50"
                  title="Mulai ulang kalau tugas macet di tengah jalan"
                >
                  <RotateCcw className="size-3.5" /> Mulai ulang
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void loadContext()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/75 transition hover:bg-white/[0.06]"
              >
                <FileText className="size-3.5" /> Lihat instruksi agen
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void loadContext()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/75 transition hover:bg-white/[0.06]"
            >
              <FileText className="size-3.5" /> Lihat instruksi agen
            </button>
          )}

          {ctxOpen ? (
            ctxLoading ? (
              <div className="flex items-center gap-2 text-xs text-white/40">
                <Loader2 className="size-3.5 animate-spin" /> Memuat instruksi…
              </div>
            ) : (
              <pre className="max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/65">
                {ctxText || "(belum ada instruksi)"}
              </pre>
            )
          ) : null}

          {/* Kelola: reassign + schedule */}
          <Section icon={<UserCog className="size-3.5" />} title="Atur tugas">
            <div className="flex items-center gap-2">
              <select
                value={t.assignee ?? ""}
                disabled={working}
                onChange={(e) => void act("kanban.reassign", { assignee: e.target.value || null })}
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/85 focus:border-cyan-400/50 focus:outline-none"
              >
                <option value="" className="bg-[#0B0E14]">— tanpa agen —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[#0B0E14]">{a.name}</option>
                ))}
              </select>
              {t.status !== "done" && t.status !== "archived" && t.status !== "scheduled" ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void act("kanban.schedule", {})}
                  title="Parkir tugas ini (berhenti dikerjakan) sampai kamu lanjutkan lagi. Untuk jadwal otomatis per waktu, pakai tab Jadwal."
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/40 px-2.5 py-1.5 text-xs text-indigo-200 transition hover:bg-indigo-400/10 disabled:opacity-50"
                >
                  <CalendarClock className="size-3.5" /> Tunda/parkir
                </button>
              ) : null}
            </div>
          </Section>

          {/* Description + edit */}
          <Section
            icon={<Pencil className="size-3.5" />}
            title="Catatan / instruksi"
            action={
              canEdit && !editing ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditBody(t.status === "done" ? (t.result ?? "") : (t.body ?? ""));
                    setEditing(true);
                  }}
                  className="text-[11px] text-cyan-300/80 hover:text-cyan-200"
                >
                  {t.status === "done" ? "edit hasil" : "edit"}
                </button>
              ) : null
            }
          >
            {editing ? (
              <div className="space-y-2">
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none"
                />
                {mutError ? (
                  <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-200">
                    {mutError}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setEditing(false); setMutError(null); }} className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-white/70 hover:bg-white/[0.06]">Batal</button>
                  <button type="button" disabled={working} onClick={saveEdit} className="rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-3 py-1 text-xs font-semibold text-[#0B0E14] hover:brightness-110 disabled:opacity-50">Simpan</button>
                </div>
              </div>
            ) : t.body ? (
              <p className="whitespace-pre-wrap text-sm text-white/75">{t.body}</p>
            ) : (
              <p className="text-xs text-white/35">— tanpa deskripsi —</p>
            )}
          </Section>

          {/* Notify channels */}
          {notify.length > 0 ? (
            <Section icon={<Bell className="size-3.5" />} title="Kabari lewat channel">
              <div className="flex flex-wrap gap-1.5">
                {notify.map((n: KanbanNotifySub, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/70">
                    {n.platform}
                    <button
                      type="button"
                      onClick={() => void act("kanban.notifyRemove", { platform: n.platform, chatId: n.chat_id, threadId: n.thread_id ?? null })}
                      className="text-white/40 hover:text-red-300"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Dependencies */}
          <Section icon={<GitBranch className="size-3.5" />} title="Tugas terkait">
            <div className="space-y-3">
              <DepList
                label="Bagian dari"
                items={parents}
                onRemove={(pid) => void act("kanban.unlinkTask", { parentId: pid, childId: t.id })}
              />
              <div>
                <DepList
                  label="Sub-tugas"
                  items={children}
                  onRemove={(cid) => void act("kanban.unlinkTask", { parentId: t.id, childId: cid })}
                />
                {childCandidates.length > 0 ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <select
                      value={addChild}
                      onChange={(e) => setAddChild(e.target.value)}
                      className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/85 focus:border-cyan-400/50 focus:outline-none"
                    >
                      <option value="" className="bg-[#0B0E14]">— tambah sub-tugas —</option>
                      {childCandidates.map((x) => (
                        <option key={x.id} value={x.id} className="bg-[#0B0E14]">{x.title.slice(0, 40)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!addChild || working}
                      onClick={() => {
                        const cid = addChild;
                        setAddChild("");
                        void act("kanban.linkTask", { parentId: t.id, childId: cid });
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/40 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40"
                    >
                      <Link2 className="size-3.5" /> Hubungkan
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </Section>

          {/* Worker log */}
          <Section
            icon={<Terminal className="size-3.5" />}
            title="Catatan kerja agen"
            action={
              <button
                type="button"
                onClick={refreshLog}
                className="inline-flex items-center gap-1 text-[11px] text-cyan-300/80 hover:text-cyan-200"
              >
                <RefreshCw className={cn("size-3", working && "animate-spin")} /> segarkan
              </button>
            }
          >
            {workerLog ? (
              <pre
                ref={logRef}
                className="max-h-64 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70"
              >
                {workerLog}
              </pre>
            ) : (
              <p className="text-xs text-white/35">Belum ada log — agen belum mulai mengerjakan tugas ini.</p>
            )}
          </Section>

          {/* Run history */}
          {runs.length > 0 ? (
            <Section icon={<History className="size-3.5" />} title={`Riwayat pengerjaan (${runs.length})`}>
              <div className="space-y-1.5">
                {runs.slice().reverse().map((r: KanbanRun, i) => (
                  <div key={r.id ?? i} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-white/75">
                        Pengerjaan #{r.id ?? r.run_id} · {r.profile ?? "—"}
                      </span>
                      <span className={cn("font-mono text-[10px] uppercase tracking-wide", statusMeta(String(r.status ?? "")).text)}>
                        {r.outcome || r.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/40">
                      <span>{absoluteTime(r.started_at)}</span>
                      <span>· {formatDuration(r.started_at, r.ended_at)}</span>
                    </div>
                    {r.summary ? <p className="mt-1 text-xs text-white/60">{r.summary}</p> : null}
                    {r.error ? <p className="mt-1 text-xs text-red-300/80">{r.error}</p> : null}
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Events */}
          <Section icon={<ListChecks className="size-3.5" />} title={`Riwayat aktivitas (${events.length})`}>
            {events.length === 0 ? (
              <p className="text-xs text-white/35">Belum ada aktivitas.</p>
            ) : (
              <div className="space-y-1.5">
                {events.slice().reverse().map((e: KanbanEvent, i) => (
                  <EventRow key={e.id ?? i} ev={e} />
                ))}
              </div>
            )}
          </Section>

          {/* Comments */}
          <Section icon={<MessageSquare className="size-3.5" />} title={`Komentar (${comments.length})`}>
            <div className="space-y-2">
              {comments.length === 0 ? (
                <p className="text-xs text-white/35">— belum ada komentar —</p>
              ) : (
                comments.map((c: KanbanComment) => (
                  <div key={c.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                    <div className="mb-0.5 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-white/70">{c.author || "user"}</span>
                      <span className="text-[10px] text-white/30">{relativeTime(c.created_at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs text-white/75">{c.body}</p>
                  </div>
                ))
              )}
            </div>
          </Section>
        </div>

        <div className="border-t border-white/[0.06] px-5 py-3">
          {mutError && !editing ? (
            <p role="alert" className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-200">
              {mutError}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              value={comment}
              onChange={(e) => { setComment(e.target.value); if (mutError) setMutError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendComment();
                }
              }}
              rows={1}
              placeholder="Tambah komentar… (Enter untuk kirim)"
              className="max-h-24 min-h-9 flex-1 resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={sendComment}
              disabled={!comment.trim() || sending}
              className="inline-flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] transition hover:brightness-110 disabled:opacity-40"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-b border-white/[0.04] px-3 py-2 last:border-0">
      <span className="w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">{label}</span>
      <span className={cn("min-w-0 flex-1 break-words text-xs text-white/80", mono && "font-mono text-[11px] text-white/65")}>
        {value}
      </span>
    </div>
  );
}

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          {icon}
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function DepList({
  label,
  items,
  onRemove,
}: {
  label: string;
  items: KanbanTaskRef[];
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-white/35">{label}</span>
      {items.length === 0 ? (
        <span className="ml-2 text-[11px] italic text-white/30">tidak ada</span>
      ) : (
        <div className="mt-1 space-y-1">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <FolderGit2 className="size-3 shrink-0 text-white/40" />
                <span className="truncate text-xs text-white/75">{it.title}</span>
                <span className={cn("shrink-0 font-mono text-[9px] uppercase", statusMeta(it.status).text)}>{statusMeta(it.status).label}</span>
              </div>
              <button type="button" onClick={() => onRemove(it.id)} className="text-white/30 hover:text-red-300">
                <Unlink className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ ev }: { ev: KanbanEvent }) {
  const [open, setOpen] = useState(false);
  const payload = Object.fromEntries(
    Object.entries(ev).filter(([k]) => !["id", "kind", "type", "created_at", "task_id"].includes(k)),
  );
  const hasPayload = Object.keys(payload).length > 0;
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => hasPayload && setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="font-mono text-[10px] uppercase tracking-wide text-cyan-300/70">
          {String(ev.kind ?? ev.type ?? "event")}
        </span>
        <span className="text-[10px] text-white/30">{relativeTime(ev.created_at)}</span>
      </button>
      {hasPayload ? (
        open ? (
          <pre className="mt-1 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] text-white/55">
            {JSON.stringify(payload, null, 2)}
          </pre>
        ) : (
          <p className="mt-0.5 truncate text-[11px] text-white/45">{JSON.stringify(payload)}</p>
        )
      ) : null}
    </div>
  );
}
