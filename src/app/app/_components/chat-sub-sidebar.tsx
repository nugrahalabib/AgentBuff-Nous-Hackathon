"use client";

/**
 * Sub-sidebar yang muncul di sebelah kanan AppSidebarNav (sidebar utama)
 * SAAT user berada di tab /app/chat DAN sudah punya minimal satu session
 * (= sudah memulai chat dengan Command Center, atau pernah klik "Thread baru").
 *
 * Berisi: header brand + tombol "Thread baru" + list sessions dengan
 * full feature (rename inline, delete dengan konfirmasi, live indicator
 * saat streaming, last-message preview, relative time stamp).
 *
 * Kalau session list kosong DAN belum ada activity, sub-sidebar di-hide
 * supaya hero Command Center jadi focal point.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
} from "react";
import { motion } from "framer-motion";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderPlus,
  Inbox,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  SESSION_LABEL_SOFT_MAX,
  useAppStore,
  type SessionFolder,
  type SessionSummary,
} from "@/lib/app/store";
import {
  formatRelativeTime,
  agentIdFromSessionKey,
} from "@/lib/app/session-utils";
import { SessionSourceBadge } from "@/components/app/chat-source-badge";
import { CronSidebarSection } from "@/components/app/cron-sidebar-section";
import {
  AgentFace,
  AgentProfilesProvider,
  useAgentProfiles,
  useAgentProfileResolver,
} from "@/components/app/agents/agent-profile";
import { useI18n } from "@/lib/i18n/context";
import { canonAgentId } from "@/lib/app/use-working-agents";
import { cn } from "@/lib/utils";

/** Feature B — does this session belong to the filtered agent? The owning
 *  agent is read from the session KEY (folds "main" → "default") with the
 *  bridge `agentId` as fallback, then canonicalized so the comparison against
 *  the rail's canonical filter id ("default" for the house agent) is a plain
 *  equality. */
function matchesAgentFilter(s: SessionSummary, filter: string): boolean {
  return canonAgentId(agentIdFromSessionKey(s.key) ?? s.agentId) === filter;
}

