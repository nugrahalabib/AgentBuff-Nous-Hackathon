"use client";

/**
 * Primary left sidebar — nav for all 18 tabs grouped into 4 collapsible
 * sections (Chat / Kontrol / Agen / Pengaturan).
 *
 * Session list (Thread baru + threads) sudah DIPISAH ke ChatSubSidebar —
 * sub-sidebar standalone yang muncul di sebelah kanan sidebar utama saat
 * user berada di /app/chat dan sudah punya minimal satu session.
 *
 * Collapse state persists in localStorage; active-tab group auto-expands.
 * Router.prefetch on hover keeps tab switches instant.
 */
import Link from "next/link";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";
import { useQueryClient } from "@tanstack/react-query";
import { siteConfig } from "@/lib/constants";
import {
  MessageSquare,
  Gauge,
  ShoppingBag,
  Radio,
  Boxes,
  ListTree,
  Images,
  BarChart3,
  AlarmClock,
  Bot,
  Sparkles,
  Network,
  Moon,
  Settings,
  Mic,
  Palette,
  Zap,
  Server,
  BrainCircuit,
  Bug,
  ScrollText,
  KeyRound,
  KanbanSquare,
  Building2,
  Receipt,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { useSubscriptionState } from "@/hooks/use-api";
import { triggerDemoEarn } from "@/components/app/demo-earn-notification";
import { cn } from "@/lib/utils";
import {
  NAV_DEFAULT_EXPANDED,
  NAV_GROUPS,
  NAV_ITEMS,
  findNavItemByRoute,
  type NavGroupKey,
  type NavItem,
} from "./nav-config";

const ICONS: Record<string, LucideIcon> = {
  MessageSquare,
  Gauge,
  ShoppingBag,
  Radio,
  Boxes,
  ListTree,
  Images,
  BarChart3,
  AlarmClock,
  Bot,
  Sparkles,
  Network,
  Moon,
  Settings,
  Mic,
  Palette,
  Zap,
  Server,
  BrainCircuit,
  Bug,
  ScrollText,
  KeyRound,
  KanbanSquare,
  Building2,
  Receipt,
};

const COLLAPSE_STORAGE_KEY = "agentbuff:app:nav:expanded";

function loadExpanded(): Record<NavGroupKey, boolean> {
  if (typeof window === "undefined") return { ...NAV_DEFAULT_EXPANDED };
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return { ...NAV_DEFAULT_EXPANDED };
    const parsed = JSON.parse(raw) as Partial<Record<NavGroupKey, boolean>>;
    return { ...NAV_DEFAULT_EXPANDED, ...parsed };
  } catch {
    return { ...NAV_DEFAULT_EXPANDED };
  }
}

function persistExpanded(value: Record<NavGroupKey, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* quota — non-fatal */
  }
}

