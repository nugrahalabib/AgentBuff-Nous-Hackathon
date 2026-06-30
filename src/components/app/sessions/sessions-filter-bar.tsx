"use client";

/**
 * SessionsFilterBar — UX-overhauled filter UI for `/app/sessions`.
 *
 * Design rationale (replaces the old single-row crowded layout):
 *
 *  Row 1: SEARCH (prominent, full-width) + [⚙ Filter] button (with count
 *         badge when active) + [Grup|Flat] view-mode toggle (always
 *         visible to the right). One row, mass-market focus.
 *
 *  Row 2: KIND CHIPS — Semua / Chat Pribadi / Grup / Global. Primary
 *         "navigation" filter, biggest visual weight after search.
 *
 *  Row 3: ACTIVE FILTER CHIPS — only shown when something is filtered.
 *         Each chip is independently removable (✕). Counter + "Reset
 *         semua" right-aligned. Mass-market user can see "ohh, ini lagi
 *         di-filter apa" at a glance and clear any one in 1 click.
 *
 *  Filter popover (opens from ⚙ Filter button):
 *    - Tanggal: 6 preset pills (Semua / Hari ini / Kemarin / 7 hari /
 *      30 hari / Pilih sendiri). "Pilih sendiri" reveals inline
 *      date inputs (locale dd/mm/yyyy via browser).
 *    - Aktif Terakhir: 4 preset pills.
 *    - Urutan: 4 sort options.
 *    - Footer: [Reset Semua] right-aligned.
 *    - Click outside closes (auto-apply, no "Apply" button needed).
 *    - Esc closes.
 *
 * No animation tricks — just clean blocks, lots of spacing, and a clear
 * info hierarchy. Mass-market UMKM users should be able to use this
 * without reading any docs.
 */

import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  CalendarDays,
  Check,
  LayoutList,
  RefreshCw,
  Search as SearchIcon,
  SlidersHorizontal,
  X,
  Zap,
  ArrowDownUp,
} from "lucide-react";
import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SessionFolder } from "@/lib/app/store";

// ─── Types (re-exported here for the parent to import) ────────────────────

// "global" removed — Hermes doesn't have this concept (OpenClaw legacy).
export type KindFilter = "all" | "direct" | "group" | "unknown";
export type SortKey =
  | "updatedDesc"
  | "updatedAsc"
  | "title"
  | "key"
  | "tokens";
export type ActiveFilter = "any" | "5" | "60" | "1440";
export type DatePreset =
  | "any"
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "custom";
export type DateFilterState = {
  preset: DatePreset;
  from: string;
  to: string;
};
// ViewMode — controls how the session list is laid out in /app/sessions:
//   "grouped" = by date (Hari Ini / Kemarin / Minggu Ini / Earlier)
//   "folder"  = by folder (Tanpa folder + each folder, NEW 2026-05-26)
//   "flat"    = single list, ordered by sort key
export type ViewMode = "grouped" | "folder" | "flat";

// ChannelFilter — filter by raw `source` (tui/cli/api_server/telegram/whatsapp/...).
// "any" = no filter. Other values match `session.source === ChannelFilter`.
export type ChannelFilter = string;

// AgentFilter — filter by the owning agent id (normalized; "main"→"default").
// "any" = no filter. Other values match agentIdFromSessionKey(session.key).
export type AgentFilter = string;

// FolderFilter — filter by folder assignment.
//   "any"            = no filter (show all)
//   "__unfoldered__" = sessions without folder
//   <folderId>       = sessions in that folder
export type FolderFilter = string;
export const FOLDER_FILTER_UNFOLDERED = "__unfoldered__";

