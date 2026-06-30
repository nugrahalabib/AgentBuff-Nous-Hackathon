"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LogOut,
  Menu,
  Search,
  User,
  X,
  Zap,
} from "lucide-react";
import { signOut } from "next-auth/react";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";
import { useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n/context";
import { useSidebar } from "@/components/basecamp/sidebar-context";
import { NotificationBell } from "@/components/basecamp/notification-panel";
import { useProfile } from "@/hooks/use-api";

const NAV_ITEMS = [
  { id: "basecamp", icon: "🏠", href: "/app" },
  { id: "shop", icon: "🛒", href: "/app/shop" },
  { id: "forge", icon: "🔨", href: "/app" },
  { id: "agents", icon: "🤖", href: "/app/agents" },
  { id: "help", icon: "🎧", href: "/bantuan" },
  { id: "settings", icon: "⚙️", href: "/app/pengaturan" },
  { id: "home", icon: "🏠", href: "/" },
  { id: "patchNotes", icon: "📋", href: "/patch-notes" },
] as const;

const NAV_LABELS: Record<string, Record<string, string>> = {
  id: {
    basecamp: "Basecamp",
    shop: "Item Shop",
    forge: "The Forge",
    agents: "Agent Roster",
    help: "Help Center",
    settings: "Settings",
    home: "Landing Page",
    patchNotes: "Patch Notes",
  },
  en: {
    basecamp: "Basecamp",
    shop: "Item Shop",
    forge: "The Forge",
    agents: "Agent Roster",
    help: "Help Center",
    settings: "Settings",
    home: "Landing Page",
    patchNotes: "Patch Notes",
  },
};

export function AppTopbar() {
  const { t, locale } = useI18n();
  const router = useRouter();

  // Profile — nickname for greeting. Fallback to defaultName if not loaded.
  const { data: profile } = useProfile();
  const nickname =
    profile?.profile?.nickname ||
    profile?.profile?.displayName ||
    profile?.user?.name ||
    null;

  const [dateLabel, setDateLabel] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteInputRef = useRef<HTMLInputElement>(null);

  const rawName =
    nickname && nickname.trim().length > 0
      ? nickname.trim()
      : t.basecamp.topbar.defaultName;
  const displayName = rawName
    .split(/\s+/)
    .map((w) =>
      w.length === 0
        ? w
        : w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase(),
    )
    .join(" ");
  const avatarLetter = displayName.charAt(0).toLocaleUpperCase();

  const isMac =
    typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
  const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";

  useEffect(() => {
    const localeCode = locale === "id" ? "id-ID" : "en-US";
    setDateLabel(
      new Date().toLocaleDateString(localeCode, {
        weekday: "long",
        day: "numeric",
        month: "short",
      }),
    );
  }, [locale]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (paletteOpen) {
      setPaletteQuery("");
      setTimeout(() => paletteInputRef.current?.focus(), 50);
    }
  }, [paletteOpen]);

  const labels = NAV_LABELS[locale] ?? NAV_LABELS.id;
  const filteredItems = NAV_ITEMS.filter((item) => {
    if (!paletteQuery.trim()) return true;
    const label = labels[item.id] ?? item.id;
    return label.toLowerCase().includes(paletteQuery.toLowerCase());
  });

  const navigateTo = useCallback(
    (href: string) => {
      setPaletteOpen(false);
      router.push(href);
    },
    [router],
  );

  const cp = t.basecamp.topbar.commandPalette;

  let sidebarCtx: ReturnType<typeof useSidebar> | null = null;
  try {
    sidebarCtx = useSidebar();
  } catch {
    /* outside provider */
  }

  return (
    <>
      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4 backdrop-blur-md lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          {/* Mobile hamburger */}
          {sidebarCtx ? (
            <button
              type="button"
              onClick={sidebarCtx.toggleMobile}
              className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-white/60 transition-colors hover:text-white md:hidden"
              aria-label="Toggle menu"
            >
              <Menu className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0">
            <p
              suppressHydrationWarning
              className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/40"
            >
              {dateLabel || "\u00A0"}
            </p>
            <h1 className="mt-1 truncate font-display text-lg font-bold sm:text-xl">
              {t.basecamp.topbar.greetingPrefix}{" "}
              <span className="bg-gradient-to-r from-cyan-300 to-fuchsia-400 bg-clip-text text-transparent">
                {displayName}
              </span>
              {t.basecamp.topbar.greetingSuffix}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Search trigger */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-white/60 transition-colors hover:border-cyan-400/30 hover:text-white md:inline-flex"
          >
            <Search className="size-3.5" />
            <span>{t.basecamp.topbar.searchPlaceholder}</span>
            <kbd className="ml-2 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">
              {shortcutLabel}
            </kbd>
          </button>

          {/* Energy — skema masa depan (no-BYOK). Saat ini AgentBuff full BYOK
              jadi belum ada energy beneran. Tampil sbg badge "Segera Hadir"
              (non-fungsional) — jangan nampilin counter palsu. Chief 2026-06-02. */}
          <div
            aria-label={`Energy: ${t.basecamp.topbar.energyComingSoon}`}
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pr-3 pl-3 backdrop-blur-md sm:flex"
          >
            <Zap className="size-3.5 text-amber-300/70" />
            <span className="text-[10px] uppercase tracking-wider text-white/45">
              {t.basecamp.topbar.energyLabel}
            </span>
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
              {t.basecamp.topbar.energyComingSoon}
            </span>
          </div>

          <NotificationBell />

          <AvatarMenu avatarLetter={avatarLetter} />
        </div>
      </header>

      {/* Command Palette */}
      <AnimatePresence>
        {paletteOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[15vh] backdrop-blur-sm"
            onClick={() => setPaletteOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: -10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: -10 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
                <Search className="size-4 shrink-0 text-white/40" />
                <input
                  ref={paletteInputRef}
                  type="text"
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  placeholder={cp.placeholder}
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setPaletteOpen(false)}
                  className="flex size-6 items-center justify-center rounded bg-white/10 text-white/50 transition-colors hover:text-white"
                >
                  <X className="size-3" />
                </button>
              </div>

              <div className="scrollbar-slim max-h-[320px] overflow-y-auto p-2">
                <p className="mb-2 px-3 pt-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
                  {cp.title}
                </p>
                {filteredItems.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-white/30">
                    {cp.noResults}
                  </p>
                )}
                {filteredItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigateTo(item.href)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    <span className="text-base">{item.icon}</span>
                    <span className="font-medium">
                      {labels[item.id] ?? item.id}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-white/20">
                      {item.href}
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function AvatarMenu({ avatarLetter }: { avatarLetter: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const menu = t.basecamp.topbar.avatarMenu;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative size-9 shrink-0"
      >
        <div
          aria-hidden
          className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-70 blur-md"
        />
        <div className="relative flex size-9 items-center justify-center rounded-full border border-white/15 bg-[#0B0E14] font-display text-sm font-bold">
          {avatarLetter}
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 shadow-2xl backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push("/app/pengaturan");
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <User className="size-4" />
              {menu.profile}
            </button>
            <div className="mx-3 h-px bg-white/[0.06]" />
            <button
              type="button"
              onClick={() => {
                queryClient.clear();
                clearAgentbuffClientState();
                signOut({ callbackUrl: "/" });
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <LogOut className="size-4" />
              {menu.logout}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
