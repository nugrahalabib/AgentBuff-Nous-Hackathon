/**
 * Nav config — 5 groups × 11 tabs. Single source of truth for AppSidebarNav.
 *
 * Keeping this as pure data (no React imports) so it can be consumed by the
 * sidebar, topbar (active-tab breadcrumb), nav-aware analytics, and server
 * components that need to resolve a route to a label.
 *
 * Icon names are from lucide-react. The component resolves `icon` into a
 * component via a map so we don't pull the whole lucide namespace into this
 * data module.
 */
export type NavGroupKey = "utama" | "markas" | "tim" | "riwayat" | "pengaturan";

export type NavItem = {
  /** Stable id for selectors + dictionary lookups. */
  id: string;
  groupKey: NavGroupKey;
  /** i18n key path in t.app.nav.tabs[id] — always present. */
  labelKey: string;
  /** lucide-react icon name (resolved by consumer). */
  icon: string;
  /** Next route this item navigates to. */
  route: string;
  /** Optional dot/badge selector — derive count/state from store. Resolved
   *  by AppSidebarNav; items without badge never render one. */
  badge?: "approvals" | "pending_pairs" | "update_available" | "needs_brain";
};

export const NAV_ITEMS: NavItem[] = [
  // ───── Utama ───── (aksi paling sering: chat, kantor 3D, belanja upgrade)
  { id: "chat", groupKey: "utama", labelKey: "chat", icon: "MessageSquare", route: "/app/chat" },
  { id: "office", groupKey: "utama", labelKey: "office", icon: "Building2", route: "/app/office" },
  { id: "shop", groupKey: "utama", labelKey: "shop", icon: "ShoppingBag", route: "/app/shop" },

  // ───── Markas ───── (pantau)
  { id: "overview", groupKey: "markas", labelKey: "overview", icon: "Gauge", route: "/app/overview", badge: "update_available" },

  // ───── Tim Agen ───── (agen + tempat kerjanya + jadwalnya)
  { id: "agents", groupKey: "tim", labelKey: "agents", icon: "Bot", route: "/app/agents" },
  { id: "cron", groupKey: "tim", labelKey: "cron", icon: "AlarmClock", route: "/app/cron" },
  { id: "kanban", groupKey: "tim", labelKey: "kanban", icon: "KanbanSquare", route: "/app/kanban" },

  // ───── Riwayat & Biaya ─────
  { id: "sessions", groupKey: "riwayat", labelKey: "sessions", icon: "ListTree", route: "/app/sessions" },
  { id: "galeri", groupKey: "riwayat", labelKey: "galeri", icon: "Images", route: "/app/galeri" },
  { id: "usage", groupKey: "riwayat", labelKey: "usage", icon: "BarChart3", route: "/app/usage" },
  { id: "riwayat", groupKey: "riwayat", labelKey: "riwayat", icon: "Receipt", route: "/app/riwayat" },

  // ───── Pengaturan ─────
  { id: "pengaturan", groupKey: "pengaturan", labelKey: "pengaturan", icon: "Settings", route: "/app/pengaturan" },
  { id: "providers", groupKey: "pengaturan", labelKey: "providers", icon: "KeyRound", route: "/app/providers", badge: "needs_brain" },
];

export const NAV_GROUPS: NavGroupKey[] = ["utama", "markas", "tim", "riwayat", "pengaturan"];

/** Collapse-state default. Utama + Markas + Tim expanded (sering dipakai);
 *  Riwayat + Pengaturan collapsed. Overridden per-user via localStorage. */
export const NAV_DEFAULT_EXPANDED: Record<NavGroupKey, boolean> = {
  utama: true,
  markas: true,
  tim: true,
  riwayat: false,
  pengaturan: false,
};

export function findNavItemByRoute(route: string): NavItem | null {
  // Longest-prefix match so /app/agents/main-agent resolves to the agents tab.
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    if (route === item.route || route.startsWith(`${item.route}/`)) {
      if (!best || item.route.length > best.route.length) best = item;
    }
  }
  return best;
}