// User-friendly labels per source. Lower-case keys to match bridge output.
// Covers all 24 channels Hermes 0.14 supports. New channels auto-show in the
// popover when first session lands; if a new platform is added upstream
// (gateway/platforms/<name>.py), it'll appear with the title-case fallback
// + generic 📨 icon — add a mapping here for proper UX polish.
export const CHANNEL_LABELS: Record<string, { label: string; emoji: string }> = {
  // App / Dev surfaces
  tui: { label: "AgentBuff App", emoji: "💻" },
  cli: { label: "CLI", emoji: "🖥" },
  api_server: { label: "API", emoji: "🔌" },
  chat: { label: "Web Chat", emoji: "💬" },
  webhook: { label: "Webhook", emoji: "🪝" },

  // Mainstream messaging
  telegram: { label: "Telegram", emoji: "✈️" },
  whatsapp: { label: "WhatsApp", emoji: "🟢" },
  discord: { label: "Discord", emoji: "🎮" },
  slack: { label: "Slack", emoji: "💼" },
  signal: { label: "Signal", emoji: "🔒" },
  matrix: { label: "Matrix", emoji: "🟫" },
  teams: { label: "Teams", emoji: "🟪" },
  line: { label: "LINE", emoji: "🟩" },
  irc: { label: "IRC", emoji: "📡" },
  mattermost: { label: "Mattermost", emoji: "🟦" },
  simplex: { label: "SimpleX", emoji: "🟧" },

  // Google ecosystem
  "google-chat": { label: "Google Chat", emoji: "🔵" },
  googlechat: { label: "Google Chat", emoji: "🔵" },
  google_chat: { label: "Google Chat", emoji: "🔵" },

  // Email / SMS / Microsoft
  email: { label: "Email", emoji: "📧" },
  sms: { label: "SMS", emoji: "📱" },
  msgraph_webhook: { label: "MS Graph", emoji: "🟦" },
  bluebubbles: { label: "iMessage", emoji: "💬" },

  // Smart home
  homeassistant: { label: "Home Assistant", emoji: "🏠" },

  // China-region platforms
  dingtalk: { label: "DingTalk", emoji: "🔔" },
  feishu: { label: "Feishu / Lark", emoji: "🪶" },
  wecom: { label: "WeCom", emoji: "🟢" },
  wecom_callback: { label: "WeCom Callback", emoji: "🟢" },
  weixin: { label: "WeChat", emoji: "💚" },
  qqbot: { label: "QQ", emoji: "🐧" },
  yuanbao: { label: "Yuanbao", emoji: "🔷" },
};

