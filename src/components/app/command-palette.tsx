"use client";

/**
 * CommandPalette — global Cmd/Ctrl+K overlay for fast navigation.
 *  - Go-To any tab (NAV_ITEMS)
 *  - Jump to a chat session (store.sessions, searched by title)
 *  - Start a new thread
 * Pure client — no engine RPC beyond the existing setActiveSession/createSession
 * store actions. Mounted ONCE in AppShell.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Plus,
  MessageSquare,
  Building2,
  ShoppingBag,
  Gauge,
  Bot,
  AlarmClock,
  KanbanSquare,
  ListTree,
  Images,
  BarChart3,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { NAV_ITEMS } from "@/app/app/_components/nav-config";
import { cn } from "@/lib/utils";

const NAV_ICONS: Record<string, LucideIcon> = {
  MessageSquare,
  Building2,
  ShoppingBag,
  Gauge,
  Bot,
  AlarmClock,
  KanbanSquare,
  ListTree,
  Images,
  BarChart3,
  KeyRound,
};

type PaletteItem =
  | { kind: "newThread" }
  | { kind: "nav"; id: string; route: string; label: string; icon: string }
  | { kind: "session"; sessionKey: string; title: string };

export function CommandPalette() {
  const { t } = useI18n();
  const router = useRouter();
  const sessions = useAppStore((s) => s.sessions);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const createSession = useAppStore((s) => s.createSession);
  // Open-state lives in the store so the topbar trigger button + the keyboard
  // shortcut both control the SAME palette.
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global Cmd/Ctrl+K toggle (reads current state via getState to avoid a
  // stale closure on the empty-deps listener).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setCommandPaletteOpen(!s.commandPaletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset + focus the input each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const navTabs = t.app.nav.tabs;
  const navLabel = useCallback(
    (id: string) => navTabs[id as keyof typeof navTabs] ?? id,
    [navTabs],
  );

  const q = query.trim().toLowerCase();

  const flat = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    if (!q) out.push({ kind: "newThread" });
    for (const i of NAV_ITEMS) {
      if (!q || navLabel(i.id).toLowerCase().includes(q)) {
        out.push({ kind: "nav", id: i.id, route: i.route, label: navLabel(i.id), icon: i.icon });
      }
    }
    const sessionMatches = q
      ? sessions.filter((s) => (s.title || "").toLowerCase().includes(q))
      : sessions.slice(0, 6);
    for (const s of sessionMatches.slice(0, 8)) {
      out.push({ kind: "session", sessionKey: s.key, title: s.title || "Sesi" });
    }
    return out;
  }, [q, sessions, navLabel]);

  useEffect(() => {
    if (highlight >= flat.length) setHighlight(0);
  }, [flat.length, highlight]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const run = useCallback(
    async (item: PaletteItem) => {
      close();
      if (item.kind === "newThread") {
        await createSession();
        router.push("/app/chat");
      } else if (item.kind === "nav") {
        router.push(item.route);
      } else {
        await setActiveSession(item.sessionKey);
        router.push("/app/chat");
      }
    },
    [close, createSession, setActiveSession, router],
  );

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[highlight];
      if (it) void run(it);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={t.app.commandPalette.placeholder}
      onMouseDown={close}
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14]/95 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Search className="size-4 shrink-0 text-white/40" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={t.app.commandPalette.placeholder}
            className="flex-1 bg-transparent text-[14px] text-white placeholder:text-white/35 focus:outline-none"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-white/40">
              {t.app.commandPalette.empty}
            </p>
          ) : (
            flat.map((item, idx) => {
              const prev = flat[idx - 1];
              const showPages = item.kind === "nav" && prev?.kind !== "nav";
              const showSessions =
                item.kind === "session" && prev?.kind !== "session";
              const active = idx === highlight;
              const Icon =
                item.kind === "nav"
                  ? NAV_ICONS[item.icon] ?? MessageSquare
                  : item.kind === "session"
                    ? MessageSquare
                    : Plus;
              const labelText =
                item.kind === "newThread"
                  ? t.app.commandPalette.newThread
                  : item.kind === "nav"
                    ? item.label
                    : item.title;
              const key =
                item.kind === "nav"
                  ? `nav-${item.id}`
                  : item.kind === "session"
                    ? `ses-${item.sessionKey}`
                    : "new-thread";
              return (
                <Fragment key={key}>
                  {showPages ? (
                    <p className="px-2.5 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35">
                      {t.app.commandPalette.pages}
                    </p>
                  ) : null}
                  {showSessions ? (
                    <p className="px-2.5 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35">
                      {t.app.commandPalette.sessions}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => void run(item)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition",
                      active
                        ? "bg-cyan-400/15 text-cyan-50"
                        : "text-white/70 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        item.kind === "newThread"
                          ? "text-cyan-300"
                          : active
                            ? "text-cyan-200"
                            : "text-white/45",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{labelText}</span>
                  </button>
                </Fragment>
              );
            })
          )}
        </div>

        <div className="border-t border-white/[0.06] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
          {t.app.commandPalette.hint}
        </div>
      </div>
    </div>
  );
}