export function AppSidebarNav({
  collapsed,
  onToggle,
  showChatExpandHint = false,
  onExpandChat,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Saat user di /app/chat dan sub-sidebar threads sedang hidden, kita
   *  tampilkan tombol kecil di samping Chat nav item untuk munculin kembali
   *  panel thread tanpa user harus tahu fitur collapse di sub-sidebar. */
  showChatExpandHint?: boolean;
  onExpandChat?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/chat";
  const { t } = useI18n();
  // Paid subscribers must NOT see the upgrade prompt — they already unlocked it.
  const { data: subState } = useSubscriptionState();
  const isSubscribed = subState?.status === "active";
  const [expanded, setExpanded] = useState<Record<NavGroupKey, boolean>>(
    () => ({ ...NAV_DEFAULT_EXPANDED }),
  );

  useEffect(() => {
    setExpanded(loadExpanded());
  }, []);

  const active = findNavItemByRoute(pathname);
  const activeGroup = active?.groupKey ?? "utama";

  // Auto-expand the active tab's group so navigation stays visible.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev[activeGroup]) return prev;
      const next = { ...prev, [activeGroup]: true };
      persistExpanded(next);
      return next;
    });
  }, [activeGroup]);

  // No usable brain → the Providers tab carries a needs_brain badge. Force its
  // group (pengaturan) open so the amber cue is visible in the default desktop
  // view (the group ships collapsed). In-session only — we do NOT persist this,
  // so the user's real collapse preference is restored on next load.
  const needsBrain = useAppStore((s) => s.needsBrain);
  useEffect(() => {
    if (!needsBrain) return;
    setExpanded((prev) =>
      prev.pengaturan ? prev : { ...prev, pengaturan: true },
    );
  }, [needsBrain]);

  const toggleGroup = useCallback((group: NavGroupKey) => {
    setExpanded((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      persistExpanded(next);
      return next;
    });
  }, []);

  const itemsByGroup = useMemo(() => {
    const map = new Map<NavGroupKey, NavItem[]>();
    for (const g of NAV_GROUPS) map.set(g, []);
    for (const item of NAV_ITEMS) {
      map.get(item.groupKey)?.push(item);
    }
    return map;
  }, []);

  const queryClient = useQueryClient();

  const handleLogout = useCallback(() => {
    queryClient.clear();
    clearAgentbuffClientState();
    void signOut({ callbackUrl: "/" });
  }, [queryClient]);

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-white/[0.06] bg-[#0B0E14]/60 backdrop-blur-xl transition-[width] duration-200 ease-out",
        collapsed ? "w-[72px]" : "w-64",
      )}
    >
      {/* ── Brand header. Expanded: logo + brand text + toggle in row.
            Collapsed: logo centered di atas, toggle button di baris bawah
            sebagai full-width pill — clear affordance, tidak overlap border. */}
      <div
        className={cn(
          "shrink-0 border-b border-white/[0.06]",
          collapsed ? "px-3 pt-4 pb-2" : "px-4 py-3.5",
        )}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-3">
            <Link
              href="/app/chat"
              title="Command Center"
              className="relative shrink-0"
            >
              <div
                aria-hidden
                className="absolute inset-0 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-60 blur-md"
              />
              <Image
                src="/images/logo.png"
                alt={siteConfig.name}
                width={40}
                height={40}
                className="relative size-10 rounded-lg"
                priority
              />
            </Link>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Buka sidebar"
              title="Buka sidebar"
              className="flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
            >
              <ChevronsRight className="size-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Link href="/app/chat" className="flex min-w-0 items-center gap-2">
              <div className="relative shrink-0">
                <div
                  aria-hidden
                  className="absolute inset-0 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-60 blur-md"
                />
                <Image
                  src="/images/logo.png"
                  alt={siteConfig.name}
                  width={36}
                  height={36}
                  className="relative size-9 rounded-lg"
                  priority
                />
              </div>
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
                  {siteConfig.name}
                </span>
                <span className="truncate text-sm font-semibold text-white/85">
                  Command Center
                </span>
              </div>
            </Link>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Minimize sidebar"
              title="Minimize sidebar"
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
            >
              <ChevronsLeft className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* ── Nav body. Collapsed: vertical icon stack DENGAN group separator
            (garis tipis pemisah antar grup) supaya hierarchy tetap kebaca.
            Expanded: original collapsible accordion. */}
      <div
        className={cn(
          "scrollbar-slim min-h-0 flex-1 overflow-y-auto",
          collapsed ? "px-3 py-3" : "px-2 py-3",
        )}
      >
        {collapsed ? (
          <div className="space-y-3">
            {NAV_GROUPS.map((group, gi) => {
              const items = itemsByGroup.get(group) ?? [];
              if (items.length === 0) return null;
              return (
                <div key={group}>
                  {gi > 0 && (
                    <div
                      aria-hidden
                      className="mx-auto mb-3 h-px w-6 bg-white/[0.06]"
                    />
                  )}
                  <div className="space-y-1">
                    {items.map((item) => (
                      <NavLinkCollapsed
                        key={item.id}
                        item={item}
                        isActive={item.id === active?.id}
                        prefetch={() => router.prefetch(item.route)}
                        label={
                          t.app.nav.tabs[
                            item.id as keyof typeof t.app.nav.tabs
                          ]
                        }
                        showChatExpandHint={
                          item.id === "chat" && showChatExpandHint
                        }
                        onExpandChat={onExpandChat}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          NAV_GROUPS.map((group) => {
            const isOpen = expanded[group];
            const items = itemsByGroup.get(group) ?? [];
            return (
              <div key={group} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-white/[0.03]"
                >
                  <ChevronRight
                    aria-hidden
                    className={`size-3 text-white/40 transition-transform ${
                      isOpen ? "rotate-90" : ""
                    }`}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/55">
                    {t.app.nav.groups[group]}
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-1 space-y-0.5">
                    {items.map((item) => (
                      <NavLink
                        key={item.id}
                        item={item}
                        isActive={item.id === active?.id}
                        prefetch={() => router.prefetch(item.route)}
                        label={
                          t.app.nav.tabs[
                            item.id as keyof typeof t.app.nav.tabs
                          ]
                        }
                        showChatExpandHint={
                          item.id === "chat" && showChatExpandHint
                        }
                        onExpandChat={onExpandChat}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ── Footer. Expanded: upgrade card + logout text. Collapsed:
            logout icon centered dengan padding konsisten + border atas
            sebagai visual anchor. */}
      <div
        className={cn(
          "shrink-0 border-t border-white/[0.04]",
          collapsed ? "px-3 py-3" : "p-3",
        )}
      >
        {!collapsed &&
          (isSubscribed ? (
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
              <p className="text-xs font-semibold text-white/90">
                {t.basecamp.sidebar.upgradeTitle}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-white/55">
                {t.basecamp.sidebar.upgradeDesc}
              </p>
              <button
                type="button"
                onClick={triggerDemoEarn}
                className="mt-2 inline-block text-[11px] font-bold text-fuchsia-300 transition hover:text-fuchsia-200"
              >
                {t.basecamp.sidebar.upgradeCta}
              </button>
            </div>
          ))}
        <button
          type="button"
          onClick={handleLogout}
          aria-label={t.basecamp.sidebar.logout}
          title={collapsed ? t.basecamp.sidebar.logout : undefined}
          className={cn(
            "flex items-center rounded-lg text-sm font-medium text-white/50 transition-colors hover:bg-white/[0.04] hover:text-white/80",
            collapsed
              ? "mx-auto size-11 justify-center"
              : "mt-2 w-full gap-2 px-3 py-2",
          )}
        >
          <LogOut className="size-4 shrink-0" />
          {!collapsed && <span>{t.basecamp.sidebar.logout}</span>}
        </button>
      </div>
    </aside>
  );
}

/**
 * Icon-only nav link untuk collapsed mode. Tooltip via title attr biar
 * user tetap tau apa fungsi tiap icon tanpa expand. Active state pakai
 * gradient indicator dot di kanan-atas + bg highlight, sama seperti
 * expanded mode tapi tanpa rail strip kiri (tidak muat di 64px width).
 */
function NavLinkCollapsed({
  item,
  isActive,
  prefetch,
  label,
  showChatExpandHint = false,
  onExpandChat,
}: {
  item: NavItem;
  isActive: boolean;
  prefetch: () => void;
  label: string;
  showChatExpandHint?: boolean;
  onExpandChat?: () => void;
}) {
  const Icon = ICONS[item.icon] ?? Settings;
  return (
    <div className="relative">
      <Link
        href={item.route}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        prefetch={false}
        title={label}
        aria-label={label}
        className={cn(
          "group relative mx-auto flex size-11 items-center justify-center rounded-lg transition",
          isActive
            ? "bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/10 text-white shadow-[0_0_0_1px_rgba(34,211,238,0.25),0_4px_18px_-6px_rgba(34,211,238,0.45)]"
            : "text-white/55 hover:bg-white/[0.04] hover:text-white/90",
        )}
      >
        {isActive && (
          <span
            aria-hidden
            className="absolute -left-3 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
          />
        )}
        <Icon className="size-[18px]" aria-hidden strokeWidth={isActive ? 2.25 : 1.75} />
        <NavBadgeCollapsed item={item} />
      </Link>
      {showChatExpandHint && onExpandChat ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onExpandChat();
          }}
          aria-label="Buka daftar thread"
          title="Buka daftar thread"
          className="absolute -right-2 top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded-full border border-cyan-400/40 bg-[#0B0E14] text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.45)] transition hover:bg-cyan-400/20 hover:text-cyan-200"
        >
          <ChevronsRight className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Floating count badge untuk collapsed mode — tampil di kanan-atas icon.
 * Reuse logic count yang sama dari NavBadge expanded.
 */
function NavBadgeCollapsed({ item }: { item: NavItem }) {
  const count = useAppStore((s) => {
    const state = s as unknown as {
      approvalsCount?: number;
      pendingPairsCount?: number;
      updateAvailable?: boolean;
      needsBrain?: boolean;
    };
    if (item.badge === "approvals") return state.approvalsCount ?? 0;
    if (item.badge === "pending_pairs") return state.pendingPairsCount ?? 0;
    if (item.badge === "update_available")
      return state.updateAvailable ? 1 : 0;
    if (item.badge === "needs_brain") return state.needsBrain ? 1 : 0;
    return 0;
  });
  if (!item.badge || count === 0) return null;
  if (item.badge === "needs_brain") {
    return (
      <span
        aria-hidden
        className="absolute right-1 top-1 size-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.85)]"
      />
    );
  }
  const palette =
    item.badge === "update_available"
      ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
      : "border-amber-400/40 bg-amber-400/15 text-amber-200";
  return (
    <span
      aria-hidden
      className={cn(
        "absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-1 font-mono text-[8px] tabular-nums",
        palette,
      )}
    >
      {count}
    </span>
  );
}

function NavLink({
  item,
  isActive,
  prefetch,
  label,
  showChatExpandHint = false,
  onExpandChat,
}: {
  item: NavItem;
  isActive: boolean;
  prefetch: () => void;
  label: string;
  showChatExpandHint?: boolean;
  onExpandChat?: () => void;
}) {
  const Icon = ICONS[item.icon] ?? Settings;
  return (
    <div className="relative">
      <Link
        href={item.route}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        prefetch={false}
        className={`group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition ${
          isActive
            ? "bg-white/[0.06] text-white"
            : "text-white/65 hover:bg-white/[0.03] hover:text-white/90"
        }`}
      >
        <span
          className={`h-5 w-[3px] rounded-full transition ${
            isActive
              ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
              : "bg-transparent group-hover:bg-cyan-400/40"
          }`}
          aria-hidden
        />
        <Icon className="size-4 shrink-0 text-white/55" aria-hidden />
        <span className="truncate">{label}</span>
        <NavBadge item={item} />
        {showChatExpandHint && onExpandChat ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onExpandChat();
            }}
            aria-label="Buka daftar thread"
            title="Buka daftar thread"
            className="ml-auto flex size-5 items-center justify-center rounded-full border border-cyan-400/40 bg-white/[0.04] text-cyan-300 transition hover:bg-cyan-400/20 hover:text-cyan-200"
          >
            <ChevronsRight className="size-3" />
          </button>
        ) : null}
      </Link>
    </div>
  );
}

function NavBadge({ item }: { item: NavItem }) {
  // Wrap all store reads in optional-field guards so the nav renders before
  // slices are wired. Each slice replaces the default value when it lands.
  const count = useAppStore((s) => {
    const state = s as unknown as {
      approvalsCount?: number;
      pendingPairsCount?: number;
      updateAvailable?: boolean;
      needsBrain?: boolean;
    };
    if (item.badge === "approvals") return state.approvalsCount ?? 0;
    if (item.badge === "pending_pairs") return state.pendingPairsCount ?? 0;
    if (item.badge === "update_available")
      return state.updateAvailable ? 1 : 0;
    if (item.badge === "needs_brain") return state.needsBrain ? 1 : 0;
    return 0;
  });
  if (!item.badge || count === 0) return null;
  if (item.badge === "needs_brain") {
    return (
      <span
        aria-hidden
        className="ml-auto size-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.85)]"
      />
    );
  }
  const palette =
    item.badge === "update_available"
      ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
      : "border-amber-400/40 bg-amber-400/15 text-amber-200";
  return (
    <span
      className={`ml-auto rounded-full border px-1.5 text-[10px] font-mono tabular-nums ${palette}`}
    >
      {count}
    </span>
  );
}
