"use client";

/**
 * Sessions tab v2 — User-friendly conversation archive.
 *
 * Layout zones:
 *  1. SectionHeader — title + subtitle + refresh
 *  2. Inline explainer card — "apa itu sesi" plain Bahasa
 *  3. Stats strip — 4 tile (total / tokens / aktif hari ini / paling boros)
 *  4. Filter bar — search + kind chips + sort + active-time filter
 *  5. Card grid — rich SessionCard per session
 *  6. SessionDetailDrawer — slide-in dari kanan dengan 3 tab
 *  7. Empty state contextual
 *
 * Data source: useAppStore.sessions (populated by sessions.list).
 * Bulk select: per-card checkbox, floating action bar saat ada selection.
 *
 * Mass-market focus: title front-and-center, token clearly labeled,
 * one-click rename + delete + open. Advanced features (compaction, behavior
 * settings) accessible via drawer tab tapi gak overwhelming default view.
 */
import {
  Calendar,
  Info,
  ListTree,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAppStore,
  type SessionFolder,
  type SessionSearchResult,
  type SessionSummary,
} from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { EmptyState } from "@/components/app/primitives/empty-state";
import { cn } from "@/lib/utils";
import { SessionsStatsStrip } from "@/components/app/sessions/session-stats-strip";
import { SessionCard } from "@/components/app/sessions/session-card";
import { SessionDetailDrawer } from "@/components/app/sessions/session-detail-drawer";
import { SessionsFilterBar } from "@/components/app/sessions/sessions-filter-bar";
import type {
  ActiveFilter,
  AgentFilter,
  ChannelFilter,
  DateFilterState,
  DatePreset,
  FolderFilter,
  KindFilter,
  SortKey,
  ViewMode,
} from "@/components/app/sessions/sessions-filter-bar";
import { FOLDER_FILTER_UNFOLDERED } from "@/components/app/sessions/sessions-filter-bar";
import {
  SESSION_DATE_GROUP_ORDER,
  agentIdFromSessionKey,
  groupSessionsByDate,
  type SessionDateGroup,
} from "@/lib/app/session-utils";

const DELETE_AUTO_CANCEL_MS = 4000;

// localStorage key for date filter preference. Single JSON blob carries
// both preset + custom range so re-load is one read.
const DATE_FILTER_STORAGE_KEY = "agentbuff:app:sessions-date-filter";

const DATE_FILTER_DEFAULT: DateFilterState = { preset: "any", from: "", to: "" };

function readDateFilterFromStorage(): DateFilterState {
  if (typeof window === "undefined") return DATE_FILTER_DEFAULT;
  try {
    const raw = window.localStorage.getItem(DATE_FILTER_STORAGE_KEY);
    if (!raw) return DATE_FILTER_DEFAULT;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || !parsed) return DATE_FILTER_DEFAULT;
    const validPresets: DatePreset[] = ["any", "today", "yesterday", "7d", "30d", "custom"];
    const preset = validPresets.includes(parsed.preset) ? parsed.preset : "any";
    return {
      preset,
      from: typeof parsed.from === "string" ? parsed.from : "",
      to: typeof parsed.to === "string" ? parsed.to : "",
    };
  } catch {
    return DATE_FILTER_DEFAULT;
  }
}

function writeDateFilterToStorage(state: DateFilterState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DATE_FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota — best-effort */
  }
}

// Compute [startMs, endMs] window (inclusive start, exclusive end) for the
// active date filter. Returns null when filter is "any" or invalid.
function computeDateWindow(state: DateFilterState, now: number): [number, number] | null {
  if (state.preset === "any") return null;
  const startOfDay = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayMs = 24 * 60 * 60_000;

  if (state.preset === "today") {
    const s = startOfDay(now);
    return [s, s + dayMs];
  }
  if (state.preset === "yesterday") {
    const s = startOfDay(now) - dayMs;
    return [s, s + dayMs];
  }
  if (state.preset === "7d") {
    const s = startOfDay(now) - 6 * dayMs; // include today + 6 days back
    return [s, startOfDay(now) + dayMs];
  }
  if (state.preset === "30d") {
    const s = startOfDay(now) - 29 * dayMs;
    return [s, startOfDay(now) + dayMs];
  }
  if (state.preset === "custom") {
    // Parse YYYY-MM-DD strings to local-time midnight boundaries.
    if (!state.from && !state.to) return null;
    const parseYmd = (s: string): number | null => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return null;
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10) - 1;
      const d = parseInt(m[3], 10);
      const t = new Date(y, mo, d).getTime();
      return Number.isFinite(t) ? t : null;
    };
    const from = state.from ? parseYmd(state.from) : null;
    const to = state.to ? parseYmd(state.to) : null;
    const startMs = from ?? 0;
    const endMs = to ? to + dayMs : startOfDay(now) + dayMs; // inclusive of "to" day
    if (startMs > endMs) return null;
    return [startMs, endMs];
  }
  return null;
}