export function ChatSubSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { byId: resolveAgent } = useAgentProfiles();
  const sessions = useAppStore((s) => s.sessions);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded);
  const sessionsError = useAppStore((s) => s.sessionsError);
  const status = useAppStore((s) => s.status);
  const createSession = useAppStore((s) => s.createSession);
  const setActive = useAppStore((s) => s.setActiveSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  // Feature B — agent session filter (toggled by clicking an agent card in the
  // right rail). Non-destructive view filter layered over `sessions`.
  const agentFilter = useAppStore((s) => s.activeAgentFilter);
  const setAgentFilter = useAppStore((s) => s.setAgentFilter);
  // Folder feature state — added 2026-05-26
  const folders = useAppStore((s) => s.folders);
  const sessionFolders = useAppStore((s) => s.sessionFolders);
  const createFolder = useAppStore((s) => s.createFolder);
  const updateFolder = useAppStore((s) => s.updateFolder);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const assignSessionToFolder = useAppStore(
    (s) => s.assignSessionToFolder,
  );

  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // H6 — bulk select state. `null` = select mode off; Set = selected keys.
  const [bulkSelected, setBulkSelected] = useState<Set<string> | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Folder UI state
  const UNFOLDERED_KEY = "__unfoldered__";
  const EXPANDED_FOLDERS_KEY = "agentbuff:app:expanded-folders";
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Confirmation modal state for folder deletion. Holds the folder being
  // confirmed; closing the modal clears this. Inline two-click delete was
  // broken because the menu closed on first click, losing the second click
  // target — modal pattern keeps confirm action visible until decision.
  const [folderDeleteConfirm, setFolderDeleteConfirm] =
    useState<SessionFolder | null>(null);
  const [folderDeleting, setFolderDeleting] = useState(false);
  const [draggedSession, setDraggedSession] = useState<string | null>(null);
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null);
  // SSR-safe: server renders default, client hydrates from localStorage
  // post-mount via useEffect (avoid hydration mismatch on collapsed icons).
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set([UNFOLDERED_KEY]),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(EXPANDED_FOLDERS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      const restored = new Set(
        arr.filter((x): x is string => typeof x === "string"),
      );
      // "Tanpa folder" is ALWAYS open on load (chief 2026-06-11: "biarin
      // kebuka aja") — force it into the restored set so no persisted state
      // (including stale values from older builds) can start it collapsed.
      // It stays manually collapsible for the rest of the visit.
      restored.add(UNFOLDERED_KEY);
      setExpandedFolders(restored);
    } catch {
      /* read failure — keep default */
    }
    // UNFOLDERED_KEY is a render-scoped constant; hydration runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const persistExpanded = useCallback((next: Set<string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        EXPANDED_FOLDERS_KEY,
        JSON.stringify(Array.from(next)),
      );
    } catch {
      /* best-effort */
    }
  }, []);
  const toggleFolderExpand = useCallback(
    (id: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persistExpanded(next);
        return next;
      });
    },
    [persistExpanded],
  );

  const disabled = status !== "ready";

  const isBulkMode = bulkSelected !== null;
  const bulkCount = bulkSelected?.size ?? 0;

  const toggleBulkSelect = useCallback((key: string) => {
    setBulkSelected((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exitBulkMode = useCallback(() => {
    setBulkSelected(null);
    setBulkConfirm(false);
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (!bulkSelected || bulkSelected.size === 0) return;
    setBulkBusy(true);
    try {
      // Serialize so we don't fire 50 simultaneous WS RPCs. The
      // bridge handles delete sequentially anyway.
      for (const key of Array.from(bulkSelected)) {
        await deleteSession(key);
      }
    } finally {
      setBulkBusy(false);
      setBulkConfirm(false);
      setBulkSelected(null);
    }
  }, [bulkSelected, deleteSession]);

  const handleNewThread = useCallback(async () => {
    if (disabled || creating) return;
    setCreating(true);
    try {
      await createSession();
    } finally {
      setCreating(false);
    }
  }, [disabled, creating, createSession]);

  const handleDelete = useCallback(
    async (e: MouseEvent<HTMLButtonElement>, key: string) => {
      e.stopPropagation();
      if (pendingDelete === key) {
        setPendingDelete(null);
        await deleteSession(key);
        return;
      }
      setPendingDelete(key);
      window.setTimeout(() => {
        setPendingDelete((k) => (k === key ? null : k));
      }, 4000);
    },
    [pendingDelete, deleteSession],
  );

  const handleCancelDelete = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setPendingDelete(null);
    },
    [],
  );

  const handleStartRename = useCallback(
    (e: MouseEvent<HTMLButtonElement>, key: string) => {
      e.stopPropagation();
      setPendingDelete(null);
      setRenamingKey(key);
    },
    [],
  );

  const handleCancelRename = useCallback(() => {
    setRenamingKey(null);
  }, []);

  const handleCommitRename = useCallback(
    async (key: string, nextLabel: string) => {
      setRenamingKey(null);
      await renameSession(key, nextLabel);
    },
    [renameSession],
  );

  const handleSelect = useCallback(
    async (key: string) => {
      await setActive(key);
    },
    [setActive],
  );

  // Newest-first ordering; no cap — matches legacy sidebar semantics.
  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      ),
    [sessions],
  );

  // Group sessions by folder (after ordering)
  const { byFolder, unfoldered, visibleCount } = useMemo(() => {
    const byF: Record<string, SessionSummary[]> = {};
    const un: SessionSummary[] = [];
    let count = 0;
    for (const session of ordered) {
      // Feature B: when a filter is active, drop sessions that don't belong to
      // the selected agent (non-destructive — `sessions` itself is untouched).
      if (agentFilter && !matchesAgentFilter(session, agentFilter)) continue;
      count++;
      const fid = sessionFolders[session.key];
      if (fid && folders.some((f) => f.id === fid)) {
        if (!byF[fid]) byF[fid] = [];
        byF[fid].push(session);
      } else {
        un.push(session);
      }
    }
    return { byFolder: byF, unfoldered: un, visibleCount: count };
  }, [ordered, sessionFolders, folders, agentFilter]);

  // Auto-expand folder containing active session
  useEffect(() => {
    const fid = sessionFolders[activeKey];
    if (fid && !expandedFolders.has(fid)) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(fid);
        persistExpanded(next);
        return next;
      });
    }
  }, [activeKey, sessionFolders, expandedFolders, persistExpanded]);

  const handleCreateFolder = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setCreatingFolder(true);
      try {
        const f = await createFolder({ name: trimmed });
        if (f) {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            next.add(f.id);
            persistExpanded(next);
            return next;
          });
          setShowNewFolder(false);
        }
      } finally {
        setCreatingFolder(false);
      }
    },
    [createFolder, persistExpanded],
  );

  // Open the confirmation modal. Actual deletion happens inside the modal's
  // confirm handler below. Caller passes the FULL folder object so the modal
  // can show its name + assigned session count.
  const requestDeleteFolder = useCallback(
    (folder: SessionFolder) => {
      setFolderDeleteConfirm(folder);
    },
    [],
  );

  const handleConfirmDeleteFolder = useCallback(async () => {
    if (!folderDeleteConfirm) return;
    setFolderDeleting(true);
    try {
      await deleteFolder(folderDeleteConfirm.id);
      setFolderDeleteConfirm(null);
    } finally {
      setFolderDeleting(false);
    }
  }, [folderDeleteConfirm, deleteFolder]);

  const handleDragStart = useCallback(
    (e: ReactDragEvent<HTMLLIElement>, sessionKey: string) => {
      setDraggedSession(sessionKey);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sessionKey);
    },
    [],
  );
  const handleDragEnd = useCallback(() => {
    setDraggedSession(null);
    setDropTargetFolder(null);
  }, []);
  const handleDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);
  const handleDrop = useCallback(
    async (e: ReactDragEvent<HTMLDivElement>, targetFolderId: string | null) => {
      e.preventDefault();
      const key = e.dataTransfer.getData("text/plain");
      setDraggedSession(null);
      setDropTargetFolder(null);
      if (!key) return;
      const current = sessionFolders[key] ?? null;
      if (current === targetFolderId) return;
      await assignSessionToFolder(key, targetFolderId);
    },
    [sessionFolders, assignSessionToFolder],
  );

  return (
    <AgentProfilesProvider resolve={resolveAgent}>
    <aside
      style={{ width: collapsed ? 72 : 288 }}
      className="relative flex h-full shrink-0 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0E14]/45 backdrop-blur-xl transition-[width] duration-200 ease-out"
    >
      {collapsed ? (
        <CollapsedRail
          ordered={ordered}
          activeKey={activeKey}
          disabled={disabled}
          creating={creating}
          onCreate={handleNewThread}
          onSelect={handleSelect}
          onToggle={onToggle}
        />
      ) : (
        <>
          {/* Header — "Sesi" eyebrow + counter pill + minimize toggle,
              lalu tombol "Thread baru" yang generous padding mirip pattern
              ChatSidebar. */}
          <div className="shrink-0 border-b border-white/[0.06] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/40">
                  {t.app.chat.sidebar.sessionsEyebrow}
                </p>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/55">
                  {ordered.length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {ordered.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setBulkSelected(isBulkMode ? null : new Set())
                    }
                    aria-label={
                      isBulkMode
                        ? t.app.chat.sidebar.bulkSelectExit
                        : t.app.chat.sidebar.bulkSelectEnter
                    }
                    title={
                      isBulkMode
                        ? t.app.chat.sidebar.bulkSelectExit
                        : t.app.chat.sidebar.bulkSelectEnter
                    }
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md border transition",
                      isBulkMode
                        ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-200"
                        : "border-white/10 bg-white/[0.03] text-white/55 hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300",
                    )}
                  >
                    {isBulkMode ? (
                      <X className="size-3.5" />
                    ) : (
                      <CheckSquare className="size-3.5" />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label={t.app.chat.sidebar.minimize}
                  title={t.app.chat.sidebar.minimize}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
                >
                  <ChevronsLeft className="size-3.5" />
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleNewThread()}
              disabled={disabled || creating}
              className={cn(
                "group relative flex w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all",
                disabled || creating
                  ? "cursor-not-allowed border-white/10 bg-white/[0.02] text-white/40"
                  : "border-white/10 bg-white/[0.04] text-white hover:border-cyan-400/40 hover:bg-white/[0.08]",
              )}
              aria-label={t.app.chat.sidebar.newThread}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-md transition-shadow",
                  disabled || creating
                    ? "bg-white/10 text-white/40"
                    : "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] group-hover:shadow-[0_0_12px_rgba(99,102,241,0.7)]",
                )}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
                )}
              </span>
              <span>{t.app.chat.sidebar.newThread}</span>
            </button>
          </div>

          {/* Body — scrollable list */}
          <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-2">
            {isBulkMode ? (
              <BulkActionBar
                count={bulkCount}
                total={ordered.length}
                busy={bulkBusy}
                confirming={bulkConfirm}
                onSelectAll={() =>
                  setBulkSelected(new Set(ordered.map((s) => s.key)))
                }
                onClear={() => setBulkSelected(new Set())}
                onAskDelete={() => setBulkConfirm(true)}
                onCancelConfirm={() => setBulkConfirm(false)}
                onConfirm={() => void handleBulkDelete()}
                onExit={exitBulkMode}
              />
            ) : null}
            {agentFilter ? (
              <div className="mx-1 mb-2 flex items-center justify-between gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] px-2.5 py-1.5">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-cyan-100/90">
                  <span className="size-1.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.7)]" />
                  <span className="truncate">
                    {t.app.chat.sidebar.filterScope}{" "}
                    <b className="font-semibold text-white">
                      {resolveAgent(agentFilter).name}
                    </b>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setAgentFilter(null)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-white/60 transition hover:border-cyan-400/40 hover:text-white"
                  aria-label={t.app.chat.sidebar.filterClear}
                >
                  <X className="size-3" />
                  {t.app.chat.sidebar.filterClear}
                </button>
              </div>
            ) : null}
            {!sessionsLoaded && status !== "ready" ? (
              <SessionsSkeleton />
            ) : ordered.length === 0 ? (
              <p className="mx-1 mt-2 rounded-md border border-dashed border-white/10 bg-white/[0.02] px-2 py-3 text-center text-[11px] text-white/45">
                {t.app.chat.sidebar.emptyListHint}
              </p>
            ) : agentFilter && visibleCount === 0 ? (
              <p className="mx-1 mt-2 rounded-md border border-dashed border-cyan-400/20 bg-cyan-400/[0.03] px-2 py-3 text-center text-[11px] text-white/55">
                {t.app.chat.sidebar.filterEmpty}
              </p>
            ) : (
              <div className="space-y-1">
                {/* User folders — render even when empty so chief sees they
                    exist; but while a filter is active, hide folders that have
                    no matching session so the scope reads clean. */}
                {folders
                  .filter(
                    (folder) =>
                      !agentFilter || (byFolder[folder.id]?.length ?? 0) > 0,
                  )
                  .map((folder) => (
                  <FolderSection
                    key={folder.id}
                    folder={folder}
                    sessions={byFolder[folder.id] ?? []}
                    expanded={expandedFolders.has(folder.id)}
                    onToggle={() => toggleFolderExpand(folder.id)}
                    activeKey={activeKey}
                    pendingDelete={pendingDelete}
                    renamingKey={renamingKey}
                    isBulkMode={isBulkMode}
                    bulkSelected={bulkSelected}
                    folders={folders}
                    onRenameFolder={async (next) => {
                      await updateFolder(folder.id, { name: next });
                    }}
                    onDeleteFolder={() => requestDeleteFolder(folder)}
                    onMoveSessionToFolder={async (k, fid) =>
                      void assignSessionToFolder(k, fid)
                    }
                    onMoveSessionToNone={async (k) =>
                      void assignSessionToFolder(k, null)
                    }
                    onSessionSelect={(k) => {
                      if (isBulkMode) toggleBulkSelect(k);
                      else void handleSelect(k);
                    }}
                    onSessionDelete={(e, k) => void handleDelete(e, k)}
                    onSessionCancelDelete={handleCancelDelete}
                    onSessionStartRename={(e, k) => handleStartRename(e, k)}
                    onSessionCommitRename={(k, l) =>
                      void handleCommitRename(k, l)
                    }
                    onSessionCancelRename={handleCancelRename}
                    onDragStartSession={handleDragStart}
                    onDragEndSession={handleDragEnd}
                    onDragOver={handleDragOver}
                    onDrop={(e) => void handleDrop(e, folder.id)}
                    isDropTarget={dropTargetFolder === folder.id}
                    draggedSession={draggedSession}
                    onDragEnter={() => setDropTargetFolder(folder.id)}
                    onDragLeave={() => setDropTargetFolder(null)}
                  />
                ))}

                {/* "Tanpa folder" section — only when it has sessions, or when
                    there are no folders at all AND no filter is narrowing. */}
                {unfoldered.length > 0 ||
                (folders.length === 0 && !agentFilter) ? (
                  <FolderSection
                    folder={null}
                    sessions={unfoldered}
                    expanded={expandedFolders.has(UNFOLDERED_KEY)}
                    onToggle={() => toggleFolderExpand(UNFOLDERED_KEY)}
                    activeKey={activeKey}
                    pendingDelete={pendingDelete}
                    renamingKey={renamingKey}
                    isBulkMode={isBulkMode}
                    bulkSelected={bulkSelected}
                    folders={folders}
                    onRenameFolder={async () => undefined}
                    onDeleteFolder={() => undefined}
                    onMoveSessionToFolder={async (k, fid) =>
                      void assignSessionToFolder(k, fid)
                    }
                    onMoveSessionToNone={async () => undefined}
                    onSessionSelect={(k) => {
                      if (isBulkMode) toggleBulkSelect(k);
                      else void handleSelect(k);
                    }}
                    onSessionDelete={(e, k) => void handleDelete(e, k)}
                    onSessionCancelDelete={handleCancelDelete}
                    onSessionStartRename={(e, k) => handleStartRename(e, k)}
                    onSessionCommitRename={(k, l) =>
                      void handleCommitRename(k, l)
                    }
                    onSessionCancelRename={handleCancelRename}
                    onDragStartSession={handleDragStart}
                    onDragEndSession={handleDragEnd}
                    onDragOver={handleDragOver}
                    onDrop={(e) => void handleDrop(e, null)}
                    isDropTarget={dropTargetFolder === UNFOLDERED_KEY}
                    draggedSession={draggedSession}
                    onDragEnter={() => setDropTargetFolder(UNFOLDERED_KEY)}
                    onDragLeave={() => setDropTargetFolder(null)}
                  />
                ) : null}

                {/* Inline new-folder button + input at the bottom */}
                <div className="mt-2 px-1">
                  {showNewFolder ? (
                    <NewFolderInput
                      creating={creatingFolder}
                      onSubmit={handleCreateFolder}
                      onCancel={() => setShowNewFolder(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowNewFolder(true)}
                      className="group flex w-full items-center gap-2 rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-white/55 transition hover:border-cyan-400/30 hover:bg-cyan-400/[0.04] hover:text-white"
                    >
                      <FolderPlus className="size-3.5 text-cyan-300/85" />
                      <span>Folder baru</span>
                    </button>
                  )}
                </div>
              </div>
            )}
            {sessionsError ? (
              <p
                className="mx-1 mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200"
                role="alert"
              >
                {sessionsError}
              </p>
            ) : null}
          </div>
        </>
      )}

      {/* Folder delete confirmation modal — portal-equivalent (fixed pos,
          z-200 above everything). Mounted at sidebar root so chief sees it
          regardless of where focus is. */}
      {folderDeleteConfirm ? (
        <FolderDeleteConfirmDialog
          folder={folderDeleteConfirm}
          sessionCount={byFolder[folderDeleteConfirm.id]?.length ?? 0}
          busy={folderDeleting}
          onConfirm={() => void handleConfirmDeleteFolder()}
          onCancel={() => {
            if (!folderDeleting) setFolderDeleteConfirm(null);
          }}
        />
      ) : null}
      {/* #7 — "Tugas Terjadwal" cron glance, docked at the sidebar bottom
          (flex-col aside → shrink-0 footer below the scrollable session list).
          Self-hides when there are no jobs. */}
      <CronSidebarSection />
    </aside>
    </AgentProfilesProvider>
  );
}