export function channelLabel(source: string | null | undefined): string {
  if (!source) return "Lainnya";
  const meta = CHANNEL_LABELS[source.toLowerCase()];
  if (meta) return meta.label;
  // Fallback: title-case the raw source
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function channelEmoji(source: string | null | undefined): string {
  if (!source) return "❔";
  return CHANNEL_LABELS[source.toLowerCase()]?.emoji ?? "📨";
}

type I = {
  searchPlaceholder: string;
  filterAll: string;
  filterDirect: string;
  filterGroup: string;
  filterGlobal: string;
  filterActiveAny: string;
  filterActive5: string;
  filterActive60: string;
  filterActive1440: string;
  filterActiveMinutes: string;
  sortUpdatedDesc: string;
  sortUpdatedAsc: string;
  sortTokens: string;
  sortTitle: string;
  totalSessions: string;
  totalFiltered: string;
};

interface Props {
  // Search
  search: string;
  onSearchChange: (next: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  contentSearching: boolean;
  // Kind
  kind: KindFilter;
  kindCounts: Record<KindFilter, number>;
  onKindChange: (next: KindFilter) => void;
  // Channel (raw source filter)
  channel: ChannelFilter;
  channelCounts: Record<string, number>;
  onChannelChange: (next: ChannelFilter) => void;
  // Agent (owning-agent filter) — popover section only renders when 2+ agents.
  agent: AgentFilter;
  agentCounts: Record<string, number>;
  agentLabels: Record<string, { label: string; emoji: string }>;
  onAgentChange: (next: AgentFilter) => void;
  // Folder filter
  folderFilter: FolderFilter;
  folders: SessionFolder[];
  folderCounts: Record<string, number>; // folderId → count, plus "__unfoldered__"
  onFolderFilterChange: (next: FolderFilter) => void;
  // Date
  dateFilter: DateFilterState;
  onDateFilterChange: (next: DateFilterState) => void;
  // Active minutes
  activeFilter: ActiveFilter;
  onActiveFilterChange: (next: ActiveFilter) => void;
  // Sort
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
  // View
  viewMode: ViewMode;
  onViewModeChange: (next: ViewMode) => void;
  contentSearchActive: boolean;
  // Counters
  totalSessions: number;
  filteredCount: number;
  i: I;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function dateFilterLabel(state: DateFilterState): string {
  switch (state.preset) {
    case "today":
      return "Hari ini";
    case "yesterday":
      return "Kemarin";
    case "7d":
      return "7 hari terakhir";
    case "30d":
      return "30 hari terakhir";
    case "custom":
      if (state.from && state.to) return `${state.from} → ${state.to}`;
      if (state.from) return `Sejak ${state.from}`;
      if (state.to) return `Sampai ${state.to}`;
      return "Pilih sendiri";
    default:
      return "";
  }
}

function activeFilterLabel(value: ActiveFilter, i: I): string {
  if (value === "5") return i.filterActive5;
  if (value === "60") return i.filterActive60;
  if (value === "1440") return i.filterActive1440;
  return "";
}

function sortLabel(value: SortKey, i: I): string {
  if (value === "updatedAsc") return i.sortUpdatedAsc;
  if (value === "title") return i.sortTitle;
  if (value === "tokens") return i.sortTokens;
  return i.sortUpdatedDesc;
}

// ─── Main component ───────────────────────────────────────────────────────

export function SessionsFilterBar(props: Props) {
  const {
    search,
    onSearchChange,
    searchInputRef,
    contentSearching,
    kind,
    kindCounts,
    onKindChange,
    channel,
    channelCounts,
    onChannelChange,
    agent,
    agentCounts,
    agentLabels,
    onAgentChange,
    folderFilter,
    folders,
    folderCounts,
    onFolderFilterChange,
    dateFilter,
    onDateFilterChange,
    activeFilter,
    onActiveFilterChange,
    sort,
    onSortChange,
    viewMode,
    onViewModeChange,
    contentSearchActive,
    totalSessions,
    filteredCount,
    i,
  } = props;

  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);

  // Close popover on Escape + click-outside, with focus trap + focus restore.
  useEffect(() => {
    if (!filterOpen) return;
    const FOCUSABLE =
      'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFilterOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const root = filterPopoverRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        filterPopoverRef.current?.contains(target) ||
        filterAnchorRef.current?.contains(target)
      ) {
        return;
      }
      setFilterOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    queueMicrotask(() => filterPopoverRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
      // Restore focus to the trigger (or whatever was focused before).
      (filterAnchorRef.current ?? prevFocus)?.focus?.();
    };
  }, [filterOpen]);

  // Active "advanced" filter count — only counts filters INSIDE the popover
  // (channel + date + active + sort). Folder is on the main pills row, kind
  // chips are on their own row, so neither contributes to the popover badge.
  const activeAdvancedCount = useMemo(() => {
    let n = 0;
    if (channel !== "any") n++;
    if (agent !== "any") n++;
    if (dateFilter.preset !== "any") n++;
    if (activeFilter !== "any") n++;
    if (sort !== "updatedDesc") n++;
    return n;
  }, [channel, agent, dateFilter.preset, activeFilter, sort]);

  const hasAnyChip = activeAdvancedCount > 0 || kind !== "all";
  const filteredDelta = filteredCount !== totalSessions;

  const resetAll = useCallback(() => {
    onKindChange("all");
    onChannelChange("any");
    onAgentChange("any");
    onFolderFilterChange("any");
    onDateFilterChange({ preset: "any", from: "", to: "" });
    onActiveFilterChange("any");
    onSortChange("updatedDesc");
  }, [
    onKindChange,
    onChannelChange,
    onAgentChange,
    onFolderFilterChange,
    onDateFilterChange,
    onActiveFilterChange,
    onSortChange,
  ]);

  return (
    <section className="space-y-3">
      {/* ROW 1: Search + Filter + View toggle */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search — wide, gradient focus glow */}
        <div className="relative min-w-[260px] flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-white/35"
          />
          <input
            ref={searchInputRef}
            type="search"
            aria-label={i.searchPlaceholder}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search.length > 0) {
                e.preventDefault();
                onSearchChange("");
                searchInputRef.current?.focus();
              }
            }}
            placeholder={i.searchPlaceholder + " (Ctrl+K)"}
            className={cn(
              "w-full rounded-xl border bg-black/30 py-2.5 pl-10 pr-9 text-sm text-white/90 placeholder:text-white/35 transition",
              "border-white/10 hover:border-white/20",
              "focus:border-cyan-400/60 focus:bg-black/40 focus:outline-none focus:shadow-[0_0_0_3px_rgba(34,211,238,0.12)]",
            )}
          />
          {contentSearching ? (
            <RefreshCw
              aria-hidden
              className="pointer-events-none absolute right-9 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-cyan-300/70"
            />
          ) : null}
          {search.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onSearchChange("");
                searchInputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-white/40 hover:bg-white/[0.08] hover:text-white/85"
              aria-label="Hapus pencarian"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        {/* Filter button + popover */}
        <div className="relative">
          <button
            ref={filterAnchorRef}
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition",
              filterOpen || activeAdvancedCount > 0
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100 shadow-[0_0_0_3px_rgba(34,211,238,0.08)]"
                : "border-white/10 bg-white/[0.03] text-white/80 hover:border-white/20 hover:bg-white/[0.06] hover:text-white",
            )}
            aria-expanded={filterOpen}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            <span>Filter</span>
            {activeAdvancedCount > 0 ? (
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[10px] font-bold text-[#0B0E14]">
                {activeAdvancedCount}
              </span>
            ) : null}
          </button>

          <AnimatePresence>
            {filterOpen ? (
              <motion.div
                ref={filterPopoverRef}
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className={cn(
                  "absolute right-0 top-full z-30 mt-2 w-[min(380px,calc(100vw-2rem))] origin-top-right",
                  "rounded-2xl border border-white/10 bg-[#0B0E14]/95 p-4 backdrop-blur-xl",
                  "shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]",
                )}
                role="dialog"
                aria-label="Filter lanjutan"
              >
                <FilterPopoverBody
                  channel={channel}
                  channelCounts={channelCounts}
                  onChannelChange={onChannelChange}
                  agent={agent}
                  agentCounts={agentCounts}
                  agentLabels={agentLabels}
                  onAgentChange={onAgentChange}
                  dateFilter={dateFilter}
                  onDateFilterChange={onDateFilterChange}
                  activeFilter={activeFilter}
                  onActiveFilterChange={onActiveFilterChange}
                  sort={sort}
                  onSortChange={onSortChange}
                  onResetAll={resetAll}
                  hasAnyAdvanced={activeAdvancedCount > 0}
                  i={i}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* View toggle — only when not in content search.
            3 modes: Grup (date) · Folder (project) · Flat (single list). */}
        {!contentSearchActive ? (
          <div className="inline-flex items-center gap-0.5 rounded-xl border border-white/10 bg-black/30 p-1">
            <button
              type="button"
              onClick={() => onViewModeChange("grouped")}
              title="Kelompokkan berdasarkan tanggal"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                viewMode === "grouped"
                  ? "bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.3)]"
                  : "text-white/55 hover:text-white",
              )}
            >
              <Calendar className="size-3.5" aria-hidden />
              <span>Tanggal</span>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("folder")}
              title="Kelompokkan berdasarkan folder"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                viewMode === "folder"
                  ? "bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.3)]"
                  : "text-white/55 hover:text-white",
              )}
            >
              <span aria-hidden className="text-[13px] leading-none">📁</span>
              <span>Folder</span>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("flat")}
              title="Tampilan datar (urutan dari Filter)"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
                viewMode === "flat"
                  ? "bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.3)]"
                  : "text-white/55 hover:text-white",
              )}
            >
              <LayoutList className="size-3.5" aria-hidden />
              <span>Flat</span>
            </button>
          </div>
        ) : null}
      </div>

      {/* ROW 2: Kind chips — primary navigation filter
          "global" removed (Hermes doesn't have this concept). "group" kept
          even when count=0 since future channel sessions could populate it. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["all", i.filterAll],
            ["direct", i.filterDirect],
            ["group", i.filterGroup],
          ] as const
        ).map(([k, label]) => {
          const active = kind === k;
          const count = kindCounts[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onKindChange(k)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                active
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100 shadow-[0_0_12px_-2px_rgba(34,211,238,0.4)]"
                  : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:bg-white/[0.06] hover:text-white",
              )}
            >
              <span>{label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  active
                    ? "bg-cyan-400/20 text-cyan-50"
                    : "bg-white/[0.06] text-white/45",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ROW 2.5: Folder pills — only when viewMode === "folder".
          Hidden in Tanggal/Flat view to keep the bar uncluttered.
          When chief picks "Folder" view mode, this row appears so they
          can quick-filter to specific folder without opening popover. */}
      {viewMode === "folder" &&
      (folders.length > 0 ||
        (folderCounts[FOLDER_FILTER_UNFOLDERED] ?? 0) > 0) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/40">
            Folder:
          </span>
          <button
            type="button"
            onClick={() => onFolderFilterChange("any")}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
              folderFilter === "any"
                ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100 shadow-[0_0_10px_-2px_rgba(34,211,238,0.35)]"
                : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white",
            )}
          >
            Semua
          </button>
          {(folderCounts[FOLDER_FILTER_UNFOLDERED] ?? 0) > 0 ? (
            <button
              type="button"
              onClick={() => onFolderFilterChange(FOLDER_FILTER_UNFOLDERED)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                folderFilter === FOLDER_FILTER_UNFOLDERED
                  ? "border-amber-400/50 bg-amber-400/10 text-amber-100 shadow-[0_0_10px_-2px_rgba(251,191,36,0.35)]"
                  : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white",
              )}
              title="Sesi yang belum dimasukkan ke folder apapun"
            >
              <span aria-hidden>📂</span>
              <span>Tanpa folder</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  folderFilter === FOLDER_FILTER_UNFOLDERED
                    ? "bg-amber-400/20 text-amber-50"
                    : "bg-white/[0.06] text-white/45",
                )}
              >
                {folderCounts[FOLDER_FILTER_UNFOLDERED]}
              </span>
            </button>
          ) : null}
          {folders.map((f) => {
            const count = folderCounts[f.id] ?? 0;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onFolderFilterChange(f.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                  folderFilter === f.id
                    ? "border-indigo-400/50 bg-indigo-400/10 text-indigo-100 shadow-[0_0_10px_-2px_rgba(99,102,241,0.35)]"
                    : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white",
                )}
                title={`Lihat ${count} sesi di "${f.name}"`}
              >
                <span aria-hidden>{f.emoji ?? "📁"}</span>
                <span className="truncate max-w-[140px]">{f.name}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] tabular-nums",
                    folderFilter === f.id
                      ? "bg-indigo-400/20 text-indigo-50"
                      : "bg-white/[0.06] text-white/45",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* ROW 3: Active filter chips + counter (conditional) */}
      {(hasAnyChip || filteredDelta) ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.04] pt-2.5">
          {/* Counter — left side */}
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/45">
            {totalSessions} {i.totalSessions}
            {filteredDelta ? (
              <span className="ml-2 text-cyan-300/85">
                · {filteredCount} {i.totalFiltered}
              </span>
            ) : null}
          </span>

          {/* Active chips */}
          {channel !== "any" ? (
            <ChipRemovable
              icon={<span className="text-[10px]">{channelEmoji(channel)}</span>}
              label={channelLabel(channel)}
              tone="fuchsia"
              onRemove={() => onChannelChange("any")}
            />
          ) : null}
          {agent !== "any" ? (
            <ChipRemovable
              icon={
                <span className="text-[10px]">
                  {agentLabels[agent]?.emoji ?? "🤖"}
                </span>
              }
              label={agentLabels[agent]?.label ?? agent}
              tone="cyan"
              onRemove={() => onAgentChange("any")}
            />
          ) : null}
          {folderFilter !== "any" ? (
            <ChipRemovable
              icon={
                <span className="text-[10px]">
                  {folderFilter === FOLDER_FILTER_UNFOLDERED
                    ? "📂"
                    : (folders.find((f) => f.id === folderFilter)?.emoji ??
                      "📁")}
                </span>
              }
              label={
                folderFilter === FOLDER_FILTER_UNFOLDERED
                  ? "Tanpa folder"
                  : (folders.find((f) => f.id === folderFilter)?.name ??
                    "Folder")
              }
              tone="indigo"
              onRemove={() => onFolderFilterChange("any")}
            />
          ) : null}
          {dateFilter.preset !== "any" ? (
            <ChipRemovable
              icon={<CalendarDays className="size-3" />}
              label={dateFilterLabel(dateFilter)}
              tone="cyan"
              onRemove={() =>
                onDateFilterChange({ preset: "any", from: "", to: "" })
              }
            />
          ) : null}
          {activeFilter !== "any" ? (
            <ChipRemovable
              icon={<Zap className="size-3" />}
              label={activeFilterLabel(activeFilter, i)}
              tone="amber"
              onRemove={() => onActiveFilterChange("any")}
            />
          ) : null}
          {sort !== "updatedDesc" ? (
            <ChipRemovable
              icon={<ArrowDownUp className="size-3" />}
              label={sortLabel(sort, i)}
              tone="indigo"
              onRemove={() => onSortChange("updatedDesc")}
            />
          ) : null}

          {/* Reset semua — right side, only when 2+ filters or any advanced */}
          {activeAdvancedCount > 0 ? (
            <button
              type="button"
              onClick={resetAll}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/65 transition hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-200"
            >
              <X className="size-3" aria-hidden />
              Reset semua
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Filter popover body ──────────────────────────────────────────────────

function FilterPopoverBody(props: {
  channel: ChannelFilter;
  channelCounts: Record<string, number>;
  onChannelChange: (next: ChannelFilter) => void;
  agent: AgentFilter;
  agentCounts: Record<string, number>;
  agentLabels: Record<string, { label: string; emoji: string }>;
  onAgentChange: (next: AgentFilter) => void;
  dateFilter: DateFilterState;
  onDateFilterChange: (next: DateFilterState) => void;
  activeFilter: ActiveFilter;
  onActiveFilterChange: (next: ActiveFilter) => void;
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
  onResetAll: () => void;
  hasAnyAdvanced: boolean;
  i: I;
}) {
  const {
    channel,
    channelCounts,
    onChannelChange,
    agent,
    agentCounts,
    agentLabels,
    onAgentChange,
    dateFilter,
    onDateFilterChange,
    activeFilter,
    onActiveFilterChange,
    sort,
    onSortChange,
    onResetAll,
    hasAnyAdvanced,
    i,
  } = props;

  // Build the list of channel options dynamically — only show channels that
  // actually have ≥1 session in the data. This avoids the "Chat Grup 0"
  // problem where dead options confuse the user. "Semua" always shown.
  const channelOptions = useMemo(() => {
    const entries = Object.entries(channelCounts).filter(([, n]) => n > 0);
    // Sort by count desc, then alpha
    entries.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }, [channelCounts]);

  const agentOptions = useMemo(() => {
    const entries = Object.entries(agentCounts).filter(([, n]) => n > 0);
    entries.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }, [agentCounts]);

  const datePresets: Array<{ value: DatePreset; label: string }> = [
    { value: "any", label: "Semua" },
    { value: "today", label: "Hari ini" },
    { value: "yesterday", label: "Kemarin" },
    { value: "7d", label: "7 hari" },
    { value: "30d", label: "30 hari" },
    { value: "custom", label: "Pilih sendiri" },
  ];

  const activePresets: Array<{ value: ActiveFilter; label: string }> = [
    { value: "any", label: i.filterActiveAny },
    { value: "5", label: i.filterActive5 },
    { value: "60", label: i.filterActive60 },
    { value: "1440", label: i.filterActive1440 },
  ];

  const sortOptions: Array<{ value: SortKey; label: string }> = [
    { value: "updatedDesc", label: i.sortUpdatedDesc },
    { value: "updatedAsc", label: i.sortUpdatedAsc },
    { value: "tokens", label: i.sortTokens },
    { value: "title", label: i.sortTitle },
  ];

  return (
    <div className="space-y-4">
      {/* TANGGAL */}
      <div>
        <SectionLabel icon={<CalendarDays className="size-3.5" />} text="Tanggal" />
        <div className="grid grid-cols-3 gap-1.5">
          {datePresets.map((opt) => {
            const active = dateFilter.preset === opt.value;
            return (
              <PillToggle
                key={opt.value}
                active={active}
                onClick={() =>
                  onDateFilterChange({
                    preset: opt.value,
                    from: opt.value === "custom" ? dateFilter.from : "",
                    to: opt.value === "custom" ? dateFilter.to : "",
                  })
                }
              >
                {opt.label}
              </PillToggle>
            );
          })}
        </div>
        {/* Custom range — only when "Pilih sendiri" selected */}
        {dateFilter.preset === "custom" ? (
          <div className="mt-2 space-y-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-2.5">
            <DateInputRow
              label="Dari"
              value={dateFilter.from}
              max={dateFilter.to || undefined}
              onChange={(next) =>
                onDateFilterChange({ ...dateFilter, from: next })
              }
            />
            <DateInputRow
              label="Sampai"
              value={dateFilter.to}
              min={dateFilter.from || undefined}
              onChange={(next) =>
                onDateFilterChange({ ...dateFilter, to: next })
              }
            />
            {(dateFilter.from || dateFilter.to) ? (
              <button
                type="button"
                onClick={() =>
                  onDateFilterChange({ preset: "custom", from: "", to: "" })
                }
                className="mt-1 text-[10.5px] font-mono uppercase tracking-[0.16em] text-white/55 transition hover:text-white"
              >
                Kosongkan
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* AGEN — only when 2+ agents own sessions (multi-agent user) */}
      {agentOptions.length > 1 ? (
        <div>
          <SectionLabel
            icon={<span className="text-[10px] leading-none">🤖</span>}
            text="Agen"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <PillToggle
              active={agent === "any"}
              onClick={() => onAgentChange("any")}
            >
              Semua agen
            </PillToggle>
            {agentOptions.map(([id, count]) => {
              const meta = agentLabels[id] ?? { label: id, emoji: "🤖" };
              return (
                <PillToggle
                  key={id}
                  active={agent === id}
                  onClick={() => onAgentChange(id)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span>{meta.emoji}</span>
                    <span className="truncate max-w-[90px]">{meta.label}</span>
                    <span
                      className={cn(
                        "rounded-full px-1 text-[9px] tabular-nums",
                        agent === id
                          ? "bg-cyan-400/20 text-cyan-50"
                          : "bg-white/[0.06] text-white/45",
                      )}
                    >
                      {count}
                    </span>
                  </span>
                </PillToggle>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* CHANNEL — dynamic list, only channels with sessions appear */}
      <div>
        <SectionLabel
          icon={<span className="text-[10px] leading-none">📨</span>}
          text="Channel"
        />
        {channelOptions.length === 0 ? (
          <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
            Belum ada channel ter-pair. Hubungkan Telegram / WhatsApp / dll lewat
            tab Saluran.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <PillToggle
              active={channel === "any"}
              onClick={() => onChannelChange("any")}
            >
              Semua channel
            </PillToggle>
            {channelOptions.map(([src, count]) => (
              <PillToggle
                key={src}
                active={channel === src}
                onClick={() => onChannelChange(src)}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span>{channelEmoji(src)}</span>
                  <span>{channelLabel(src)}</span>
                  <span
                    className={cn(
                      "rounded-full px-1 text-[9px] tabular-nums",
                      channel === src
                        ? "bg-cyan-400/20 text-cyan-50"
                        : "bg-white/[0.06] text-white/45",
                    )}
                  >
                    {count}
                  </span>
                </span>
              </PillToggle>
            ))}
          </div>
        )}
      </div>

      {/* AKTIF TERAKHIR */}
      <div>
        <SectionLabel icon={<Zap className="size-3.5" />} text="Aktif terakhir" />
        <div className="grid grid-cols-2 gap-1.5">
          {activePresets.map((opt) => {
            const active = activeFilter === opt.value;
            return (
              <PillToggle
                key={opt.value}
                active={active}
                onClick={() => onActiveFilterChange(opt.value)}
              >
                {opt.label}
              </PillToggle>
            );
          })}
        </div>
      </div>

      {/* URUTAN */}
      <div>
        <SectionLabel icon={<ArrowDownUp className="size-3.5" />} text="Urutan" />
        <div className="grid grid-cols-2 gap-1.5">
          {sortOptions.map((opt) => {
            const active = sort === opt.value;
            return (
              <PillToggle
                key={opt.value}
                active={active}
                onClick={() => onSortChange(opt.value)}
              >
                {opt.label}
              </PillToggle>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="-mx-4 -mb-4 mt-2 flex items-center justify-between rounded-b-2xl border-t border-white/[0.04] bg-white/[0.02] px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
          {hasAnyAdvanced ? "Filter aktif" : "Tidak ada filter"}
        </span>
        {hasAnyAdvanced ? (
          <button
            type="button"
            onClick={onResetAll}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-200"
          >
            <X className="size-3" aria-hidden />
            Reset semua
          </button>
        ) : (
          <span className="text-[11px] text-white/35">—</span>
        )}
      </div>
    </div>
  );
}

// ─── Small bits ───────────────────────────────────────────────────────────

function SectionLabel(props: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
      <span className="text-cyan-300/85">{props.icon}</span>
      {props.text}
    </div>
  );
}

function PillToggle(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
          : "border-white/10 bg-white/[0.03] text-white/70 hover:border-white/25 hover:bg-white/[0.06] hover:text-white",
      )}
    >
      {props.active ? <Check className="size-3" aria-hidden /> : null}
      <span>{props.children}</span>
    </button>
  );
}

function DateInputRow(props: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
        {props.label}
      </span>
      <div className="relative flex-1">
        <Calendar
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-white/40"
        />
        <input
          type="date"
          value={props.value}
          min={props.min}
          max={props.max}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-full rounded-md border border-white/10 bg-black/40 py-1.5 pl-7 pr-2 font-mono text-[11.5px] text-white/85 transition focus:border-cyan-400/50 focus:outline-none [color-scheme:dark]"
        />
      </div>
    </label>
  );
}

function ChipRemovable(props: {
  icon: React.ReactNode;
  label: string;
  tone: "cyan" | "amber" | "indigo" | "fuchsia";
  onRemove: () => void;
}) {
  const toneClass =
    props.tone === "cyan"
      ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
      : props.tone === "amber"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
        : props.tone === "fuchsia"
          ? "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100"
          : "border-indigo-400/40 bg-indigo-400/10 text-indigo-100";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        toneClass,
      )}
    >
      <span className="opacity-85">{props.icon}</span>
      <span>{props.label}</span>
      <button
        type="button"
        onClick={props.onRemove}
        className="inline-flex size-4 items-center justify-center rounded-full transition hover:bg-white/15"
        aria-label={`Hapus filter ${props.label}`}
      >
        <X className="size-2.5" aria-hidden />
      </button>
    </span>
  );
}
