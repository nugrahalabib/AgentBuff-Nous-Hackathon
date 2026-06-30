"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useNotifications, useMarkAllRead, useMarkRead } from "@/hooks/use-api";

type NotifTab = "tasks" | "system" | "store";

export function NotificationBell() {
  const { t } = useI18n();
  const n = t.basecamp.notifications;
  const [open, setOpen] = useState(false);
  const [localReadIds, setLocalReadIds] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<NotifTab>("tasks");
  const { data: apiItems } = useNotifications(activeTab);
  const markAllReadMutation = useMarkAllRead();
  const markReadMutation = useMarkRead();

  // DB is the sole source of truth. Empty DB → show empty state.
  // Dictionary items remain available to seed the copy, but never render as data.
  const items = useMemo<NotificationRow[]>(
    () => (apiItems ?? []) as NotificationRow[],
    [apiItems],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const unreadCount = items.filter(
    (item) => !item.read && !localReadIds.has(item.id),
  ).length;

  const markAllRead = useCallback(() => {
    markAllReadMutation.mutate(undefined, {
      onError: () => {
        // Fallback: mark locally
        setLocalReadIds(new Set(items.map((item) => item.id)));
      },
    });
    setLocalReadIds(new Set(items.map((item) => item.id)));
  }, [items, markAllReadMutation]);

  const markRead = useCallback((id: string) => {
    markReadMutation.mutate(id, {
      onError: () => {
        // Fallback: mark locally
      },
    });
    setLocalReadIds((prev) => new Set([...prev, id]));
  }, [markReadMutation]);

  return (
    <div ref={panelRef} className="relative">
      {/* Bell trigger */}
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full border bg-white/5 text-white/70 transition-colors",
          open
            ? "border-cyan-400/40 text-white"
            : "border-white/10 hover:border-cyan-400/30 hover:text-white",
        )}
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex size-[18px] items-center justify-center rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-[10px] font-bold text-white shadow-[0_0_10px_rgba(217,70,239,0.6)] animate-pulse">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      <AnimatePresence>
        {open && (
          <NotificationDropdown
            n={n}
            items={items}
            readIds={localReadIds}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onMarkAllRead={markAllRead}
            onMarkRead={markRead}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

interface NotificationRow {
  id: string;
  tab: string;
  icon: string | null;
  text: string;
  time?: string;
  createdAt?: string;
  read: boolean;
  highPriority?: boolean;
  action?: { label: string; href: string };
  actionLabel?: string | null;
  actionHref?: string | null;
}

function NotificationDropdown({
  n,
  items,
  readIds,
  activeTab,
  onTabChange,
  onMarkAllRead,
  onMarkRead,
  onClose,
}: {
  n: ReturnType<typeof useI18n>["t"]["basecamp"]["notifications"];
  items: NotificationRow[];
  readIds: Set<string>;
  activeTab: NotifTab;
  onTabChange: (tab: NotifTab) => void;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onClose: () => void;
}) {
  const isRead = (item: NotificationRow) =>
    item.read || readIds.has(item.id);

  const filtered = items.filter((item) => item.tab === activeTab);
  const tabUnread = (tabId: string) =>
    items.filter((item) => item.tab === tabId && !isRead(item)).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ type: "spring", damping: 28, stiffness: 350 }}
      className="absolute right-0 top-full z-50 mt-2 w-[380px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0F1218]/95 shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
        <h3 className="text-sm font-bold">{n.title}</h3>
        <button
          type="button"
          onClick={onMarkAllRead}
          className="text-[11px] font-medium text-cyan-400/70 transition-colors hover:text-cyan-400"
        >
          {n.markAllRead}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/[0.06]">
        {n.tabs.map((tab) => {
          const active = activeTab === tab.id;
          const count = tabUnread(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id as NotifTab)}
              className={cn(
                "relative flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors",
                active
                  ? "text-white"
                  : "text-white/40 hover:text-white/60",
              )}
            >
              <span className="text-sm">{tab.icon}</span>
              <span>{tab.label}</span>
              {count > 0 && (
                <span className={cn(
                  "ml-0.5 flex size-4 items-center justify-center rounded-full text-[9px] font-bold",
                  active
                    ? "bg-cyan-500/25 text-cyan-300"
                    : "bg-white/10 text-white/50",
                )}>
                  {count}
                </span>
              )}
              {/* Active underline */}
              {active && (
                <motion.span
                  layoutId="notif-tab-underline"
                  className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Items */}
      <div className="max-h-[360px] overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState icon={n.emptyIcon} text={n.emptyText} />
        ) : (
          filtered.map((item) => {
            const read = isRead(item);
            return (
              <div
                key={item.id}
                className={cn(
                  "group relative border-b border-white/[0.03] px-5 py-3.5 transition-colors hover:bg-white/[0.03]",
                  !read && "bg-cyan-500/[0.02]",
                )}
              >
                {/* Unread dot */}
                {!read && (
                  <span className="absolute left-2 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.6)]" />
                )}

                <div className="flex gap-3">
                  {/* Icon */}
                  <span className="mt-0.5 text-base leading-none">{item.icon ?? "🔔"}</span>

                  <div className="min-w-0 flex-1">
                    {/* Text */}
                    <p className={cn(
                      "text-[13px] leading-snug",
                      read ? "text-white/45" : "font-medium text-white/80",
                    )}>
                      {item.text}
                    </p>

                    {/* Meta row: time + WA badge + action */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] text-white/30">{item.time ?? item.createdAt ?? ""}</span>

                      {item.highPriority && (
                        <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                          📲 {n.whatsAppSynced}
                        </span>
                      )}

                      {(item.action || item.actionHref) && (
                        <Link
                          href={item.action?.href ?? item.actionHref ?? "#"}
                          onClick={() => {
                            onMarkRead(item.id);
                            onClose();
                          }}
                          className="rounded-md bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold text-cyan-400/80 transition-colors hover:bg-cyan-500/15 hover:text-cyan-300"
                        >
                          {item.action?.label ?? item.actionLabel ?? ""}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </motion.div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10">
      <span className="text-4xl">{icon}</span>
      <p className="mt-3 text-center text-xs text-white/35 leading-relaxed">{text}</p>
    </div>
  );
}