/**
 * Collapsed mode rail — 72px wide (sama dengan AppSidebarNav collapsed).
 * Layout: header dengan tombol "+" gradient + tombol toggle di bawahnya,
 * separator garis tipis, lalu list session icon. Tooltip via title attr
 * biar user tetap tau judul tiap thread tanpa expand.
 */
function CollapsedRail({
  ordered,
  activeKey,
  disabled,
  creating,
  onCreate,
  onSelect,
  onToggle,
}: {
  ordered: SessionSummary[];
  activeKey: string;
  disabled: boolean;
  creating: boolean;
  onCreate: () => Promise<void>;
  onSelect: (key: string) => Promise<void>;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {/* Header — tombol "+" gradient + toggle button (sebagai pill di
          bawahnya). Padding/spacing match AppSidebarNav collapsed
          header supaya kedua sidebar align horizontal. */}
      <div className="shrink-0 border-b border-white/[0.06] px-3 pt-4 pb-2">
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={disabled || creating}
            aria-label={t.app.chat.sidebar.newThread}
            title={t.app.chat.sidebar.newThreadShortcut}
            className={cn(
              "group flex size-10 items-center justify-center rounded-lg transition-shadow",
              disabled || creating
                ? "cursor-not-allowed bg-white/[0.04] text-white/40"
                : "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] hover:shadow-[0_0_14px_rgba(99,102,241,0.7)]",
            )}
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" strokeWidth={3} />
            )}
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label={t.app.chat.sidebar.expand}
            title={t.app.chat.sidebar.expand}
            className="flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
          >
            <ChevronsRight className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Sessions list — icon-only, mirror NavLinkCollapsed sizing+styling
          supaya konsisten dengan sidebar utama. */}
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {ordered.length === 0 ? (
          <div
            className="mx-auto flex size-11 items-center justify-center rounded-lg border border-dashed border-white/10"
            title={t.app.chat.sidebar.emptyList}
            aria-hidden
          >
            <MessageSquare className="size-4 text-white/25" />
          </div>
        ) : (
          <ul className="space-y-1">
            {ordered.map((session) => (
              <CollapsedSessionItem
                key={session.key}
                session={session}
                active={session.key === activeKey}
                onSelect={() => void onSelect(session.key)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function CollapsedSessionItem({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const streaming = useAppStore((s) => s.streaming[session.key] ?? null);
  const sending = useAppStore((s) => s.sending[session.key] ?? false);
  const channelLive = useAppStore((s) =>
    session.sessionId ? s.liveSessionIds.includes(session.sessionId) : false,
  );
  const isLive = Boolean(streaming) || sending || channelLive;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        title={session.title}
        aria-label={t.app.chat.sidebar.openThread.replace("{title}", session.title)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "group relative mx-auto flex size-11 items-center justify-center rounded-lg transition",
          isLive
            ? "bg-cyan-400/[0.10] text-white shadow-[0_0_0_1px_rgba(34,211,238,0.3)]"
            : active
              ? "bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/10 text-white shadow-[0_0_0_1px_rgba(34,211,238,0.25),0_4px_18px_-6px_rgba(34,211,238,0.45)]"
              : "text-white/55 hover:bg-white/[0.04] hover:text-white/90",
        )}
      >
        {active && (
          <span
            aria-hidden
            className="absolute -left-3 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
          />
        )}
        <MessageSquare className="size-[18px]" strokeWidth={active ? 2.25 : 1.75} />
        {isLive && (
          <span className="absolute right-0.5 top-0.5 flex size-2">
            <span
              aria-hidden
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75"
            />
            <span
              aria-hidden
              className="relative inline-flex size-2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]"
            />
          </span>
        )}
      </button>
    </li>
  );
}

function SessionItem({
  session,
  active,
  pendingDelete,
  renaming,
  bulkMode = false,
  bulkSelected = false,
  onSelect,
  onDelete,
  onCancelDelete,
  onStartRename,
  onCommitRename,
  onCancelRename,
  // Optional drag-source props — when present, the <li> becomes draggable.
  // Used by FolderSection to enable drag-to-folder UX.
  draggable,
  onDragStart,
  onDragEnd,
  // Optional move-to-folder menu props — when `folderTargets` is provided
  // (even as an empty list), the 3-dot "Pindah ke folder" button renders
  // alongside the delete action. Avoids a separate <li> wrapper which
  // would cause invalid nested-li HTML.
  folderTargets,
  currentFolderId,
  onMoveToFolder,
  onMoveToNoFolder,
}: {
  session: SessionSummary;
  active: boolean;
  pendingDelete: boolean;
  renaming: boolean;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onSelect: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onCancelDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onStartRename: (e: MouseEvent<HTMLButtonElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
  draggable?: boolean;
  onDragStart?: (e: ReactDragEvent<HTMLLIElement>) => void;
  onDragEnd?: () => void;
  folderTargets?: SessionFolder[];
  currentFolderId?: string | null;
  onMoveToFolder?: (key: string, folderId: string) => Promise<void>;
  onMoveToNoFolder?: (key: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const resolveAgent = useAgentProfileResolver();
  const agentFace = resolveAgent(session.agentId);
  const streaming = useAppStore((s) => s.streaming[session.key] ?? null);
  const sending = useAppStore((s) => s.sending[session.key] ?? false);
  // Channel sessions (WhatsApp/Telegram) run in a separate process and never
  // stream to /app — the bridge `sessions.activity` watcher reports them as
  // working via their raw db id (session.sessionId).
  const channelLive = useAppStore((s) =>
    session.sessionId ? s.liveSessionIds.includes(session.sessionId) : false,
  );
  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const isLive = Boolean(streaming) || sending || channelLive;
  const time = formatRelativeTime(session.updatedAt);
  const dragHandlers = draggable
    ? {
        draggable: true as const,
        onDragStart: onDragStart,
        onDragEnd: onDragEnd,
      }
    : {};

  if (renaming) {
    return (
      <li className="group relative" {...dragHandlers}>
        <SessionRenameInput
          initial={session.title}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
          sessionKey={session.key}
        />
      </li>
    );
  }

  if (pendingDelete) {
    return (
      <li className="group relative" {...dragHandlers}>
        <motion.div
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          role="alertdialog"
          aria-labelledby={`delete-confirm-${session.key}`}
          className="relative overflow-hidden rounded-lg border border-red-500/40 bg-red-500/[0.08] px-2.5 py-2 shadow-[0_0_18px_rgba(239,68,68,0.18)] backdrop-blur-sm"
        >
          <p
            id={`delete-confirm-${session.key}`}
            className="flex items-center gap-1.5 text-[11.5px] font-semibold text-red-100"
          >
            <Trash2 className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              {t.app.chat.sidebar.deleteConfirmTitle.replace(
                "{title}",
                session.title,
              )}
            </span>
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-red-200/75">
            {t.app.chat.sidebar.deleteConfirmBody}
          </p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={onCancelDelete}
              aria-label={t.app.chat.sidebar.deleteCancelAria}
              className="rounded-md px-2 py-1 text-[10.5px] font-semibold text-white/65 transition hover:bg-white/5 hover:text-white"
            >
              {t.app.chat.sidebar.deleteCancelLabel}
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={t.app.chat.sidebar.deleteConfirmAria.replace(
                "{title}",
                session.title,
              )}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-1 text-[10.5px] font-bold text-white shadow-[0_0_12px_rgba(239,68,68,0.5)] transition hover:bg-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            >
              <Trash2 className="size-3" aria-hidden />
              {t.app.chat.sidebar.deleteConfirmLabel}
            </button>
          </div>
        </motion.div>
      </li>
    );
  }

  return (
    <li className="group relative" {...dragHandlers}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        aria-checked={bulkMode ? bulkSelected : undefined}
        role={bulkMode ? "checkbox" : undefined}
        data-working={isLive && !bulkMode ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-3 rounded-xl px-3 py-2.5 pr-14 text-left transition-all",
          bulkMode && bulkSelected
            ? "bg-cyan-400/10 text-white"
            : isLive && !bulkMode
              ? "bg-cyan-400/[0.06] text-white"
              : active && !bulkMode
                ? "bg-white/[0.05] text-white"
                : "text-white/55 hover:bg-white/[0.03] hover:text-white/90",
        )}
      >
        {bulkMode ? (
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition",
              bulkSelected
                ? "border-cyan-400 bg-cyan-400 text-[#0B0E14]"
                : "border-white/30 bg-transparent",
            )}
          >
            {bulkSelected ? <CheckSquare className="size-3" /> : null}
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "mt-1 h-5 w-[3px] shrink-0 rounded-full transition-all",
              isLive
                ? "animate-pulse bg-gradient-to-b from-cyan-300 to-fuchsia-400 shadow-[0_0_12px_rgba(34,211,238,0.85)]"
                : active
                  ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                  : "bg-transparent group-hover:bg-cyan-400/40",
            )}
          />
        )}
        {!bulkMode ? (
          <AgentFace
            profile={agentFace}
            size={24}
            className={cn(
              "mt-0.5 shrink-0",
              active ? "" : "opacity-90",
              isLive
                ? "rounded-full ring-1 ring-cyan-400/50"
                : "",
            )}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium",
                active ? "text-white" : "text-white/80",
              )}
            >
              {session.title}
            </p>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            <SessionSourceBadge
              source={session.source}
              peerLabel={session.peerLabel}
              size="sm"
              showLock
              showPeer
            />
            {isLive ? (
              <WorkingLabel
                text={t.app.chat.sidebar.workingLabel}
                title={t.app.chat.sidebar.liveSessionTitle}
              />
            ) : time ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                {time}
              </span>
            ) : null}
          </div>
        </div>
      </button>
      {!bulkMode ? (
        <div className="absolute right-2 top-2.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onStartRename}
            title={t.app.chat.sidebar.renameLabel}
            aria-label={t.app.chat.sidebar.renameSession.replace(
              "{title}",
              session.title,
            )}
            className="rounded p-1 text-white/40 transition hover:bg-cyan-400/15 hover:text-cyan-300"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title={t.app.chat.sidebar.deleteLabel}
            aria-label={t.app.chat.sidebar.deleteSession.replace(
              "{title}",
              session.title,
            )}
            className="rounded p-1 text-white/40 transition hover:bg-red-500/15 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {/* Move-to-folder button — shown only when folderTargets prop is
              provided (= rendered inside a FolderSection). The menu popover
              is rendered as a sibling inside <li> so it can overlay above
              other rows without escaping the list. */}
          {folderTargets ? (
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMoveMenu((v) => !v);
                }}
                title="Pindah ke folder"
                aria-label={`Pindah sesi ${session.title} ke folder`}
                className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white/85"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              {showMoveMenu &&
              (onMoveToFolder || onMoveToNoFolder) ? (
                <MoveToFolderMenu
                  onClose={() => setShowMoveMenu(false)}
                  currentFolderId={currentFolderId ?? null}
                  folders={folderTargets}
                  onMoveToFolder={async (fid) => {
                    setShowMoveMenu(false);
                    if (onMoveToFolder) {
                      await onMoveToFolder(session.key, fid);
                    }
                  }}
                  onMoveToNoFolder={async () => {
                    setShowMoveMenu(false);
                    if (onMoveToNoFolder) {
                      await onMoveToNoFolder(session.key);
                    }
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** "Bekerja" pill with three bouncing dots — replaces the timestamp while a
 *  session is streaming/sending so idle vs working reads at a glance. */
function WorkingLabel({ text, title }: { text: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-cyan-200"
    >
      <span className="flex items-center gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1 rounded-full bg-cyan-300 shadow-[0_0_4px_rgba(34,211,238,0.9)]"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -1.5, 0] }}
            transition={{
              duration: 0.9,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.15,
            }}
          />
        ))}
      </span>
      {text}
    </span>
  );
}

function SessionRenameInput({
  initial,
  onCommit,
  onCancel,
  sessionKey,
}: {
  initial: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
  sessionKey: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const commit = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      onCancel();
      return;
    }
    if (trimmed === initial) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }, [value, initial, onCommit, onCancel]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCancel();
  }, [onCancel]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-cyan-400/50 bg-[#0B0E14]/90 px-2 py-1.5 shadow-[0_0_18px_rgba(34,211,238,0.25)] backdrop-blur-sm"
      role="group"
      aria-label={t.app.chat.sidebar.renameSession.replace("{title}", initial)}
    >
      <label
        htmlFor={`rename-input-${sessionKey}`}
        className="mb-1 block font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-cyan-300/80"
      >
        {t.app.chat.sidebar.renameEyebrow}
      </label>
      <input
        id={`rename-input-${sessionKey}`}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) =>
          setValue(e.target.value.slice(0, SESSION_LABEL_SOFT_MAX))
        }
        onKeyDown={onKeyDown}
        onBlur={commit}
        maxLength={SESSION_LABEL_SOFT_MAX}
        placeholder={t.app.chat.sidebar.renamePlaceholder}
        className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] font-medium text-white outline-none transition placeholder:text-white/30 focus:border-cyan-400/60 focus:bg-black/60"
        aria-describedby={`rename-hint-${sessionKey}`}
      />
      <p
        id={`rename-hint-${sessionKey}`}
        className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/35"
      >
        {t.app.chat.sidebar.renameHint}
      </p>
    </div>
  );
}

