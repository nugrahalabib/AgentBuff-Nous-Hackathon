"use client";

/**
 * Composition root for the /app surface. Mounts ONCE per app session and
 * hosts every tab as `{children}` — Next 16 App Router preserves this shell
 * across nested segment changes so GatewayProvider (parent layout) never
 * tears down. WS stays open, Zustand store survives, chat streaming in the
 * background keeps going while the user navigates to other tabs.
 *
 * Layout (collapsed states tracked here so both sidebars can shrink/expand
 * independently and persist across reloads):
 *   ┌───────────────────────────────────────────────────────┐
 *   │ NavSidebar │ ChatSubSide │  TopbarStatus              │
 *   │ (256/64px) │ (288/56px)  │  ApprovalsBanner           │
 *   │            │ (chat only) │  ConnectionBanner          │
 *   │            │             │  ┌──────────────────────┐  │
 *   │            │             │  │  TabErrorBoundary    │  │
 *   │            │             │  │    {children}        │  │
 *   │            │             │  └──────────────────────┘  │
 *   └───────────────────────────────────────────────────────┘
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ConnectionBanner } from "@/components/app/connection-banner";
import { CommandPalette } from "@/components/app/command-palette";
import { AccountLocaleSync } from "@/components/app/account-locale-sync";
import { useAppStore } from "@/lib/app/store";
import { AppSidebarNav } from "./app-sidebar-nav";
import { ChatSubSidebar } from "./chat-sub-sidebar";
import { SettingsSubSidebar } from "./settings-sub-sidebar";
import { TopbarStatus } from "./topbar-status";
import { ApprovalsBanner } from "./approvals-banner";
import { TrialBanner } from "@/components/app/trial-banner";
import { useBillingSettleListener } from "@/hooks/use-billing-settle";
import { useLimitsHydration } from "@/lib/app/use-limits";
import type { TrialInfo } from "@/lib/billing/trial-resolver";
import { TabErrorBoundary } from "./tab-error-boundary";
import { findNavItemByRoute } from "./nav-config";

const NAV_COLLAPSE_KEY = "agentbuff:app:sidebar:nav-collapsed";

function loadFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function persistFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
}

export function AppShell({
  children,
  trial = null,
}: {
  children: React.ReactNode;
  trial?: TrialInfo | null;
}) {
  const pathname = usePathname() ?? "/app/chat";
  const active = findNavItemByRoute(pathname);
  const tabId = active?.id ?? "unknown";

  // Post-payment auto-refresh: when the billing popup settles, drop the trial
  // overlay / flip the tier badge / clear the countdown — no manual reload.
  useBillingSettleListener();

  // D7: hydrate the user's per-tier media caps into the attachments module once
  // (default media caps until it lands; the bridge is the authoritative enforcer).
  useLimitsHydration();

  // Sub-sidebar khusus chat: muncul saat user di /app/chat DAN sudah punya
  // minimal satu session (= sudah memulai chat dengan Command Center, atau
  // pernah klik "Thread baru"). Sebelum itu, hero Command Center jadi
  // focal point tanpa side rail mengganggu.
  const isChatRoute = pathname.startsWith("/app/chat");
  const sessionCount = useAppStore((s) => s.sessions.length);
  const showChatSubSidebar = isChatRoute && sessionCount > 0;
  // Settings gets its own category rail in the same slot as the chat sub-sidebar.
  const isSettingsRoute = pathname.startsWith("/app/pengaturan");

  // Collapse state. Nav defaults false (expanded) to avoid SSR flash;
  // localStorage hydrates after mount. The chat sub-sidebar (session list)
  // defaults TRUE — hidden on every fresh page load (chief 2026-06-11:
  // "pas pertama web di buka jadi ke hide, ga muncul tab nya"). Its state is
  // deliberately NOT persisted: toggling works for the rest of the visit,
  // but a reload always starts hidden again.
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(true);

  useEffect(() => {
    setNavCollapsed(loadFlag(NAV_COLLAPSE_KEY));
  }, []);

  const toggleNav = useCallback(() => {
    setNavCollapsed((prev) => {
      const next = !prev;
      persistFlag(NAV_COLLAPSE_KEY, next);
      return next;
    });
  }, []);

  const toggleChat = useCallback(() => {
    // In-memory only — no persistFlag, so every fresh load starts hidden.
    setChatCollapsed((prev) => !prev);
  }, []);

  // Kapan sub-sidebar render fisik: di /app/chat, ada session, dan TIDAK
  // collapsed. Saat collapsed user expect itu fully hilang (free up space
  // for chat workspace) — toggle expand-nya muncul inline di Chat nav item.
  const renderChatSubSidebar = showChatSubSidebar && !chatCollapsed;
  const showChatExpandHint =
    showChatSubSidebar && chatCollapsed && isChatRoute;

  // M2 — Mobile nav drawer state. On viewports below md (768px), the nav
  // sidebar slides off-screen and the workspace fills 100% width. A
  // hamburger button (rendered inside TopbarStatus) toggles the drawer.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  // Close on route change so picking a tab from the drawer auto-collapses.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen text-white">
      {/* Global Cmd/Ctrl+K command palette — fixed overlay, position-independent. */}
      <CommandPalette />
      {/* Pull the per-account UI language (user_profile.locale) on load. */}
      <AccountLocaleSync />
      {/* M2 — Backdrop only visible on mobile when drawer open. */}
      {mobileNavOpen ? (
        <div
          role="presentation"
          onClick={closeMobileNav}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
        />
      ) : null}
      {/* M2 — Wrap the sidebar in a positioning shell so it can slide off
          on mobile but remain in the flex row on desktop. */}
      <div
        className={`z-40 transition-transform duration-200 ease-out md:static md:translate-x-0 ${
          mobileNavOpen
            ? "fixed inset-y-0 left-0 translate-x-0"
            : "fixed inset-y-0 left-0 -translate-x-full md:translate-x-0"
        }`}
      >
        <AppSidebarNav
          collapsed={navCollapsed}
          onToggle={toggleNav}
          showChatExpandHint={showChatExpandHint}
          onExpandChat={toggleChat}
        />
      </div>
      {renderChatSubSidebar ? (
        <div className="hidden shrink-0 py-4 pl-4 md:block">
          <ChatSubSidebar collapsed={false} onToggle={toggleChat} />
        </div>
      ) : null}
      {isSettingsRoute ? (
        <div className="hidden shrink-0 py-4 pl-4 md:block">
          <SettingsSubSidebar />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopbarStatus
          mobileNavOpen={mobileNavOpen}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          trial={trial}
        />
        <TrialBanner trial={trial} />
        <ApprovalsBanner />
        <ConnectionBanner />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <TabErrorBoundary key={tabId} tabId={tabId}>
            {children}
          </TabErrorBoundary>
        </main>
      </div>
    </div>
  );
}
