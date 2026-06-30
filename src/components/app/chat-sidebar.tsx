"use client";

/**
 * ChatSidebar v2 — sessions grouped by user-defined folders.
 *
 * Layout:
 *   ┌─ Header ─────────────────────────────┐
 *   │ Sesi · [+ Thread baru]               │
 *   ├──────────────────────────────────────┤
 *   │ 📚 Project X · 5 · [⋮]               │  folder header (collapsible)
 *   │   • Session 1                         │  session row
 *   │   • Session 2                         │
 *   │ 🌏 Belajar Bahasa · 3 · [⋮]          │
 *   │ 📂 Tanpa folder · 12                 │  default group for unassigned
 *   │   • Session N                         │
 *   ├──────────────────────────────────────┤
 *   │ [+ Folder baru]                       │
 *   └──────────────────────────────────────┘
 *
 * Folder semantics:
 *  - One session can belong to AT MOST one folder (single-assign, simpler
 *    than tagging; aligns with mass-market mental model)
 *  - Folder list dynamic — empty state when no folders exist yet
 *  - Folders without sessions still render (chief baru bikin folder, belum
 *    isi → tetap visible so chief tahu folder ada)
 *  - Empty "Tanpa folder" hidden (no point showing 0)
 *
 * Drag-drop (HTML5 native):
 *  - Drag session row → drop on folder header to assign
 *  - Drop on "Tanpa folder" header to unassign
 *  - Visual feedback: cyan glow on hover target during drag
 *
 * Expand/collapse state persisted to localStorage so chief's preferred
 * "which folders open" survives page reload.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Inbox,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  useAppStore,
  type SessionFolder,
  type SessionSummary,
} from "@/lib/app/store";
import { formatRelativeTime } from "@/lib/app/session-utils";
import { SessionSourceBadge } from "@/components/app/chat-source-badge";
import { useAgentsList } from "@/components/app/agents/use-agents-data";
import {
  getAgentDisplayName,
  getAgentEmoji,
} from "@/components/app/agents/helpers";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const EXPANDED_FOLDERS_KEY = "agentbuff:app:expanded-folders";
const UNFOLDERED_KEY = "__unfoldered__"; // sentinel for "Tanpa folder" group

export function ChatSidebar() {
  const { t } = useI18n();
  const sessions = useAppStore((s) => s.sessions);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded);
  const sessionsError = useAppStore((s) => s.sessionsError);
  const status = useAppStore((s) => s.status);
  const folders = useAppStore((s) => s.folders);
  const sessionFolders = useAppStore((s) => s.sessionFolders);
  const foldersLoaded = useAppStore((s) => s.foldersLoaded);
  const createSession = useAppStore((s) => s.createSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const setActive = useAppStore((s) => s.setActiveSession);
  const createFolder = useAppStore((s) => s.createFolder);
  const updateFolder = useAppStore((s) => s.updateFolder);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const assignSessionToFolder = useAppStore(
    (s) => s.assignSessionToFolder,
  );

  const [creating, setCreating] = useState(false);

  // P0#2: agent picker for "Thread baru" — each new thread is bound to the
  // chosen agent (its persona + model apply per-session via the bridge).
  const agentsQuery = useAgentsList();
  const agentList = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data],
  );
  const agentsDefaultId = agentsQuery.data?.defaultId ?? "";
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocPointer = (e: globalThis.MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onEsc);
    };
  }, [pickerOpen]);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<string | null>(
    null,
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [draggedSession, setDraggedSession] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Per-folder expand state, persisted across reloads.
  // SSR-safe: default on server, hydrate post-mount via useEffect.
  const [expanded, setExpanded] = useState<Set<string>>(
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
      if (restored.size > 0) setExpanded(restored);
    } catch {
      /* read failure — keep default */
    }
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

  const toggleFolder = useCallback(
    (folderId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(folderId)) next.delete(folderId);
        else next.add(folderId);
        persistExpanded(next);
        return next;
      });
    },
    [persistExpanded],
  );

  // Auto-expand newly-created folders so chief sees them open.
  // Also auto-expand the folder containing the active session so the cursor
  // stays visible.
  useEffect(() => {
    if (!foldersLoaded) return;
    const activeFolderId = sessionFolders[activeKey];
    if (activeFolderId && !expanded.has(activeFolderId)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(activeFolderId);
        persistExpanded(next);
        return next;
      });
    }
  }, [activeKey, sessionFolders, foldersLoaded, expanded, persistExpanded]);

  // Group sessions by folder
  const { byFolder, unfoldered } = useMemo(() => {
    const byF: Record<string, SessionSummary[]> = {};
    const un: SessionSummary[] = [];
    for (const session of sessions) {
      const fid = sessionFolders[session.key];
      if (fid && folders.some((f) => f.id === fid)) {
        if (!byF[fid]) byF[fid] = [];
        byF[fid].push(session);
      } else {
        un.push(session);
      }
    }
    return { byFolder: byF, unfoldered: un };
  }, [sessions, sessionFolders, folders]);

  const handleNew = useCallback(
    async (agentIdOverride?: string) => {
      if (status !== "ready" || creating) return;
      setPickerOpen(false);
      setCreating(true);
      try {
        await createSession(undefined, agentIdOverride);
      } finally {
        setCreating(false);
      }
    },
    [status, creating, createSession],
  );

  // "Thread baru" click: >1 agent → open picker; otherwise create straight
  // away with the only agent (or the global default when none exist yet).
  const onNewThreadClick = useCallback(() => {
    if (status !== "ready" || creating) return;
    if (agentList.length > 1) {
      setPickerOpen((v) => !v);
    } else {
      void handleNew(agentList[0]?.id);
    }
  }, [status, creating, agentList, handleNew]);

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
      }, 3000);
    },
    [pendingDelete, deleteSession],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setCreatingFolder(true);
      try {
        const folder = await createFolder({ name: trimmed });
        if (folder) {
          // Auto-expand the new folder
          setExpanded((prev) => {
            const next = new Set(prev);
            next.add(folder.id);
            persistExpanded(next);
            return next;
          });
          setShowNewFolderInput(false);
        }
      } finally {
        setCreatingFolder(false);
      }
    },
    [createFolder, persistExpanded],
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      if (pendingFolderDelete !== folderId) {
        setPendingFolderDelete(folderId);
        window.setTimeout(() => {
          setPendingFolderDelete((k) => (k === folderId ? null : k));
        }, 3000);
        return;
      }
      setPendingFolderDelete(null);
      await deleteFolder(folderId);
    },
    [pendingFolderDelete, deleteFolder],
  );

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLLIElement>, sessionKey: string) => {
      setDraggedSession(sessionKey);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sessionKey);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedSession(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDragEnter = useCallback((targetId: string) => {
    setDropTarget(targetId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>, folderId: string | null) => {
      e.preventDefault();
      const sessionKey = e.dataTransfer.getData("text/plain");
      setDraggedSession(null);
      setDropTarget(null);
      if (!sessionKey) return;
      // No-op if dropping in same folder
      const current = sessionFolders[sessionKey] ?? null;
      if (current === folderId) return;
      await assignSessionToFolder(sessionKey, folderId);
    },
    [sessionFolders, assignSessionToFolder],
  );

  const showFolders = folders.length > 0 || unfoldered.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-white/[0.06] p-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-white/40">
          {t.app.chat.sidebar2.sessionsEyebrow}
        </p>
        <div ref={pickerRef} className="relative">
          <button
            type="button"
            onClick={onNewThreadClick}
            disabled={status !== "ready" || creating}
            className={cn(
              "group relative flex w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all",
              status !== "ready" || creating
                ? "cursor-not-allowed border-white/10 bg-white/[0.02] text-white/40"
                : "border-white/10 bg-white/[0.04] text-white hover:border-cyan-400/40 hover:bg-white/[0.08]",
            )}
            aria-label={t.app.chat.sidebar2.newThread}
            aria-haspopup={agentList.length > 1 ? "menu" : undefined}
            aria-expanded={agentList.length > 1 ? pickerOpen : undefined}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md transition-shadow",
                status !== "ready" || creating
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
            <span>{t.app.chat.sidebar2.newThread}</span>
            {agentList.length > 1 ? (
              <ChevronDown
                className={cn(
                  "ml-auto h-3.5 w-3.5 text-white/50 transition-transform",
                  pickerOpen && "rotate-180",
                )}
              />
            ) : null}
          </button>

          {pickerOpen && agentList.length > 1 ? (
            <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl">
              <p className="px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                {t.app.chat.sidebar2.chatWithAgent}
              </p>
              <div className="max-h-72 overflow-y-auto">
                {agentList.map((a) => {
                  const isDefault = a.id === agentsDefaultId;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => void handleNew(a.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-white/85 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      <span className="text-base leading-none">
                        {getAgentEmoji(a) || "🤖"}
                      </span>
                      <span className="truncate">{getAgentDisplayName(a)}</span>
                      {isDefault ? (
                        <span className="ml-auto shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-cyan-200/80">
                          {t.app.chat.sidebar2.defaultBadge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <nav
        className="scrollbar-slim flex-1 overflow-y-auto p-2"
        aria-label={t.app.chat.sidebar2.sessionListAria}
      >
        {!sessionsLoaded && status !== "ready" ? (
          <SidebarSkeleton />
        ) : sessions.length === 0 ? (
          <EmptySessions />
        ) : (
          <div className="space-y-2">
            {/* User-defined folders (always show, even when empty) */}
            {folders.map((folder) => (
              <FolderGroup
                key={folder.id}
                folder={folder}
                sessions={byFolder[folder.id] ?? []}
                expanded={expanded.has(folder.id)}
                onToggle={() => toggleFolder(folder.id)}
                activeKey={activeKey}
                pendingDelete={pendingDelete}
                pendingFolderDelete={pendingFolderDelete === folder.id}
                onSelectSession={(k) => void setActive(k)}
                onDeleteSession={(e, k) => void handleDelete(e, k)}
                onRenameFolder={async (next) => {
                  await updateFolder(folder.id, { name: next });
                }}
                onDeleteFolder={() => void handleDeleteFolder(folder.id)}
                onDropSession={(e) => void handleDrop(e, folder.id)}
                onDragOver={handleDragOver}
                onDragEnter={() => handleDragEnter(folder.id)}
                onDragLeave={handleDragLeave}
                onMoveSessionToNoFolder={async (k) => {
                  await assignSessionToFolder(k, null);
                }}
                onMoveSessionToFolder={async (k, fid) => {
                  await assignSessionToFolder(k, fid);
                }}
                otherFolders={folders.filter((f) => f.id !== folder.id)}
                draggedSession={draggedSession}
                isDropTarget={dropTarget === folder.id}
                onDragStartSession={handleDragStart}
                onDragEndSession={handleDragEnd}
              />
            ))}

            {/* "Tanpa folder" group — only show if has sessions OR no folders yet */}
            {unfoldered.length > 0 || folders.length === 0 ? (
              <FolderGroup
                folder={null}
                sessions={unfoldered}
                expanded={expanded.has(UNFOLDERED_KEY)}
                onToggle={() => toggleFolder(UNFOLDERED_KEY)}
                activeKey={activeKey}
                pendingDelete={pendingDelete}
                pendingFolderDelete={false}
                onSelectSession={(k) => void setActive(k)}
                onDeleteSession={(e, k) => void handleDelete(e, k)}
                onRenameFolder={async () => undefined}
                onDeleteFolder={() => undefined}
                onDropSession={(e) => void handleDrop(e, null)}
                onDragOver={handleDragOver}
                onDragEnter={() => handleDragEnter(UNFOLDERED_KEY)}
                onDragLeave={handleDragLeave}
                onMoveSessionToNoFolder={async () => undefined}
                onMoveSessionToFolder={async (k, fid) => {
                  await assignSessionToFolder(k, fid);
                }}
                otherFolders={folders}
                draggedSession={draggedSession}
                isDropTarget={dropTarget === UNFOLDERED_KEY}
                onDragStartSession={handleDragStart}
                onDragEndSession={handleDragEnd}
              />
            ) : null}
          </div>
        )}
        {sessionsError ? (
          <p
            className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200"
            role="alert"
          >
            {sessionsError}
          </p>
        ) : null}
      </nav>

      {/* Footer: + Folder baru */}
      {showFolders ? (
        <div className="shrink-0 border-t border-white/[0.06] p-2">
          {showNewFolderInput ? (
            <NewFolderInput
              creating={creatingFolder}
              onSubmit={handleCreateFolder}
              onCancel={() => setShowNewFolderInput(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowNewFolderInput(true)}
              className="group flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px] font-medium text-white/65 transition hover:border-cyan-400/30 hover:bg-cyan-400/[0.05] hover:text-white"
            >
              <FolderPlus className="h-3.5 w-3.5 text-cyan-300/85" />
              <span>{t.app.chat.sidebar2.newFolder}</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── FolderGroup ──────────────────────────────────────────────────────────

function FolderGroup({
  folder,
  sessions,
  expanded,
  onToggle,
  activeKey,
  pendingDelete,
  pendingFolderDelete,
  onSelectSession,
  onDeleteSession,
  onRenameFolder,
  onDeleteFolder,
  onDropSession,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onMoveSessionToNoFolder,
  onMoveSessionToFolder,
  otherFolders,
  draggedSession,
  isDropTarget,
  onDragStartSession,
  onDragEndSession,
}: {
  folder: SessionFolder | null;
  sessions: SessionSummary[];
  expanded: boolean;
  onToggle: () => void;
  activeKey: string;
  pendingDelete: string | null;
  pendingFolderDelete: boolean;
  onSelectSession: (key: string) => void;
  onDeleteSession: (e: MouseEvent<HTMLButtonElement>, key: string) => void;
  onRenameFolder: (next: string) => Promise<void>;
  onDeleteFolder: () => void;
  onDropSession: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onMoveSessionToNoFolder: (key: string) => Promise<void>;
  onMoveSessionToFolder: (key: string, folderId: string) => Promise<void>;
  otherFolders: SessionFolder[];
  draggedSession: string | null;
  isDropTarget: boolean;
  onDragStartSession: (
    e: DragEvent<HTMLLIElement>,
    sessionKey: string,
  ) => void;
  onDragEndSession: () => void;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const isUnfoldered = folder === null;
  const label = isUnfoldered ? t.app.chat.sidebar2.unfoldered : folder.name;
  const emoji = isUnfoldered ? null : folder.emoji ?? "📁";
  const count = sessions.length;

  return (
    <section
      className={cn(
        "rounded-lg border transition-colors",
        isDropTarget && draggedSession
          ? "border-cyan-400/50 bg-cyan-400/[0.06] shadow-[0_0_0_2px_rgba(34,211,238,0.2)]"
          : "border-transparent",
      )}
      onDragOver={onDragOver}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragLeave={(e) => {
        // Only fire when leaving the WHOLE section, not when entering child
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) {
          onDragLeave();
        }
      }}
      onDrop={onDropSession}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="group flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.04]"
          aria-expanded={expanded}
          aria-label={`${t.app.chat.sidebar2.toggleFolderPrefix} ${label}`}
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

        {/* Folder action menu (only on user-defined folders) */}
        {!isUnfoldered && folder && !renaming ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              className="rounded p-1 text-white/40 transition hover:bg-white/[0.06] hover:text-white/85"
              aria-label={t.app.chat.sidebar2.folderActions}
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
                pendingDelete={pendingFolderDelete}
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
            {draggedSession ? t.app.chat.sidebar2.dropHere : t.app.chat.sidebar2.empty}
          </p>
        ) : (
          <ul className="space-y-0.5 px-1 pb-1.5">
            {sessions.map((session) => (
              <SessionItem
                key={session.key}
                session={session}
                active={session.key === activeKey}
                pendingDelete={pendingDelete === session.key}
                onSelect={() => onSelectSession(session.key)}
                onDelete={(e) => onDeleteSession(e, session.key)}
                onDragStart={onDragStartSession}
                onDragEnd={onDragEndSession}
                otherFolders={otherFolders}
                currentFolderId={folder?.id ?? null}
                onMoveToFolder={onMoveSessionToFolder}
                onMoveToNoFolder={onMoveSessionToNoFolder}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

// ── FolderMenu ───────────────────────────────────────────────────────────

function FolderMenu({
  onClose,
  onRename,
  onDelete,
  pendingDelete,
}: {
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  pendingDelete: boolean;
}) {
  const { t } = useI18n();
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
        {t.app.chat.sidebar2.renameFolder}
      </button>
      <button
        type="button"
        onClick={onDelete}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px]",
          pendingDelete
            ? "bg-red-500/20 text-red-200"
            : "text-white/85 hover:bg-red-500/15 hover:text-red-200",
        )}
      >
        <Trash2 className="size-3" />
        {pendingDelete ? t.app.chat.sidebar2.confirmDelete : t.app.chat.sidebar2.deleteFolder}
      </button>
    </div>
  );
}

// ── FolderRenameInput ────────────────────────────────────────────────────

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
        onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
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

// ── NewFolderInput ───────────────────────────────────────────────────────

function NewFolderInput({
  creating,
  onSubmit,
  onCancel,
}: {
  creating: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
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
        onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        maxLength={80}
        placeholder={t.app.chat.sidebar2.folderNamePlaceholder}
        disabled={creating}
        className="flex-1 bg-transparent text-[12px] text-white/90 placeholder:text-white/40 focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={creating || !value.trim()}
        className="rounded p-1 text-cyan-300/85 hover:bg-cyan-400/15 disabled:opacity-30"
        aria-label={t.app.chat.sidebar2.createFolder}
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
        aria-label={t.app.chat.sidebar2.cancel}
      >
        <X className="size-3" />
      </button>
    </form>
  );
}

// ── SessionItem ──────────────────────────────────────────────────────────

function SessionItem({
  session,
  active,
  pendingDelete,
  onSelect,
  onDelete,
  onDragStart,
  onDragEnd,
  otherFolders,
  currentFolderId,
  onMoveToFolder,
  onMoveToNoFolder,
}: {
  session: SessionSummary;
  active: boolean;
  pendingDelete: boolean;
  onSelect: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onDragStart: (e: DragEvent<HTMLLIElement>, key: string) => void;
  onDragEnd: () => void;
  otherFolders: SessionFolder[];
  currentFolderId: string | null;
  onMoveToFolder: (key: string, folderId: string) => Promise<void>;
  onMoveToNoFolder: (key: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const time = formatRelativeTime(session.updatedAt);
  const [showMenu, setShowMenu] = useState(false);
  return (
    <li
      className="group relative"
      draggable
      onDragStart={(e) => onDragStart(e, session.key)}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-2 rounded-lg px-2 py-2 pr-14 text-left transition-all",
          active
            ? "bg-white/[0.05] text-white"
            : "text-white/55 hover:bg-white/[0.03] hover:text-white/90",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-1 h-4 w-[3px] shrink-0 rounded-full transition-all",
            active
              ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
              : "bg-transparent group-hover:bg-cyan-400/40",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-[12.5px] font-medium",
              active ? "text-white" : "text-white/80",
            )}
          >
            {session.title}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            <SessionSourceBadge
              source={session.source}
              peerLabel={session.peerLabel}
              size="sm"
              showLock
              showPeer
            />
            {time ? (
              <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35">
                {time}
              </span>
            ) : null}
          </div>
        </div>
      </button>
      <div className="absolute right-1 top-1.5 flex items-center gap-0.5">
        {/* Move to ... menu */}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu((v) => !v);
            }}
            className="rounded p-1 text-white/35 opacity-0 transition hover:bg-white/[0.06] hover:text-white/85 group-hover:opacity-100 focus:opacity-100"
            aria-label={`${t.app.chat.sidebar2.sessionActionsPrefix} ${session.title}`}
          >
            <MoreVertical className="size-3" />
          </button>
          {showMenu ? (
            <SessionItemMenu
              onClose={() => setShowMenu(false)}
              currentFolderId={currentFolderId}
              folders={otherFolders}
              onMoveToFolder={(fid) => {
                setShowMenu(false);
                void onMoveToFolder(session.key, fid);
              }}
              onMoveToNoFolder={() => {
                setShowMenu(false);
                void onMoveToNoFolder(session.key);
              }}
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label={
            pendingDelete
              ? `${t.app.chat.sidebar2.confirmDeleteSessionPrefix} ${session.title}`
              : `${t.app.chat.sidebar2.deleteSessionPrefix} ${session.title}`
          }
          className={cn(
            "rounded p-1 transition",
            pendingDelete
              ? "bg-red-500/20 text-red-300 opacity-100"
              : "opacity-0 text-white/40 hover:bg-red-500/15 hover:text-red-300 group-hover:opacity-100 focus:opacity-100",
          )}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </li>
  );
}

// ── SessionItemMenu ──────────────────────────────────────────────────────

function SessionItemMenu({
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
  const { t } = useI18n();
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
        {t.app.chat.sidebar2.moveTo}
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
              {t.app.chat.sidebar2.unfoldered}
            </button>
          </li>
        ) : null}
        {folders.length === 0 && currentFolderId === null ? (
          <li>
            <p className="px-3 py-2 text-[10.5px] text-white/35">
              {t.app.chat.sidebar2.noFoldersYet}
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

// ── Empty + skeleton ─────────────────────────────────────────────────────

function EmptySessions() {
  const { t } = useI18n();
  return (
    <div className="mx-2 mt-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-white/45">
      {t.app.chat.sidebar2.emptySessions}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <ul className="space-y-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="h-12 animate-pulse rounded-xl border border-white/5 bg-white/[0.03]"
        />
      ))}
    </ul>
  );
}
