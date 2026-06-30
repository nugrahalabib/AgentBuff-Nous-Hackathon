"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import Link from "next/link";
import Image from "next/image";
import { triggerDemoEarn } from "@/components/app/demo-earn-notification";
// Demo EARN cue: "Upgrade now" fires the top-center income notification (Babak 1).
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronsLeft,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { signOut } from "next-auth/react";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";
import { useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n/context";
import { siteConfig } from "@/lib/constants";
import { useSidebar } from "@/components/basecamp/sidebar-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useSubscriptionState } from "@/hooks/use-api";
import {
  SESSION_LABEL_SOFT_MAX,
  useAppStore,
  type SessionSummary,
} from "@/lib/app/store";
import {
  computeSessionPreview,
  formatRelativeTime,
} from "@/lib/app/session-utils";
import { cn } from "@/lib/utils";

// Nav item set → real production routes. "basecamp"/"workspace" are the /app
// home; shop/agents/settings map to their live /app surfaces; help points at the
// /bantuan support page. "forge" has no user-facing surface yet (creator/seller
// dashboard is admin-only), so it falls back to /app home rather than the
// retired /basecamp mock. Active item stays "basecamp" since /app IS the surface.
const HREF_BY_ID: Record<string, string> = {
  basecamp: "/app",
  workspace: "/app",
  shop: "/app/shop",
  forge: "/app",
  agents: "/app/agents",
  help: "/bantuan",
  settings: "/app/pengaturan",
};

export function AppSidebar() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [threadToast, setThreadToast] = useState(false);
  const queryClient = useQueryClient();
  // Paid subscribers must NOT see the "Unlock OP Buff" upgrade prompt — they
  // already unlocked it. status==="active" covers active + canceled-not-expired.
  const { data: subState } = useSubscriptionState();
  const isSubscribed = subState?.status === "active";
  const isMobile = useMediaQuery("(max-width: 767px)");

  // Bound inside a SidebarProvider rendered by chat-shell.
  let sidebarCtx: ReturnType<typeof useSidebar> | null = null;
  try {
    sidebarCtx = useSidebar();
  } catch {
    /* outside provider — defensive, shouldn't happen */
  }

  // Session state from the centralized store (source of truth per ADR §D2).
  const sessions = useAppStore((s) => s.sessions);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded);
  const sessionsError = useAppStore((s) => s.sessionsError);
  const status = useAppStore((s) => s.status);
  const createSession = useAppStore((s) => s.createSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const setActive = useAppStore((s) => s.setActiveSession);

  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Inline rename state: which session key is being renamed (null = none)
  // and the working draft of the label. Only one session renameable at a
  // time to keep the affordance simple.
  const [renamingKey, setRenamingKey] = useState<string | null>(null);

  const handleNewThread = useCallback(async () => {
    if (status !== "ready" || creating) return;
    setCreating(true);
    try {
      const newKey = await createSession();
      if (newKey) {
        setThreadToast(true);
        setTimeout(() => setThreadToast(false), 2500);
        sidebarCtx?.closeMobile();
      }
    } finally {
      setCreating(false);
    }
  }, [status, creating, createSession, sidebarCtx]);

  const handleDelete = useCallback(
    async (e: MouseEvent<HTMLButtonElement>, key: string) => {
      e.stopPropagation();
      if (pendingDelete === key) {
        setPendingDelete(null);
        await deleteSession(key);
        return;
      }
      setPendingDelete(key);
      // Auto-cancel after 4s so the confirm banner doesn't linger forever.
      // 4s gives enough reading time without feeling sticky.
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
      // Cancel any pending delete confirm so the two states don't collide.
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
      // Fire-and-forget: action handles optimistic update + rollback on err.
      await renameSession(key, nextLabel);
    },
    [renameSession],
  );

  const handleSelect = useCallback(
    async (key: string) => {
      await setActive(key);
      sidebarCtx?.closeMobile();
    },
    [setActive, sidebarCtx],
  );

  const mobileOpen = sidebarCtx?.mobileOpen ?? false;
  const closeMobile = sidebarCtx?.closeMobile;

  if (isMobile && !mobileOpen) return null;

  return (
    <>
      {/* Mobile backdrop */}
      {isMobile && mobileOpen ? (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm"
          onClick={closeMobile}
        />
      ) : null}
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-white/[0.06] bg-[#0B0E14]/60 backdrop-blur-xl transition-all",
          isMobile
            ? "fixed inset-y-0 left-0 z-30 w-[244px]"
            : cn("relative z-10", collapsed ? "w-[72px]" : "w-[244px]"),
        )}
        aria-label="Sidebar navigasi"
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 py-5">
          <div className="relative shrink-0">
            <div
              aria-hidden
              className="absolute inset-0 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-60 blur-md"
            />
            <Image
              src="/images/logo.png"
              alt={siteConfig.name}
              width={32}
              height={32}
              className="relative size-8 rounded-lg"
            />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{siteConfig.name}</p>
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
                {t.basecamp.sidebar.brandTag}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label="Toggle sidebar"
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 text-white/50 transition-colors hover:border-cyan-400/40 hover:text-white"
          >
            <ChevronsLeft
              className={cn(
                "size-3.5 transition-transform",
                collapsed && "rotate-180",
              )}
            />
          </button>
        </div>

        {/* New thread CTA — wired to store.createSession */}
        <div className="px-3">
          <button
            type="button"
            onClick={handleNewThread}
            disabled={status !== "ready" || creating}
            className={cn(
              "group relative flex w-full items-center gap-2 overflow-hidden rounded-xl border py-2.5 text-sm font-semibold transition-all",
              status !== "ready" || creating
                ? "cursor-not-allowed border-white/10 bg-white/[0.02] text-white/40"
                : "border-white/10 bg-white/[0.04] hover:border-cyan-400/40 hover:bg-white/[0.08]",
              collapsed ? "justify-center px-2" : "px-3",
            )}
            aria-label={t.basecamp.sidebar.newThread}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-md transition-shadow",
                status !== "ready" || creating
                  ? "bg-white/10 text-white/40"
                  : "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] group-hover:shadow-[0_0_12px_rgba(99,102,241,0.7)]",
              )}
            >
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" strokeWidth={3} />
              )}
            </span>
            {!collapsed && <span>{t.basecamp.sidebar.newThread}</span>}
          </button>
        </div>

        {/* Nav items — only "basecamp" is the in-surface active state. Every
            other entry routes to its real /app surface (or /bantuan).
            Workspace is dropped: it used to alias basecamp and
            lit up TWO rails simultaneously (ugly), and its hardcoded "12"
            badge was stale data. */}
        <nav
          className="mt-3 flex flex-col gap-0.5 px-2"
          aria-label="Navigasi utama"
        >
          {t.basecamp.sidebar.items
            .filter((item) => item.id !== "workspace")
            .map((item) => {
              const active = item.id === "basecamp";
              const href = HREF_BY_ID[item.id] ?? "/app";
              const isInternal = href.startsWith("/app");
              return (
                <Link
                  key={item.id}
                  href={href}
                  onClick={() => sidebarCtx?.closeMobile()}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium transition-all",
                    active
                      ? "bg-white/[0.05] text-white"
                      : "text-white/55 hover:bg-white/[0.03] hover:text-white",
                    collapsed ? "justify-center px-2" : "pl-4 pr-3",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-all",
                      active
                        ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                        : "bg-transparent group-hover:bg-cyan-400/40",
                    )}
                  />
                  {/* Fixed icon slot so emoji width variance doesn't warp
                      the column of labels (🏠 is narrower than 💬/🛒/🤖). */}
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center text-[15px] leading-none"
                  >
                    {item.icon}
                  </span>
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate text-left">
                        {item.label}
                      </span>
                      {item.badge ? (
                        <span
                          className={cn(
                            "inline-flex h-[18px] min-w-[28px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] leading-none",
                            item.badge === "NEW"
                              ? "bg-gradient-to-r from-cyan-400 to-fuchsia-400 font-bold text-[#0B0E14]"
                              : "border border-white/10 bg-white/[0.06] text-white/55",
                          )}
                        >
                          {item.badge}
                        </span>
                      ) : null}
                      {!isInternal && (
                        <span
                          aria-hidden
                          className="-mr-1 text-white/25 transition-colors group-hover:text-white/45"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M7 17 17 7" />
                            <path d="M7 7h10v10" />
                          </svg>
                        </span>
                      )}
                    </>
                  )}
                </Link>
              );
            })}
        </nav>

        {/* Sessions — live wire to store.sessions. Only expanded. */}
        {!collapsed && (
          <div className="mt-6 min-h-0 flex-1 overflow-hidden border-t border-white/[0.04] pt-4">
            <div className="flex items-center justify-between px-4 pb-3">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.24em] text-white/35">
                Sesi
              </p>
              {sessions.length > 0 ? (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] leading-none text-white/40">
                  {sessions.length}
                </span>
              ) : null}
            </div>
            <div
              className="h-full overflow-y-auto px-2 pb-2"
              aria-label="Daftar sesi chat"
            >
              {!sessionsLoaded && status !== "ready" ? (
                <SessionsSkeleton />
              ) : sessions.length === 0 ? (
                <p className="mx-1 rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-3 text-center text-[11px] text-white/40">
                  Belum ada sesi. Tekan &quot;Thread Baru&quot;.
                </p>
              ) : (
                <ul className="space-y-1">
                  {sessions.map((session) => (
                    <SessionItem
                      key={session.key}
                      session={session}
                      active={session.key === activeKey}
                      pendingDelete={pendingDelete === session.key}
                      renaming={renamingKey === session.key}
                      onSelect={() => void handleSelect(session.key)}
                      onDelete={(e) => void handleDelete(e, session.key)}
                      onCancelDelete={handleCancelDelete}
                      onStartRename={(e) =>
                        handleStartRename(e, session.key)
                      }
                      onCommitRename={(label) =>
                        void handleCommitRename(session.key, label)
                      }
                      onCancelRename={handleCancelRename}
                    />
                  ))}
                </ul>
              )}
              {sessionsError ? (
                <p
                  className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200"
                  role="alert"
                >
                  {sessionsError}
                </p>
              ) : null}
            </div>
          </div>
        )}

        {/* Footer OP Buff card + logout */}
        <div className={cn("shrink-0 p-3", collapsed && "mt-auto")}>
          {!collapsed ? (
            <div className="space-y-3">
              {isSubscribed ? (
                <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">👑</span>
                    <p className="text-xs font-semibold text-emerald-200">
                      {t.basecamp.sidebar.planActiveTitle}
                    </p>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-white/55">
                    {t.basecamp.sidebar.planActiveDesc}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-fuchsia-400/20 bg-gradient-to-br from-fuchsia-500/10 via-indigo-500/10 to-cyan-500/5 p-3">
                  <p className="text-xs font-semibold">
                    {t.basecamp.sidebar.upgradeTitle}
                  </p>
                  <p className="mt-1 text-[11px] leading-snug text-white/55">
                    {t.basecamp.sidebar.upgradeDesc}
                  </p>
                  <button
                    type="button"
                    onClick={triggerDemoEarn}
                    className="mt-2 inline-block text-[11px] font-bold text-fuchsia-300 hover:text-fuchsia-200"
                  >
                    {t.basecamp.sidebar.upgradeCta}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  queryClient.clear();
                  clearAgentbuffClientState();
                  signOut({ callbackUrl: "/" });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white/50 transition-colors hover:bg-white/[0.04] hover:text-white/80"
              >
                <LogOut className="size-4" />
                {t.basecamp.sidebar.logout}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {isSubscribed ? (
                <div
                  aria-label={t.basecamp.sidebar.planActiveTitle}
                  title={t.basecamp.sidebar.planActiveTitle}
                  className="flex size-10 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                >
                  <span className="text-sm">👑</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={triggerDemoEarn}
                  aria-label="Upgrade"
                  className="flex size-10 items-center justify-center rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 transition-colors hover:bg-fuchsia-500/20"
                >
                  <span className="text-sm">👑</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  queryClient.clear();
                  clearAgentbuffClientState();
                  signOut({ callbackUrl: "/" });
                }}
                aria-label={t.basecamp.sidebar.logout}
                className="flex size-10 items-center justify-center rounded-xl text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/70"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          )}
        </div>

        {/* Thread toast */}
        <AnimatePresence>
          {threadToast && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="fixed bottom-6 left-6 z-50 rounded-xl border border-emerald-500/20 bg-[#0B0E14]/95 px-5 py-3 shadow-2xl backdrop-blur-sm"
            >
              <p className="text-sm font-medium text-emerald-400">
                ✓ {t.basecamp.sidebar.newThreadToast}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </aside>
    </>
  );
}

function SessionItem({
  session,
  active,
  pendingDelete,
  renaming,
  onSelect,
  onDelete,
  onCancelDelete,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  session: SessionSummary;
  active: boolean;
  pendingDelete: boolean;
  renaming: boolean;
  onSelect: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onCancelDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  onStartRename: (e: MouseEvent<HTMLButtonElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}) {
  // Live signals for THIS session. Zustand selectors are reference-shallow
  // (Object.is), so an unrelated session's streaming delta won't re-render us.
  const messages = useAppStore((s) => s.messages[session.key]);
  const streaming = useAppStore((s) => s.streaming[session.key] ?? null);
  const sending = useAppStore((s) => s.sending[session.key] ?? false);

  // Preview resolution order:
  //   1. Streaming snapshot — mirrors live deltas at ~150ms throttle.
  //   2. Last committed renderable bubble — for sessions we've opened.
  //   3. Server-supplied `lastMessagePreview` — for sessions we haven't
  //      opened yet (store lazy-loads transcripts; sidebar would otherwise
  //      show "Belum ada pesan" forever on unopened rows).
  const preview = useMemo(() => {
    if (streaming) {
      const live = computeSessionPreview([streaming]);
      if (live) return live;
    }
    const local = computeSessionPreview(messages);
    if (local) return local;
    return session.lastMessagePreview ?? null;
  }, [messages, streaming, session.lastMessagePreview]);

  const isLive = Boolean(streaming) || sending;
  const time = formatRelativeTime(session.updatedAt);

  // Renaming state: swap the row for an inline text input. Enter commits,
  // Esc cancels, blur commits (so clicking away still saves — matches how
  // most chat apps treat rename). Optimistic update + rollback is handled in
  // the store action (see AppState.renameSession). Preempts pendingDelete.
  if (renaming) {
    return (
      <li className="group relative">
        <SessionRenameInput
          initial={session.title}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
          sessionKey={session.key}
        />
      </li>
    );
  }

  // Pending-delete state: swap the row for an explicit inline confirm panel
  // so the affordance is OBVIOUS (2-click confirm via icon-color-only was
  // confusing — user couldn't tell what had happened). The panel uses the
  // same row footprint so the list doesn't jump, and exposes two clear
  // actions: Batal (soft) + Hapus (destructive).
  if (pendingDelete) {
    return (
      <li className="group relative">
        <motion.div
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          role="alertdialog"
          aria-labelledby={`delete-confirm-${session.key}`}
          className="relative overflow-hidden rounded-xl border border-red-500/40 bg-red-500/[0.08] px-3 py-2 shadow-[0_0_18px_rgba(239,68,68,0.18)] backdrop-blur-sm"
        >
          <p
            id={`delete-confirm-${session.key}`}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-red-100"
          >
            <Trash2 className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">Hapus &ldquo;{session.title}&rdquo;?</span>
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-red-200/75">
            Semua pesan di sesi ini bakal hilang permanen.
          </p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={onCancelDelete}
              aria-label="Batal hapus sesi"
              className="rounded-md px-2 py-1 text-[11px] font-semibold text-white/65 transition hover:bg-white/5 hover:text-white"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Konfirmasi hapus sesi ${session.title}`}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1 text-[11px] font-bold text-white shadow-[0_0_12px_rgba(239,68,68,0.5)] transition hover:bg-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            >
              <Trash2 className="size-3" aria-hidden />
              Hapus
            </button>
          </div>
        </motion.div>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-3 rounded-xl px-3 py-2 pr-8 text-left transition-all",
          active
            ? "bg-white/[0.05] text-white"
            : "text-white/55 hover:bg-white/[0.03] hover:text-white/90",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-1 h-5 w-[3px] shrink-0 rounded-full transition-all",
            active
              ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
              : "bg-transparent group-hover:bg-cyan-400/40",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isLive ? (
              <span
                aria-hidden
                title="Sesi aktif — AI sedang merespons"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]"
              />
            ) : null}
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] font-medium",
                active ? "text-white" : "text-white/75",
              )}
            >
              {session.title}
            </p>
            {time ? (
              <span
                className={cn(
                  "shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em] transition-opacity",
                  active ? "text-white/45" : "text-white/30",
                  // Fade out while the delete button reveals — avoids overlap
                  // with the absolute-positioned Trash icon.
                  "group-hover:opacity-0",
                )}
              >
                {time}
              </span>
            ) : null}
          </div>
          {preview ? (
            <p
              className={cn(
                "mt-0.5 truncate text-[11.5px] leading-snug",
                active ? "text-white/60" : "text-white/45",
                isLive && "text-cyan-200/75",
              )}
              aria-label={`Pesan terakhir: ${preview}`}
            >
              {preview}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-[11.5px] italic leading-snug text-white/25">
              Belum ada pesan
            </p>
          )}
        </div>
      </button>
      {/* Row actions — pencil (rename) + trash (delete). Both hidden until
          hover so the resting state stays calm. Arranged in a flex stack so
          they live on the same absolute-positioned block. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onStartRename}
          title="Ganti nama sesi"
          aria-label={`Ganti nama sesi ${session.title}`}
          className="rounded p-1 text-white/40 transition hover:bg-cyan-400/15 hover:text-cyan-300"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Hapus sesi"
          aria-label={`Hapus sesi ${session.title}`}
          className="rounded p-1 text-white/40 transition hover:bg-red-500/15 hover:text-red-300"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

/**
 * Inline rename input. Owns its own text state so keystrokes don't trigger
 * parent re-renders mid-typing. Enter commits, Esc cancels, blur commits
 * (matches WhatsApp / Notion rename ergonomics). An initial one-shot select
 * highlights the existing title so paste-over is trivial.
 */
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
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard so `onBlur` fires only once — if we committed via Enter the blur
  // event still fires afterwards and would double-commit (second call with
  // potentially stale state). Ref since it must survive re-renders without
  // re-binding handlers.
  const closedRef = useRef(false);

  useEffect(() => {
    // Focus + select immediately on mount so the user can paste or type
    // without an extra click. Small RAF defers past React's commit so the
    // cursor lands correctly in all browsers.
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
    // Empty input = no-op cancel (don't clobber the current title with
    // blank). To CLEAR a manual label back to auto-title, user should
    // delete the session + new thread — clearing via empty rename felt
    // ambiguous in testing.
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
      className="relative overflow-hidden rounded-xl border border-cyan-400/50 bg-[#0B0E14]/90 px-2.5 py-2 shadow-[0_0_18px_rgba(34,211,238,0.25)] backdrop-blur-sm"
      role="group"
      aria-label={`Ganti nama sesi ${initial}`}
    >
      <label
        htmlFor={`rename-input-${sessionKey}`}
        className="mb-1 block font-mono text-[9.5px] font-medium uppercase tracking-[0.24em] text-cyan-300/80"
      >
        Ganti nama
      </label>
      <input
        id={`rename-input-${sessionKey}`}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, SESSION_LABEL_SOFT_MAX))}
        onKeyDown={onKeyDown}
        onBlur={commit}
        maxLength={SESSION_LABEL_SOFT_MAX}
        placeholder="Tulis nama baru, tekan Enter"
        className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] font-medium text-white outline-none transition placeholder:text-white/30 focus:border-cyan-400/60 focus:bg-black/60"
        aria-describedby={`rename-hint-${sessionKey}`}
      />
      <p
        id={`rename-hint-${sessionKey}`}
        className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35"
      >
        Enter simpan · Esc batal
      </p>
    </div>
  );
}

function SessionsSkeleton() {
  return (
    <ul className="space-y-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="h-10 animate-pulse rounded-xl border border-white/5 bg-white/[0.03]"
        />
      ))}
    </ul>
  );
}