function SessionsSkeleton() {
  return (
    <ul className="space-y-1" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="h-12 animate-pulse rounded-lg border border-white/5 bg-white/[0.03]"
        />
      ))}
    </ul>
  );
}

/** H6 — Floating bar shown above the session list while bulk-select mode
 *  is active. Two states: idle (Select-all + Clear + Delete N) and
 *  confirming (Cancel + Confirm Delete N). */
function BulkActionBar({
  count,
  total,
  busy,
  confirming,
  onSelectAll,
  onClear,
  onAskDelete,
  onCancelConfirm,
  onConfirm,
  onExit,
}: {
  count: number;
  total: number;
  busy: boolean;
  confirming: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onAskDelete: () => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  if (confirming) {
    return (
      <div
        role="alertdialog"
        className="mb-2 rounded-xl border border-red-500/40 bg-red-500/[0.08] p-2.5 shadow-[0_0_18px_rgba(239,68,68,0.18)] backdrop-blur-sm"
      >
        <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-red-100">
          <Trash2 className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {t.app.chat.sidebar.bulkConfirmDeleteTitle.replace(
              "{n}",
              String(count),
            )}
          </span>
        </p>
        <p className="mt-0.5 text-[10px] leading-snug text-red-200/75">
          {t.app.chat.sidebar.bulkConfirmDeleteBody}
        </p>
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancelConfirm}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[10.5px] font-semibold text-white/65 transition hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            {t.app.chat.sidebar.deleteCancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-1 text-[10.5px] font-bold text-white shadow-[0_0_12px_rgba(239,68,68,0.5)] transition hover:bg-red-400 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-3" aria-hidden />
            )}
            {t.app.chat.sidebar.bulkConfirmDeleteAction.replace(
              "{n}",
              String(count),
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2 flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.04] px-2 py-1.5">
      <span className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-cyan-200">
        {t.app.chat.sidebar.bulkSelectedCount.replace("{n}", String(count))}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={count === total ? onClear : onSelectAll}
          className="rounded p-1 text-white/55 transition hover:bg-white/5 hover:text-white"
          aria-label={
            count === total
              ? t.app.chat.sidebar.bulkClearSelection
              : t.app.chat.sidebar.bulkSelectAll
          }
          title={
            count === total
              ? t.app.chat.sidebar.bulkClearSelection
              : t.app.chat.sidebar.bulkSelectAll
          }
        >
          {count === total ? (
            <Square className="size-3.5" />
          ) : (
            <CheckSquare className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onAskDelete}
          disabled={count === 0}
          className={cn(
            "rounded p-1 transition",
            count === 0
              ? "cursor-not-allowed text-white/25"
              : "text-red-300/85 hover:bg-red-500/15 hover:text-red-200",
          )}
          aria-label={t.app.chat.sidebar.bulkDelete}
          title={t.app.chat.sidebar.bulkDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded p-1 text-white/55 transition hover:bg-white/5 hover:text-white"
          aria-label={t.app.chat.sidebar.bulkSelectExit}
          title={t.app.chat.sidebar.bulkSelectExit}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//  Folder grouping components (added 2026-05-26)
// ────────────────────────────────────────────────────────────────────────

function FolderSection({
  folder,
  sessions,
  expanded,
  onToggle,
  activeKey,
  pendingDelete,
  renamingKey,
  isBulkMode,
  bulkSelected,
  folders,
  onRenameFolder,
  onDeleteFolder,
  onMoveSessionToFolder,
  onMoveSessionToNone,
  onSessionSelect,
  onSessionDelete,
  onSessionCancelDelete,
  onSessionStartRename,
  onSessionCommitRename,
  onSessionCancelRename,
  onDragStartSession,
  onDragEndSession,
  onDragOver,
  onDrop,
  isDropTarget,
  draggedSession,
  onDragEnter,
  onDragLeave,
}: {
  folder: SessionFolder | null;
  sessions: SessionSummary[];
  expanded: boolean;
  onToggle: () => void;
  activeKey: string;
  pendingDelete: string | null;
  renamingKey: string | null;
  isBulkMode: boolean;
  bulkSelected: Set<string> | null;
  folders: SessionFolder[];
  onRenameFolder: (next: string) => Promise<void>;
  onDeleteFolder: () => void;
  onMoveSessionToFolder: (key: string, folderId: string) => Promise<void>;
  onMoveSessionToNone: (key: string) => Promise<void>;
  onSessionSelect: (key: string) => void;
  onSessionDelete: (e: MouseEvent<HTMLButtonElement>, key: string) => void;
  onSessionCancelDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onSessionStartRename: (
    e: MouseEvent<HTMLButtonElement>,
    key: string,
  ) => void;
  onSessionCommitRename: (key: string, label: string) => void;
  onSessionCancelRename: () => void;
  onDragStartSession: (
    e: ReactDragEvent<HTMLLIElement>,
    sessionKey: string,
  ) => void;
  onDragEndSession: () => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  isDropTarget: boolean;
  draggedSession: string | null;
  onDragEnter: () => void;
  onDragLeave: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const isUnfoldered = folder === null;
  const label = isUnfoldered ? "Tanpa folder" : folder.name;
  const emoji = isUnfoldered ? null : folder.emoji ?? "📁";
  const count = sessions.length;

  return (
    <section
      className={cn(
        "rounded-lg border transition-colors",
        isDropTarget && draggedSession
          ? "border-cyan-400/50 bg-cyan-400/[0.05] shadow-[0_0_0_2px_rgba(34,211,238,0.18)]"
          : "border-transparent",
      )}
      onDragOver={onDragOver}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragLeave={(e) => {
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) onDragLeave();
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="group flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.04]"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0 text-white/50" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-white/50" />
          )}
          {emoji ? (
            <span aria-hidden className="text-[13px] leading-none">
              {emoji}
            </span>
          ) : (
            <Inbox className="size-3 shrink-0 text-white/35" />
          )}
          {renaming && folder ? (
            <FolderRenameInput
              initial={folder.name}
              onSubmit={async (next) => {
                if (next && next !== folder.name) {
                  await onRenameFolder(next);
                }
                setRenaming(false);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span className="truncate text-[12px] font-semibold text-white/80">
              {label}
            </span>
          )}
          {count > 0 ? (
            <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 py-0 font-mono text-[9.5px] tabular-nums text-white/55">
              {count}
            </span>
          ) : null}
        </button>
        {!isUnfoldered && folder && !renaming ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              className="rounded p-1 text-white/40 transition hover:bg-white/[0.06] hover:text-white/85"
              aria-label="Aksi folder"
            >
              <MoreVertical className="size-3" />
            </button>
            {showMenu ? (
              <FolderMenu
                onClose={() => setShowMenu(false)}
                onRename={() => {
                  setRenaming(true);
                  setShowMenu(false);
                }}
                onDelete={() => {
                  setShowMenu(false);
                  onDeleteFolder();
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {expanded ? (
        sessions.length === 0 ? (
          <p
            className={cn(
              "mx-1.5 mb-1.5 rounded-md border border-dashed border-white/8 px-3 py-2 text-center text-[10.5px] text-white/35",
              draggedSession ? "border-cyan-400/30 text-cyan-200/70" : "",
            )}
          >
            {draggedSession ? "Drop di sini" : "Kosong"}
          </p>
        ) : (
          <ul className="space-y-0.5 px-1 pb-1.5">
            {sessions.map((session) => (
              <SessionItem
                key={session.key}
                session={session}
                active={session.key === activeKey}
                pendingDelete={pendingDelete === session.key}
                renaming={renamingKey === session.key}
                bulkMode={isBulkMode}
                bulkSelected={bulkSelected?.has(session.key) ?? false}
                onSelect={() => onSessionSelect(session.key)}
                onDelete={(e) => onSessionDelete(e, session.key)}
                onCancelDelete={onSessionCancelDelete}
                onStartRename={(e) => onSessionStartRename(e, session.key)}
                onCommitRename={(label) =>
                  onSessionCommitRename(session.key, label)
                }
                onCancelRename={onSessionCancelRename}
                // Drag-source props — make this row draggable
                draggable
                onDragStart={(e) => onDragStartSession(e, session.key)}
                onDragEnd={onDragEndSession}
                // Move-to-folder menu props — surfaces the 3-dot menu
                folderTargets={folders.filter((f) => f.id !== folder?.id)}
                currentFolderId={folder?.id ?? null}
                onMoveToFolder={onMoveSessionToFolder}
                onMoveToNoFolder={onMoveSessionToNone}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

// SessionItemDraggable removed 2026-05-26 — its wrapping <li> caused
// invalid HTML (nested li). Drag-source + move-to-folder menu props are
// now optional on SessionItem itself, applied to its existing <li>.

function FolderMenu({
  onClose,
  onRename,
  onDelete,
}: {
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-1 w-[160px] overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14]/95 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      role="menu"
    >
      <button
        type="button"
        onClick={onRename}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-white/85 hover:bg-white/[0.05]"
      >
        <Pencil className="size-3 text-cyan-300/85" />
        Ganti nama
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-white/85 hover:bg-red-500/15 hover:text-red-200"
      >
        <Trash2 className="size-3" />
        Hapus folder
      </button>
    </div>
  );
}

// ── Folder delete confirmation modal ─────────────────────────────────────
// Centered dialog that asks chief to confirm folder deletion. Shows the
// folder name + warning that sessions inside become "Tanpa folder" (NOT
// deleted). Esc closes; backdrop click closes; Enter confirms.
function FolderDeleteConfirmDialog({
  folder,
  sessionCount,
  busy,
  onConfirm,
  onCancel,
}: {
  folder: SessionFolder;
  sessionCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc handler
  useEffect(() => {
    function handler(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
      if (e.key === "Enter" && !busy) onConfirm();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel, onConfirm]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.8)]"
      >
        <div className="border-b border-red-500/20 bg-gradient-to-br from-red-500/[0.08] via-rose-500/[0.04] to-transparent px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10">
              <Trash2 className="size-4 text-red-300" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id="folder-delete-title"
                className="font-display text-base font-bold text-white"
              >
                Hapus folder &quot;{folder.name}&quot;?
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-white/70">
                Folder akan dihapus permanen. Sesi-sesi di dalamnya{" "}
                <span className="font-semibold text-cyan-200">
                  tidak ikut dihapus
                </span>{" "}
                — mereka pindah ke &quot;Tanpa folder&quot;.
              </p>
            </div>
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/65">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              Dampak
            </span>
            <p className="mt-1">
              {sessionCount > 0 ? (
                <>
                  <span className="font-bold text-amber-200">
                    {sessionCount}
                  </span>{" "}
                  sesi akan jadi &quot;Tanpa folder&quot;
                </>
              ) : (
                "Folder ini kosong — aman dihapus."
              )}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-white/[0.04] bg-white/[0.02] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-1.5 text-[12px] font-semibold text-white/75 transition hover:border-white/20 hover:text-white disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-red-500 to-rose-500 px-4 py-1.5 text-[12px] font-bold text-white shadow-[0_8px_20px_-6px_rgba(239,68,68,0.55)] transition hover:brightness-110 disabled:opacity-50"
            autoFocus
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-3.5" aria-hidden />
            )}
            Hapus folder
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function FolderRenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
      className="flex-1"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={80}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setValue(e.target.value)
        }
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onSubmit(value.trim())}
        className="w-full rounded border border-cyan-400/50 bg-black/40 px-1.5 py-0.5 text-[12px] font-semibold text-white focus:outline-none focus:ring-1 focus:ring-cyan-400/40"
      />
    </form>
  );
}

function NewFolderInput({
  creating,
  onSubmit,
  onCancel,
}: {
  creating: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className="flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.05] px-2 py-1.5"
    >
      <FolderPlus className="size-3.5 shrink-0 text-cyan-300/85" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setValue(e.target.value)
        }
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        maxLength={80}
        placeholder="Nama folder…"
        disabled={creating}
        className="flex-1 bg-transparent text-[12px] text-white/90 placeholder:text-white/40 focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={creating || !value.trim()}
        className="rounded p-1 text-cyan-300/85 hover:bg-cyan-400/15 disabled:opacity-30"
        aria-label="Buat folder"
      >
        {creating ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Plus className="size-3" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={creating}
        className="rounded p-1 text-white/40 hover:bg-white/[0.05] hover:text-white/85 disabled:opacity-30"
        aria-label="Batal"
      >
        <X className="size-3" />
      </button>
    </form>
  );
}

function MoveToFolderMenu({
  onClose,
  currentFolderId,
  folders,
  onMoveToFolder,
  onMoveToNoFolder,
}: {
  onClose: () => void;
  currentFolderId: string | null;
  folders: SessionFolder[];
  onMoveToFolder: (folderId: string) => void;
  onMoveToNoFolder: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-1 w-[200px] overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14]/95 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      role="menu"
    >
      <p className="border-b border-white/[0.06] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
        Pindah ke
      </p>
      <ul className="max-h-[200px] overflow-y-auto">
        {currentFolderId !== null ? (
          <li>
            <button
              type="button"
              onClick={onMoveToNoFolder}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-white/85 hover:bg-white/[0.05]"
            >
              <Inbox className="size-3 text-white/40" />
              Tanpa folder
            </button>
          </li>
        ) : null}
        {folders.length === 0 && currentFolderId === null ? (
          <li>
            <p className="px-3 py-2 text-[10.5px] text-white/35">
              Belum ada folder. Buat folder dulu di footer sidebar.
            </p>
          </li>
        ) : (
          folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onMoveToFolder(f.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-white/85 hover:bg-white/[0.05]"
              >
                <span aria-hidden className="text-[12px] leading-none">
                  {f.emoji ?? "📁"}
                </span>
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