export function SessionsTab() {
  const { t } = useI18n();
  const s = t.app.sessions;
  const router = useRouter();
  const sessions = useAppStore((st) => st.sessions);
  const activeKey = useAppStore((st) => st.activeSessionKey);
  const sessionsLoaded = useAppStore((st) => st.sessionsLoaded);
  const sessionsError = useAppStore((st) => st.sessionsError);
  const refreshSessionsAction = useAppStore((st) => st.refreshSessions);
  const deleteSessionAction = useAppStore((st) => st.deleteSession);
  const setActiveSession = useAppStore((st) => st.setActiveSession);
  const searchSessionsContent = useAppStore(
    (st) => st.searchSessionsContent,
  );
  const agentsCatalog = useAppStore((st) => st.agentsCatalog);
  const agentsCatalogLoaded = useAppStore((st) => st.agentsCatalogLoaded);
  const loadAgentsCatalog = useAppStore((st) => st.loadAgentsCatalog);

  // Filter state
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [channel, setChannel] = useState<ChannelFilter>("any");
  const [agent, setAgent] = useState<AgentFilter>("any");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("any");
  const [sort, setSort] = useState<SortKey>("updatedDesc");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("any");
  const [refreshing, setRefreshing] = useState(false);

  // Folder data (loaded by gateway-provider on ready)
  const folders = useAppStore((st) => st.folders);
  const sessionFolders = useAppStore((st) => st.sessionFolders);
  // O(1) folder lookup by id — replaces a per-card folders.find() (was
  // O(sessions x folders) every render, x3 list renderers).
  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  // Date filter state — persisted in localStorage.
  // SSR-safe: default on server, hydrate from localStorage post-mount.
  const [dateFilter, setDateFilter] = useState<DateFilterState>(
    DATE_FILTER_DEFAULT,
  );
  useEffect(() => {
    setDateFilter(readDateFilterFromStorage());
  }, []);
  const setDateFilterPersisted = useCallback((next: DateFilterState) => {
    setDateFilter(next);
    writeDateFilterToStorage(next);
  }, []);

  // Load the agents catalog (id → name/emoji) so sessions can show + filter by
  // owning agent. Fire-and-forget; idempotent inside the store.
  useEffect(() => {
    if (!agentsCatalogLoaded) void loadAgentsCatalog();
  }, [agentsCatalogLoaded, loadAgentsCatalog]);

  // View mode — "grouped" by date (Today/Yesterday/This Week/Earlier)
  // or "flat" sorted list. Default grouped to match Hermes Desktop UX.
  // SSR-safe: server always renders default; localStorage hydrates after
  // mount via useEffect to avoid hydration mismatch (button className would
  // differ between server-render and client-rehydrate).
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(
        "agentbuff:app:sessions-view-mode",
      );
      if (stored === "flat" || stored === "folder" || stored === "grouped") {
        setViewMode(stored);
      }
    } catch {
      /* read failure — keep default */
    }
  }, []);
  const setViewModePersisted = useCallback((next: ViewMode) => {
    setViewMode(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "agentbuff:app:sessions-view-mode",
        next,
      );
    } catch {
      /* quota — best-effort */
    }
  }, []);

  // Content search (Phase 1 + 2) — when `search` has ≥2 chars, we call
  // bridge `sessions.search` RPC instead of (or in addition to) the
  // client-side title filter. Debounced 300ms to avoid flooding the
  // bridge on every keystroke. Hermes Desktop parity from Sessions.tsx
  // (lines 223-239).
  const [contentResults, setContentResults] = useState<
    SessionSearchResult[]
  >([]);
  const [contentSearching, setContentSearching] = useState(false);
  const [contentSearchError, setContentSearchError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchEpochRef = useRef(0);
  const trimmedSearch = search.trim();
  const contentSearchActive = trimmedSearch.length >= 2;

  useEffect(() => {
    // Clear any pending timer when the query text changes.
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    if (!contentSearchActive) {
      setContentResults([]);
      setContentSearching(false);
      setContentSearchError(null);
      return;
    }
    // Epoch lets us discard stale results when the user types fast.
    searchEpochRef.current += 1;
    const myEpoch = searchEpochRef.current;
    setContentSearching(true);
    setContentSearchError(null);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchSessionsContent(trimmedSearch);
        // Only commit if this is still the latest request.
        if (myEpoch === searchEpochRef.current) {
          setContentResults(results);
        }
      } catch (e) {
        if (myEpoch === searchEpochRef.current) {
          setContentResults([]);
          setContentSearchError(
            e instanceof Error ? e.message : "Pencarian gagal. Coba lagi.",
          );
        }
      } finally {
        if (myEpoch === searchEpochRef.current) {
          setContentSearching(false);
        }
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [trimmedSearch, contentSearchActive, searchSessionsContent]);

  // Bulk select state
  const [bulkMode, setBulkMode] = useState(false);
  // 2-click inline confirm for the irreversible bulk delete (replaces the
  // native window.confirm — consistent with the single-delete arm/commit).
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Drawer state
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const drawerSession = useMemo(
    () => (drawerKey ? sessions.find((x) => x.key === drawerKey) ?? null : null),
    [drawerKey, sessions],
  );

  // Live "now" tick for relative time
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Delete confirm state
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    };
  }, []);

  const armDelete = useCallback((key: string) => {
    setPendingDelete(key);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    deleteTimerRef.current = setTimeout(() => {
      setPendingDelete((cur) => (cur === key ? null : cur));
      deleteTimerRef.current = null;
    }, DELETE_AUTO_CANCEL_MS);
  }, []);

  const cancelDelete = useCallback(() => {
    setPendingDelete(null);
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
  }, []);

  const commitDelete = useCallback(
    async (key: string) => {
      cancelDelete();
      try {
        await deleteSessionAction(key);
        if (drawerKey === key) setDrawerKey(null);
      } catch {
        /* error handled in store via sessionsError */
      }
    },
    [deleteSessionAction, cancelDelete, drawerKey],
  );

  const handleDeleteClick = useCallback(
    (key: string) => {
      if (pendingDelete === key) {
        void commitDelete(key);
      } else {
        armDelete(key);
      }
    },
    [pendingDelete, commitDelete, armDelete],
  );

  const handleBulkDelete = useCallback(async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) return;
    // First click arms the confirm; second click within the window commits.
    if (!bulkDeleteArmed) {
      setBulkDeleteArmed(true);
      setBulkDeleteError(null);
      return;
    }
    setBulkDeleteArmed(false);
    // Run independently so one failure doesn't abort the rest; report how many
    // failed instead of silently swallowing per-item errors.
    const results = await Promise.allSettled(
      keys.map((key) => deleteSessionAction(key)),
    );
    const failed = keys.filter((_, i) => results[i].status === "rejected");
    if (failed.length > 0) {
      setBulkDeleteError(
        `${failed.length} dari ${keys.length} sesi gagal dihapus.`,
      );
      setSelectedKeys(new Set(failed)); // keep the ones that still need attention
    } else {
      setSelectedKeys(new Set());
      setBulkMode(false);
    }
  }, [selectedKeys, deleteSessionAction, bulkDeleteArmed]);

  // Auto-disarm the bulk-delete confirm after a few seconds of inaction.
  useEffect(() => {
    if (!bulkDeleteArmed) return;
    const t = setTimeout(() => setBulkDeleteArmed(false), 3500);
    return () => clearTimeout(t);
  }, [bulkDeleteArmed]);

  const refreshSessions = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshSessionsAction();
    } finally {
      setRefreshing(false);
    }
  }, [refreshSessionsAction]);

  // Phase 6 UX polish — Ctrl/Cmd+K focuses the search input from anywhere
  // in the Sessions tab. Hermes Desktop has a native menu shortcut for
  // this; on the web we listen at the window level. Skip when chief is
  // already typing in another input/textarea.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || e.key.toLowerCase() !== "k") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        target?.isContentEditable
      ) {
        // If chief is in our search input already, still focus + select
        // (matches Browser Find muscle memory). For any OTHER input,
        // leave alone.
        if (target !== searchInputRef.current) return;
      }
      e.preventDefault();
      const el = searchInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Phase 4 — Auto-refresh polling. Hermes Desktop equivalent:
  // `SESSIONS_REFRESH_MS = 30_000` background sync while tab visible.
  //
  // Guards:
  //   - Page Visibility API: pause refresh when tab hidden (chief might
  //     leave the tab open in background; no point burning bridge cycles).
  //   - Skip when content search is active (don't disrupt typing or
  //     re-trigger the search RPC race).
  //   - Skip when already refreshing (manual + auto race-safe).
  //
  // 30s cadence matches Hermes Desktop. We don't go faster because the
  // bridge has to re-read N session JSON files per refreshSessions().
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (contentSearchActive) return;
      // Read refreshing state at tick-time (not effect-mount time) so
      // overlapping manual + auto fires don't double-burst.
      if (refreshing) return;
      await refreshSessions();
    };
    const id = setInterval(tick, 30_000);
    // Also tick when tab becomes visible after being hidden — caught up
    // immediately so the list isn't stale from chief's last session.
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // contentSearchActive + refreshing intentionally NOT in deps —
    // they're read live inside `tick`. Adding them would reset the
    // interval on every keystroke / refresh state flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions]);

  const handleOpen = useCallback(
    async (key: string) => {
      await setActiveSession(key);
      router.push("/app/chat");
    },
    [setActiveSession, router],
  );

  const toggleSelect = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Filter pipeline
  const dateWindow = useMemo(
    () => computeDateWindow(dateFilter, now),
    [dateFilter, now],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = sessions.filter((row) => {
      if (kind !== "all" && (row.kind ?? "unknown") !== kind) return false;
      // Channel filter — match raw source
      if (channel !== "any") {
        const src = (row.source ?? "").toLowerCase();
        if (src !== channel.toLowerCase()) return false;
      }
      // Agent filter — match the owning agent (bridge-resolved; key fallback).
      if (agent !== "any") {
        const aid = row.agentId || agentIdFromSessionKey(row.key);
        if (aid !== agent) return false;
      }
      // Folder filter
      if (folderFilter !== "any") {
        const assignedFolder = sessionFolders[row.key];
        if (folderFilter === FOLDER_FILTER_UNFOLDERED) {
          if (assignedFolder) return false; // sessions WITH folder excluded
        } else {
          if (assignedFolder !== folderFilter) return false;
        }
      }
      // Active time filter (rolling minutes from "now"). Use the 10s `now` tick
      // (a memo dep below) so the rolling window actually advances — a fresh
      // Date.now() here is frozen until some other dep changes.
      if (activeFilter !== "any") {
        const minutes = parseInt(activeFilter, 10);
        const cutoff = now - minutes * 60_000;
        if ((row.updatedAt ?? 0) < cutoff) return false;
      }
      // Date filter (calendar-based window)
      if (dateWindow) {
        const ts = row.updatedAt ?? 0;
        if (ts < dateWindow[0] || ts >= dateWindow[1]) return false;
      }
      if (q) {
        if (
          !row.title.toLowerCase().includes(q) &&
          !row.key.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
    arr = [...arr].sort((a, b) => {
      switch (sort) {
        case "updatedAsc":
          return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
        case "title":
          return a.title.localeCompare(b.title);
        case "key":
          return a.key.localeCompare(b.key);
        case "tokens":
          return (b.totalTokens ?? 0) - (a.totalTokens ?? 0);
        case "updatedDesc":
        default:
          return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      }
    });
    return arr;
  }, [
    sessions,
    kind,
    channel,
    agent,
    folderFilter,
    sessionFolders,
    search,
    sort,
    activeFilter,
    dateWindow,
    now,
  ]);

  const kindCounts = useMemo(() => {
    const acc: Record<KindFilter, number> = {
      all: sessions.length,
      direct: 0,
      group: 0,
      unknown: 0,
    };
    for (const row of sessions) {
      const k = (row.kind ?? "unknown") as KindFilter;
      if (k in acc) acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
  }, [sessions]);

  const channelCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const row of sessions) {
      const src = (row.source ?? "").toLowerCase();
      if (!src) continue;
      acc[src] = (acc[src] ?? 0) + 1;
    }
    return acc;
  }, [sessions]);

  // Per-agent session counts (keyed by normalized agentId from the key).
  const agentCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const row of sessions) {
      const aid = row.agentId || agentIdFromSessionKey(row.key);
      if (!aid) continue;
      acc[aid] = (acc[aid] ?? 0) + 1;
    }
    return acc;
  }, [sessions]);

  // id → friendly {label, emoji} for the owning agent, built from the agents
  // catalog. Default agent ("default") prettifies to "Agen Utama" when it has
  // no custom name; a fallback entry is always seeded so pre-catalog renders
  // still resolve.
  const agentLabels = useMemo(() => {
    const map: Record<string, { label: string; emoji: string }> = {};
    for (const a of agentsCatalog) {
      const isDefault = a.id === "default";
      const label =
        isDefault && (!a.name || a.name.toLowerCase() === "default")
          ? "Agen Utama"
          : a.name || a.id;
      map[a.id] = { label, emoji: a.emoji || (isDefault ? "⭐" : "🤖") };
    }
    if (!map["default"]) map["default"] = { label: "Agen Utama", emoji: "⭐" };
    return map;
  }, [agentsCatalog]);

  // Show per-agent badges + the agent filter only when 2+ agents own sessions.
  const showAgentBadge = Object.keys(agentCounts).length > 1;

  // Folder counts: each folder id → number of sessions assigned, plus
  // FOLDER_FILTER_UNFOLDERED → number without assignment.
  const folderCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    let unfoldered = 0;
    for (const row of sessions) {
      const fid = sessionFolders[row.key];
      if (fid) acc[fid] = (acc[fid] ?? 0) + 1;
      else unfoldered++;
    }
    if (unfoldered > 0) acc[FOLDER_FILTER_UNFOLDERED] = unfoldered;
    return acc;
  }, [sessions, sessionFolders]);

  const busy = refreshing || !sessionsLoaded;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow={s.eyebrow}
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBulkMode((p) => !p);
                if (bulkMode) setSelectedKeys(new Set());
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition",
                bulkMode
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                  : "border-white/10 bg-white/[0.04] text-white/70 hover:border-white/20 hover:text-white",
              )}
            >
              <ListTree className="size-3.5" aria-hidden />
              {bulkMode ? "Selesai Pilih" : "Pilih Banyak"}
            </button>
            <button
              type="button"
              onClick={() => void refreshSessions()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/70 transition hover:border-cyan-400/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-3.5", busy && "animate-spin")}
                aria-hidden
              />
              {s.refresh}
            </button>
          </div>
        }
      />

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          {sessionsError ? (
            <div
              role="alert"
              className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-[12px] text-red-100"
            >
              <strong>{s.errorTitle}: </strong>
              {sessionsError}
            </div>
          ) : null}

          {/* Inline explainer */}
          <div className="flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.04] via-indigo-500/[0.03] to-transparent px-4 py-3 text-[12px] text-white/75 backdrop-blur-md">
            <Info className="mt-0.5 size-4 shrink-0 text-cyan-300/85" aria-hidden />
            <p className="leading-relaxed">{s.pageExplainer}</p>
          </div>

          {/* Stats strip */}
          <SessionsStatsStrip
            sessions={sessions}
            loading={busy && sessions.length === 0}
            onSelectLargest={(key) => setDrawerKey(key)}
          />

          {/* Filter bar — redesigned 2026-05-26 for clarity.
              Structure: Search + Action buttons (row 1) → Kind chips (row 2) →
              Active filter chips (row 3, conditional) → Counter strip (row 4). */}
          <SessionsFilterBar
            // Search
            search={search}
            onSearchChange={setSearch}
            searchInputRef={searchInputRef}
            contentSearching={contentSearching}
            // Kind
            kind={kind}
            kindCounts={kindCounts}
            onKindChange={setKind}
            // Channel
            channel={channel}
            channelCounts={channelCounts}
            onChannelChange={setChannel}
            // Agent
            agent={agent}
            agentCounts={agentCounts}
            agentLabels={agentLabels}
            onAgentChange={setAgent}
            // Folder
            folderFilter={folderFilter}
            folders={folders}
            folderCounts={folderCounts}
            onFolderFilterChange={setFolderFilter}
            // Date
            dateFilter={dateFilter}
            onDateFilterChange={setDateFilterPersisted}
            // Active minutes
            activeFilter={activeFilter}
            onActiveFilterChange={setActiveFilter}
            // Sort
            sort={sort}
            onSortChange={setSort}
            // View mode
            viewMode={viewMode}
            onViewModeChange={setViewModePersisted}
            contentSearchActive={contentSearchActive}
            // Counters
            totalSessions={sessions.length}
            filteredCount={filtered.length}
            i={s}
          />

          {/* Content — three modes:
              1. CONTENT SEARCH (search.trim().length >= 2) → SearchResultsList
              2. GROUPED VIEW (viewMode === "grouped" && !search) → date-grouped sections
              3. FLAT VIEW (viewMode === "flat" || filter active) → flat sorted list
           */}
          {contentSearchActive ? (
            <SearchResultsList
              results={contentResults}
              loading={contentSearching}
              error={contentSearchError}
              query={trimmedSearch}
              onOpen={(key) => void handleOpen(key)}
            />
          ) : sessions.length === 0 && !busy ? (
            <EmptyState
              icon={Sparkles}
              title={s.emptyTitle}
              subtitle={s.emptySubtitle}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={s.emptyAfterFilterTitle}
              subtitle={s.emptyAfterFilterSubtitle}
            />
          ) : viewMode === "grouped" ? (
            <GroupedSessionList
              sessions={filtered}
              now={now}
              activeKey={activeKey}
              bulkMode={bulkMode}
              selectedKeys={selectedKeys}
              pendingDelete={pendingDelete}
              onOpen={(k) => void handleOpen(k)}
              onOpenDetail={(k) => setDrawerKey(k)}
              onDelete={(k) => handleDeleteClick(k)}
              onToggleSelect={(k) => toggleSelect(k)}
              onCancelDelete={cancelDelete}
              folders={folders}
              sessionFolders={sessionFolders}
              agentLabels={agentLabels}
              showAgentBadge={showAgentBadge}
            />
          ) : viewMode === "folder" ? (
            <FolderGroupedList
              sessions={filtered}
              now={now}
              activeKey={activeKey}
              bulkMode={bulkMode}
              selectedKeys={selectedKeys}
              pendingDelete={pendingDelete}
              onOpen={(k) => void handleOpen(k)}
              onOpenDetail={(k) => setDrawerKey(k)}
              onDelete={(k) => handleDeleteClick(k)}
              onToggleSelect={(k) => toggleSelect(k)}
              onCancelDelete={cancelDelete}
              folders={folders}
              sessionFolders={sessionFolders}
              agentLabels={agentLabels}
              showAgentBadge={showAgentBadge}
            />
          ) : (
            <ul className="flex flex-col gap-2.5 pb-20">
              {filtered.map((session, idx) => {
                const folderId = sessionFolders[session.key];
                const folder = folderId
                  ? folderById.get(folderId)
                  : null;
                return (
                <li key={session.key}>
                  <SessionCard
                    session={session}
                    selected={selectedKeys.has(session.key)}
                    isActive={session.key === activeKey}
                    bulkMode={bulkMode}
                    index={idx}
                    now={now}
                    onOpen={() => void handleOpen(session.key)}
                    onOpenDetail={() => setDrawerKey(session.key)}
                    onDelete={() => handleDeleteClick(session.key)}
                    onToggleSelect={() => toggleSelect(session.key)}
                    folderName={folder?.name ?? null}
                    folderEmoji={folder?.emoji ?? null}
                    agentLabels={agentLabels}
                    showAgentBadge={showAgentBadge}
                  />
                  {pendingDelete === session.key ? (
                    <div className="ml-1 mt-1.5 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-1.5 text-[11px] text-red-100">
                      <span>Klik sekali lagi untuk konfirmasi hapus.</span>
                      <button
                        type="button"
                        onClick={cancelDelete}
                        className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-200/80 hover:text-red-100"
                      >
                        Batal
                      </button>
                    </div>
                  ) : null}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Bulk action bar — floating bottom */}
      {bulkMode && selectedKeys.size > 0 ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4"
          role="region"
          aria-label="Bulk actions"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-cyan-400/30 bg-[#0B0E14]/95 px-4 py-2 shadow-[0_20px_50px_-15px_rgba(34,211,238,0.45)] backdrop-blur-xl">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/85">
              {selectedKeys.size} {s.bulkSelectedCount}
            </span>
            <button
              type="button"
              onClick={() => setSelectedKeys(new Set())}
              className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-white/70 hover:text-white"
            >
              {s.bulkClearSelection}
            </button>
            {/* Move to folder dropdown */}
            <BulkMoveToFolder
              folders={folders}
              onMove={async (folderId) => {
                const keys = Array.from(selectedKeys);
                await useAppStore
                  .getState()
                  .bulkAssignFolder(keys, folderId);
                setSelectedKeys(new Set());
              }}
            />
            <button
              type="button"
              onClick={() => void handleBulkDelete()}
              aria-label={bulkDeleteArmed ? "Klik lagi untuk konfirmasi hapus" : s.bulkDeleteAll}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold text-white hover:brightness-110",
                bulkDeleteArmed
                  ? "bg-red-600 shadow-[0_8px_20px_-6px_rgba(239,68,68,0.8)] ring-2 ring-red-400/60"
                  : "bg-gradient-to-r from-red-500 to-rose-500 shadow-[0_8px_20px_-6px_rgba(239,68,68,0.55)]",
              )}
            >
              <Trash2 className="size-3" aria-hidden />
              {bulkDeleteArmed ? "Yakin? Klik lagi" : s.bulkDeleteAll}
            </button>
          </div>
          {bulkDeleteError ? (
            <div
              role="alert"
              className="pointer-events-auto mt-2 rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-center text-[11px] text-red-100"
            >
              {bulkDeleteError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Drawer */}
      <SessionDetailDrawer
        open={drawerKey !== null}
        session={drawerSession}
        now={now}
        onClose={() => setDrawerKey(null)}
        onOpen={() => {
          if (drawerSession) {
            void handleOpen(drawerSession.key);
            setDrawerKey(null);
          }
        }}
        onDelete={() => {
          if (drawerSession) handleDeleteClick(drawerSession.key);
        }}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//  SearchResultsList — content search mode (Phase 2)
// ────────────────────────────────────────────────────────────────────────
//
// Hermes Desktop parity from Sessions.tsx:296-336. When user types ≥2
// chars, we switch to this list rendering style: title + highlighted
// snippet excerpt + meta row. Click → open session.
//
// SECURITY note on `dangerouslySetInnerHTML`: the `snippetHtml` field
// comes from the bridge `sessions.search` handler which HTML-escapes
// the snippet content BEFORE wrapping the matched substring in
// `<mark>...</mark>` (see `_html_escape` in rpc_router.py). Session
// content itself is user-typed but escaped, so injection is not
// possible through this path.
function SearchResultsList({
  results,
  loading,
  error,
  query,
  onOpen,
}: {
  results: SessionSearchResult[];
  loading: boolean;
  error?: string | null;
  query: string;
  onOpen: (key: string) => void;
}) {
  if (loading && results.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          Mencari "{query}"...
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/[0.06] px-6 py-12 text-center backdrop-blur-md">
        <Search className="mx-auto mb-3 size-8 text-red-300/60" aria-hidden />
        <p className="text-[14px] font-medium text-white/90">Pencarian gagal</p>
        <p className="mx-auto mt-1.5 max-w-md break-words text-[12px] text-red-200/80">{error}</p>
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div role="status" aria-live="polite" className="rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 px-6 py-12 text-center backdrop-blur-md">
        <Search
          className="mx-auto mb-3 size-8 text-white/30"
          aria-hidden
        />
        <p className="text-[14px] font-medium text-white/85">
          Tidak ada sesi yang cocok dengan &quot;{query}&quot;
        </p>
        <p className="mt-1.5 text-[12px] text-white/55">
          Coba kata kunci lain, cek ejaan, atau gunakan kata yang lebih umum.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 pb-20">
      <div role="status" aria-live="polite" className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
        <span>
          <span className="text-cyan-300/90">{results.length}</span> sesi
          ditemukan
        </span>
        {loading ? (
          <RefreshCw className="size-3 animate-spin text-cyan-300/60" aria-hidden />
        ) : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {results.map((r) => (
          <li key={r.sessionKey}>
            <button
              type="button"
              onClick={() => onOpen(r.sessionKey)}
              className="group flex w-full flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-[#0B0E14]/40 px-4 py-3 text-left backdrop-blur-md transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.04]"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="line-clamp-1 text-[13px] font-semibold text-white/95 group-hover:text-cyan-100">
                  {r.title}
                </p>
                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/40">
                  {new Date(r.updatedAt).toLocaleDateString("id-ID", {
                    day: "2-digit",
                    month: "short",
                  })}
                </span>
              </div>
              <p
                className="line-clamp-2 text-[12px] leading-relaxed text-white/65 [&_mark]:rounded-sm [&_mark]:bg-amber-300/35 [&_mark]:px-0.5 [&_mark]:text-amber-50 [&_mark]:shadow-[inset_0_-1px_0_rgba(252,211,77,0.55)]"
                dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
              />
              <div className="flex items-center gap-2.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
                {r.source ? (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-cyan-300/80">
                    {r.source}
                  </span>
                ) : null}
                <span>
                  {r.messageCount} {r.messageCount === 1 ? "pesan" : "pesan"}
                </span>
                <span>·</span>
                <span className="text-cyan-300/70">
                  {r.matchCount} cocok
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//  GroupedSessionList — date-grouped sections (Phase 3)
// ────────────────────────────────────────────────────────────────────────
//
// Hermes Desktop parity from Sessions.tsx:344-363. Sessions partitioned
// into 4 calendar buckets (Today/Yesterday/This Week/Earlier) with
// section headers. Empty buckets hidden.
const GROUP_LABELS_ID: Record<SessionDateGroup, string> = {
  today: "Hari Ini",
  yesterday: "Kemarin",
  thisWeek: "Minggu Ini",
  earlier: "Sebelumnya",
};

function GroupedSessionList({
  sessions,
  now,
  activeKey,
  bulkMode,
  selectedKeys,
  pendingDelete,
  onOpen,
  onOpenDetail,
  onDelete,
  onToggleSelect,
  onCancelDelete,
  folders,
  sessionFolders,
  agentLabels,
  showAgentBadge,
}: {
  sessions: SessionSummary[];
  now: number;
  activeKey: string;
  bulkMode: boolean;
  selectedKeys: Set<string>;
  pendingDelete: string | null;
  onOpen: (key: string) => void;
  onOpenDetail: (key: string) => void;
  onDelete: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onCancelDelete: () => void;
  folders: SessionFolder[];
  sessionFolders: Record<string, string>;
  agentLabels?: Record<string, { label: string; emoji: string }>;
  showAgentBadge?: boolean;
}) {
  const grouped = useMemo(
    () => groupSessionsByDate(sessions, now),
    [sessions, now],
  );
  return (
    <div className="flex flex-col gap-5 pb-20">
      {SESSION_DATE_GROUP_ORDER.map((group) => {
        const rows = grouped[group];
        if (rows.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/85">
              <Calendar className="size-3" aria-hidden />
              {GROUP_LABELS_ID[group]}
              <span className="text-white/35">
                · {rows.length}
              </span>
            </h3>
            <ul className="flex flex-col gap-2.5">
              {rows.map((session, idx) => {
                const folderId = sessionFolders[session.key];
                const folder = folderId
                  ? folders.find((f) => f.id === folderId)
                  : null;
                return (
                <li key={session.key}>
                  <SessionCard
                    session={session}
                    selected={selectedKeys.has(session.key)}
                    isActive={session.key === activeKey}
                    bulkMode={bulkMode}
                    index={idx}
                    now={now}
                    folderName={folder?.name ?? null}
                    folderEmoji={folder?.emoji ?? null}
                    onOpen={() => onOpen(session.key)}
                    onOpenDetail={() => onOpenDetail(session.key)}
                    onDelete={() => onDelete(session.key)}
                    onToggleSelect={() => onToggleSelect(session.key)}
                    agentLabels={agentLabels}
                    showAgentBadge={showAgentBadge}
                  />
                  {pendingDelete === session.key ? (
                    <div className="ml-1 mt-1.5 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-1.5 text-[11px] text-red-100">
                      <span>Klik sekali lagi untuk konfirmasi hapus.</span>
                      <button
                        type="button"
                        onClick={onCancelDelete}
                        className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-200/80 hover:text-red-100"
                      >
                        Batal
                      </button>
                    </div>
                  ) : null}
                </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//  FolderGroupedList — sessions grouped by folder (NEW 2026-05-26)
//  Renders one section per folder, with "Tanpa folder" at bottom.
//  Empty folders are still rendered so chief sees them (with "Kosong"
//  placeholder + count 0) — visible affordance for "this folder exists,
//  put stuff in it".
// ────────────────────────────────────────────────────────────────────────
function FolderGroupedList({
  sessions,
  now,
  activeKey,
  bulkMode,
  selectedKeys,
  pendingDelete,
  onOpen,
  onOpenDetail,
  onDelete,
  onToggleSelect,
  onCancelDelete,
  folders,
  sessionFolders,
  agentLabels,
  showAgentBadge,
}: {
  sessions: SessionSummary[];
  now: number;
  activeKey: string;
  bulkMode: boolean;
  selectedKeys: Set<string>;
  pendingDelete: string | null;
  onOpen: (key: string) => void;
  onOpenDetail: (key: string) => void;
  onDelete: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onCancelDelete: () => void;
  folders: SessionFolder[];
  sessionFolders: Record<string, string>;
  agentLabels?: Record<string, { label: string; emoji: string }>;
  showAgentBadge?: boolean;
}) {
  // Group sessions by folder. Preserve incoming order (already sorted).
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

  const sections: Array<{
    id: string;
    title: string;
    emoji: string;
    description: string | null;
    rows: SessionSummary[];
    tone: "indigo" | "amber";
  }> = [];
  for (const f of folders) {
    sections.push({
      id: f.id,
      title: f.name,
      emoji: f.emoji ?? "📁",
      description: f.description ?? null,
      rows: byFolder[f.id] ?? [],
      tone: "indigo",
    });
  }
  if (unfoldered.length > 0) {
    sections.push({
      id: "__unfoldered__",
      title: "Tanpa folder",
      emoji: "📂",
      description: "Sesi yang belum dikelompokkan ke folder apapun",
      rows: unfoldered,
      tone: "amber",
    });
  }

  if (sections.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-[13px] text-white/55">
          Belum ada folder. Buat folder dari sidebar Chat untuk
          mengelompokkan sesi berdasarkan project.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-20">
      {sections.map((sec) => (
        <section key={sec.id} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3
              className={cn(
                "flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]",
                sec.tone === "amber"
                  ? "text-amber-300/90"
                  : "text-indigo-300/90",
              )}
            >
              <span aria-hidden className="text-[15px] leading-none">
                {sec.emoji}
              </span>
              {sec.title}
              <span className="text-white/35">· {sec.rows.length}</span>
            </h3>
            {sec.description ? (
              <p className="text-[11px] text-white/45">{sec.description}</p>
            ) : null}
          </div>
          {sec.rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-[11.5px] text-white/45">
              Folder ini kosong — pindahkan sesi ke sini dari sidebar Chat
              atau via bulk action.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {sec.rows.map((session, idx) => {
                const folderId = sessionFolders[session.key];
                const folder = folderId
                  ? folders.find((f) => f.id === folderId)
                  : null;
                return (
                  <li key={session.key}>
                    <SessionCard
                      session={session}
                      selected={selectedKeys.has(session.key)}
                      isActive={session.key === activeKey}
                      bulkMode={bulkMode}
                      index={idx}
                      now={now}
                      folderName={folder?.name ?? null}
                      folderEmoji={folder?.emoji ?? null}
                      onOpen={() => onOpen(session.key)}
                      onOpenDetail={() => onOpenDetail(session.key)}
                      onDelete={() => onDelete(session.key)}
                      onToggleSelect={() => onToggleSelect(session.key)}
                      agentLabels={agentLabels}
                      showAgentBadge={showAgentBadge}
                    />
                    {pendingDelete === session.key ? (
                      <div className="ml-1 mt-1.5 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-1.5 text-[11px] text-red-100">
                        <span>Klik sekali lagi untuk konfirmasi hapus.</span>
                        <button
                          type="button"
                          onClick={onCancelDelete}
                          className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-200/80 hover:text-red-100"
                        >
                          Batal
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//  BulkMoveToFolder — dropdown for bulk action toolbar
// ────────────────────────────────────────────────────────────────────────
function BulkMoveToFolder({
  folders,
  onMove,
}: {
  folders: SessionFolder[];
  onMove: (folderId: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-indigo-400/40 bg-indigo-400/10 px-3 py-1 text-[11px] font-semibold text-indigo-100 transition hover:border-indigo-400/60 hover:bg-indigo-400/15"
      >
        <span className="text-[12px]">📁</span>
        Pindahkan
      </button>
      {open ? (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-[220px] overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 shadow-[0_-12px_30px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          <p className="border-b border-white/[0.06] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
            Pindah ke folder
          </p>
          <ul className="max-h-[240px] overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={async () => {
                  setOpen(false);
                  await onMove(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] text-white/85 hover:bg-white/[0.05]"
              >
                <span className="text-[12px]">📂</span>
                Tanpa folder
              </button>
            </li>
            {folders.length === 0 ? (
              <li>
                <p className="px-3 py-2 text-[10.5px] text-white/35">
                  Belum ada folder. Buat dulu di sidebar Chat.
                </p>
              </li>
            ) : (
              folders.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={async () => {
                      setOpen(false);
                      await onMove(f.id);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] text-white/85 hover:bg-white/[0.05]"
                  >
                    <span className="text-[12px]">{f.emoji ?? "📁"}</span>
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
