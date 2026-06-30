"use client";

/**
 * Galeri (Hasil Karya) — cross-session gallery of every media artifact the
 * agent + user produced (images / audio / video / documents). Parity with the
 * Nous desktop "Artifacts" view, built BETTER on our structured attachment
 * data (4 kinds, reliable) instead of brittle text-regex, reusing the chat's
 * own thumbnail + lightbox components. Zero new bridge: scans existing
 * sessions via `refreshSessions` + `loadHistory`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  MessageSquare,
  Play,
  RotateCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useAppStore } from "@/lib/app/store";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";
import { useAgentsList } from "@/components/app/agents/use-agents-data";
import {
  getAgentDisplayName,
  getAgentEmoji,
} from "@/components/app/agents/helpers";
import {
  extractArtifactsFromSessions,
  type Artifact,
} from "@/lib/app/extract-artifacts";
import { prettyFileSize, type AttachmentKind } from "@/lib/app/attachments";

type AgentMeta = { id: string; name: string; emoji: string };
type EnrichedArtifact = Artifact & { agentId: string };
import { AttachmentLightbox } from "@/components/app/attachment-lightbox";
import {
  downloadAttachment,
  openInNewTab,
} from "@/lib/app/attachment-actions";
import { cn } from "@/lib/utils";

const SCAN_LIMIT = 40; // most-recent sessions to scan for artifacts
const SCAN_CONCURRENCY = 3; // sessions loaded per batch (gentle on the WS)

type Filter = "all" | AttachmentKind;
type DateRange = "all" | "today" | "7d" | "30d" | "custom";

/** True if `ms` falls within the selected date range. For "custom", `from`/`to`
 *  are `YYYY-MM-DD` (local day bounds); an empty bound is open-ended. */
function passesDateRange(
  ms: number,
  range: DateRange,
  from: string,
  to: string,
): boolean {
  if (range === "all") return true;
  if (range === "custom") {
    if (from) {
      const f = new Date(`${from}T00:00:00`).getTime();
      if (Number.isFinite(f) && ms < f) return false;
    }
    if (to) {
      const t = new Date(`${to}T23:59:59.999`).getTime();
      if (Number.isFinite(t) && ms > t) return false;
    }
    return true;
  }
  if (range === "today") {
    const d = new Date(ms);
    const n = new Date();
    return (
      d.getFullYear() === n.getFullYear() &&
      d.getMonth() === n.getMonth() &&
      d.getDate() === n.getDate()
    );
  }
  const days = range === "7d" ? 7 : 30;
  return Date.now() - ms <= days * 86_400_000;
}

/** Client-side relative-time. Only ever rendered AFTER the store populates
 *  (post-mount), so no SSR/hydration mismatch — tiles don't exist on the
 *  server render where the store is empty. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "baru saja";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} mnt lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} hr lalu`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} bln lalu`;
  return `${Math.floor(mon / 12)} thn lalu`;
}

const KIND_ICON: Record<AttachmentKind, typeof ImageIcon> = {
  image: ImageIcon,
  audio: FileAudio,
  video: FileVideo,
  document: FileText,
};
const KIND_ACCENT: Record<AttachmentKind, string> = {
  image: "text-cyan-300",
  audio: "text-fuchsia-300",
  video: "text-indigo-300",
  document: "text-amber-300",
};

/** Calendar-day key (local time) for grouping. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Human day-bucket label — "Hari ini" / "Kemarin" / "8 Jun 2026". */
function dayLabel(
  ms: number,
  locale: string,
  todayLabel: string,
  yesterdayLabel: string,
): string {
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(new Date(ms))) / 86_400_000,
  );
  if (diffDays <= 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  return new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

export function GaleriTab() {
  const { t, locale } = useI18n();
  const tg = t.app.galeri;
  const router = useRouter();

  const status = useAppStore((s) => s.status);
  const sessions = useAppStore((s) => s.sessions);
  const messages = useAppStore((s) => s.messages);
  const setActiveSession = useAppStore((s) => s.setActiveSession);

  const agentsQuery = useAgentsList();
  const agentList = agentsQuery.data?.agents ?? [];
  const defaultId = agentsQuery.data?.defaultId ?? "";
  // agentId → display name + emoji, so each artifact shows WHO made it.
  const agentMeta = useMemo(() => {
    const m = new Map<string, AgentMeta>();
    for (const a of agentList) {
      m.set(a.id, {
        id: a.id,
        name: getAgentDisplayName(a),
        emoji: getAgentEmoji(a) ?? "🤖",
      });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsQuery.data]);

  // A session key encodes its agent (`agent:<id>:<dbkey>`). The house agent
  // folds to the engine default id so its artifacts group under "Buff".
  const resolveAgentId = useCallback(
    (sessionKey: string): string => {
      const raw = agentIdFromSessionKey(sessionKey);
      if (!raw || raw === "main" || raw === "default") return defaultId || "default";
      return raw;
    },
    [defaultId],
  );

  const [filter, setFilter] = useState<Filter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [query, setQuery] = useState("");
  // Tiles whose media 404'd at load time — removed so a broken thumbnail never
  // gives false hope (chief: "kalau sudah hilang ga bisa dibuka jangan ditampilin").
  const [brokenIds, setBrokenIds] = useState<Set<string>>(() => new Set());
  const markBroken = useCallback((id: string) => {
    setBrokenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [firstScanDone, setFirstScanDone] = useState(false);
  const [lightbox, setLightbox] = useState<{ items: Artifact[]; index: number } | null>(
    null,
  );
  const scanStartedRef = useRef(false);

  // Scan: ensure the session list is loaded, then lazily pull each recent
  // session's transcript so its attachments become extractable. loadHistory is
  // idempotent (skips already-loaded sessions unless force), so re-visits are
  // cheap and the manual refresh re-fetches everything.
  const runScan = useCallback(async (force: boolean) => {
    setScanning(true);
    try {
      const st = useAppStore.getState();
      if (!st.sessionsLoaded || force) await st.refreshSessions();
      const recent = useAppStore.getState().sessions.slice(0, SCAN_LIMIT);
      setProgress({ done: 0, total: recent.length });
      let done = 0;
      for (let i = 0; i < recent.length; i += SCAN_CONCURRENCY) {
        const batch = recent.slice(i, i + SCAN_CONCURRENCY);
        await Promise.all(
          batch.map((s) =>
            useAppStore
              .getState()
              .loadHistory(s.key, force ? { force: true } : undefined)
              .catch(() => {}),
          ),
        );
        done += batch.length;
        setProgress({ done, total: recent.length });
      }
    } finally {
      setScanning(false);
      setProgress(null);
      setFirstScanDone(true);
    }
  }, []);

  useEffect(() => {
    if (status !== "ready" || scanStartedRef.current) return;
    scanStartedRef.current = true;
    void runScan(false);
  }, [status, runScan]);

  const artifacts = useMemo(
    () => extractArtifactsFromSessions(sessions, messages),
    [sessions, messages],
  );

  // Tag each artifact with the agent whose session produced it.
  const enriched = useMemo<EnrichedArtifact[]>(
    () => artifacts.map((a) => ({ ...a, agentId: resolveAgentId(a.sessionKey) })),
    [artifacts, resolveAgentId],
  );

  // "live" = artifacts whose media actually loaded (broken ones removed). ALL
  // counts + the agent chips derive from this so the numbers ALWAYS match what
  // is actually shown — no more "Gambar 2" while zero images render.
  const live = useMemo(
    () => enriched.filter((a) => !brokenIds.has(a.id)),
    [enriched, brokenIds],
  );

  const q = query.trim().toLowerCase();
  const matchesQuery = useCallback(
    (a: EnrichedArtifact) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.sessionTitle.toLowerCase().includes(q),
    [q],
  );

  // Faceted counts: each chip's badge respects every OTHER active axis, so the
  // number shown always equals what renders when you click it. Kind chips honour
  // date + agent + query (not kind); agent chips honour date + kind + query.
  const counts = useMemo(() => {
    const c = { all: 0, image: 0, audio: 0, video: 0, document: 0 };
    for (const a of live) {
      if (!passesDateRange(a.createdAt, dateRange, customFrom, customTo)) continue;
      if (agentFilter !== "all" && a.agentId !== agentFilter) continue;
      if (!matchesQuery(a)) continue;
      c.all += 1;
      c[a.kind] += 1;
    }
    return c;
  }, [live, dateRange, customFrom, customTo, agentFilter, matchesQuery]);

  // Agents that actually produced (still-loadable) artifacts → the agent filter.
  const agentChips = useMemo(() => {
    const counter = new Map<string, number>();
    for (const a of live) {
      if (!passesDateRange(a.createdAt, dateRange, customFrom, customTo)) continue;
      if (filter !== "all" && a.kind !== filter) continue;
      if (!matchesQuery(a)) continue;
      counter.set(a.agentId, (counter.get(a.agentId) ?? 0) + 1);
    }
    return [...counter.entries()].map(([id, count]) => {
      const meta = agentMeta.get(id);
      return { id, count, name: meta?.name ?? "Buff", emoji: meta?.emoji ?? "🤖" };
    });
  }, [live, dateRange, customFrom, customTo, filter, matchesQuery, agentMeta]);

  const filtered = useMemo(() => {
    return live.filter((a) => {
      if (filter !== "all" && a.kind !== filter) return false;
      if (agentFilter !== "all" && a.agentId !== agentFilter) return false;
      if (!passesDateRange(a.createdAt, dateRange, customFrom, customTo)) return false;
      return matchesQuery(a);
    });
  }, [live, filter, agentFilter, dateRange, customFrom, customTo, matchesQuery]);

  // Group the (already newest-first) filtered list into consecutive day
  // buckets so the gallery reads chronologically — "Hari ini", "Kemarin", then
  // dated sections — instead of one undifferentiated grid.
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: EnrichedArtifact[] }[] = [];
    for (const a of filtered) {
      const k = dayKey(a.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === k) {
        last.items.push(a);
      } else {
        out.push({
          key: k,
          label: dayLabel(a.createdAt, locale, tg.today, tg.yesterday),
          items: [a],
        });
      }
    }
    return out;
  }, [filtered, locale, tg.today, tg.yesterday]);

  const openLightbox = useCallback(
    (artifact: Artifact) => {
      // Carousel over the visible image+video items so ← → navigation works.
      const media = filtered.filter(
        (a) => a.kind === "image" || a.kind === "video",
      );
      const idx = media.findIndex((a) => a.id === artifact.id);
      setLightbox({ items: media, index: Math.max(0, idx) });
    },
    [filtered],
  );

  const openChat = useCallback(
    async (sessionKey: string) => {
      await setActiveSession(sessionKey);
      router.push("/app/chat");
    },
    [setActiveSession, router],
  );

  const filterChips: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: tg.filterAll, count: counts.all },
    { key: "image", label: tg.filterImage, count: counts.image },
    { key: "audio", label: tg.filterAudio, count: counts.audio },
    { key: "video", label: tg.filterVideo, count: counts.video },
    { key: "document", label: tg.filterDocument, count: counts.document },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-white/[0.06] bg-[#0B0E14]/40 px-5 py-4 backdrop-blur-xl sm:px-7">
        <div className="mx-auto flex w-full max-w-6xl items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-400/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/90">
              <Sparkles className="size-3" />
              {tg.eyebrow}
            </span>
            <h1 className="mt-2 font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
              {tg.title}
            </h1>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-white/55">
              {tg.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runScan(true)}
            disabled={scanning}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/80 transition",
              scanning
                ? "cursor-not-allowed opacity-50"
                : "hover:border-cyan-400/40 hover:bg-white/[0.07] hover:text-white",
            )}
          >
            <RotateCw className={cn("size-3.5", scanning && "animate-spin")} />
            {tg.refresh}
          </button>
        </div>

        {/* Search — own row, full width for prominence. */}
        <div className="mx-auto mt-4 w-full max-w-6xl">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/35" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tg.search}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-9 pr-3 text-[13px] text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none"
            />
          </div>
        </div>

        {/* Filter axes — each on its OWN labeled row so they don't cram onto a
            single wrapping line. Fixed-width label column keeps chips aligned. */}
        <div className="mx-auto mt-3 w-full max-w-6xl space-y-2">
          {/* Jenis (kind) */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
            <span className="w-12 shrink-0 pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
              {tg.groupKind}
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {filterChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setFilter(chip.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition",
                    filter === chip.key
                      ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
                      : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white/85",
                  )}
                >
                  {chip.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 font-mono text-[10px]",
                      filter === chip.key
                        ? "bg-cyan-400/20 text-cyan-200"
                        : "bg-white/[0.06] text-white/45",
                    )}
                  >
                    {chip.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Waktu (date) — custom pickers appear inline on this row when picked. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
            <span className="w-12 shrink-0 pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
              {tg.groupDate}
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {(
                [
                  { key: "all", label: tg.filterAll },
                  { key: "today", label: tg.today },
                  { key: "7d", label: tg.range7d },
                  { key: "30d", label: tg.range30d },
                  { key: "custom", label: tg.rangeCustom },
                ] as { key: DateRange; label: string }[]
              ).map((dc) => (
                <button
                  key={dc.key}
                  type="button"
                  onClick={() => setDateRange(dc.key)}
                  className={cn(
                    "inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-medium transition",
                    dateRange === dc.key
                      ? "border-indigo-400/50 bg-indigo-400/10 text-indigo-100"
                      : "border-white/10 bg-white/[0.03] text-white/55 hover:border-white/20 hover:text-white/80",
                  )}
                >
                  {dc.label}
                </button>
              ))}
              {dateRange === "custom" ? (
                <span className="ml-1 inline-flex flex-wrap items-center gap-2 text-[12px] text-white/55">
                  <label className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
                      {tg.rangeFrom}
                    </span>
                    <input
                      type="date"
                      value={customFrom}
                      max={customTo || undefined}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-white [color-scheme:dark] focus:border-cyan-400/50 focus:outline-none"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
                      {tg.rangeTo}
                    </span>
                    <input
                      type="date"
                      value={customTo}
                      min={customFrom || undefined}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-white [color-scheme:dark] focus:border-cyan-400/50 focus:outline-none"
                    />
                  </label>
                  {customFrom || customTo ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomFrom("");
                        setCustomTo("");
                      }}
                      className="text-[11px] text-white/40 transition hover:text-white/70"
                    >
                      Reset
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>

          {/* Agen — only when more than one agent has produced artifacts. */}
          {agentChips.length > 1 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
              <span className="w-12 shrink-0 pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                {t.app.nav.tabs.agents}
              </span>
              <div className="flex flex-1 flex-wrap items-center gap-1.5">
                <AgentFilterChip
                  active={agentFilter === "all"}
                  onClick={() => setAgentFilter("all")}
                  label={tg.filterAll}
                  count={counts.all}
                />
                {agentChips.map((c) => (
                  <AgentFilterChip
                    key={c.id}
                    active={agentFilter === c.id}
                    onClick={() => setAgentFilter(c.id)}
                    label={`${c.emoji} ${c.name}`}
                    count={c.count}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
        <div className="mx-auto w-full max-w-6xl">
          {status !== "ready" ? (
            <CenterNote>{tg.connecting}</CenterNote>
          ) : !firstScanDone ? (
            <CenterNote>
              <RotateCw className="size-4 animate-spin text-cyan-300" />
              {progress
                ? tg.scanningCount
                    .replace("{done}", String(progress.done))
                    .replace("{total}", String(progress.total))
                : tg.scanning}
            </CenterNote>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={artifacts.length === 0 ? tg.empty : tg.emptyFilter}
              hint={artifacts.length === 0 ? tg.emptyHint : tg.emptyFilterHint}
            />
          ) : (
            <>
              {scanning ? (
                <div className="mb-4 flex items-center gap-2 text-[11px] text-white/40">
                  <RotateCw className="size-3 animate-spin" />
                  {tg.scanningMore}
                </div>
              ) : null}
              <div className="flex flex-col gap-7">
                {groups.map((group) => (
                  <section key={group.key}>
                    <h2 className="sticky top-0 z-10 -mx-1 mb-3 flex items-center gap-2 bg-[#0B0E14]/75 px-1 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50 backdrop-blur-sm">
                      {group.label}
                      <span className="text-white/25">{group.items.length}</span>
                    </h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                      {group.items.map((artifact) => {
                        const meta = agentMeta.get(artifact.agentId);
                        return (
                          <ArtifactTile
                            key={artifact.id}
                            artifact={artifact}
                            onOpenMedia={openLightbox}
                            onOpenChat={openChat}
                            onBroken={markBroken}
                            fromUserLabel={tg.fromUser}
                            agentName={meta?.name ?? "Buff"}
                            agentEmoji={meta?.emoji ?? "🤖"}
                          />
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <AttachmentLightbox
        items={lightbox?.items ?? null}
        startIndex={lightbox?.index ?? 0}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}

function ArtifactTile({
  artifact,
  onOpenMedia,
  onOpenChat,
  onBroken,
  fromUserLabel,
  agentName,
  agentEmoji,
}: {
  artifact: Artifact;
  onOpenMedia: (a: Artifact) => void;
  onOpenChat: (sessionKey: string) => void;
  onBroken: (id: string) => void;
  fromUserLabel: string;
  agentName: string;
  agentEmoji: string;
}) {
  const Icon = KIND_ICON[artifact.kind];
  const accent = KIND_ACCENT[artifact.kind];
  const isImage = artifact.kind === "image";
  const isVisual = isImage || artifact.kind === "video";
  const fromUser = artifact.role === "user";

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition hover:border-cyan-400/30 hover:bg-white/[0.05]">
      {/* Media frame */}
      <button
        type="button"
        onClick={() =>
          isVisual ? onOpenMedia(artifact) : openInNewTab(artifact.displayUrl)
        }
        className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-[#0B0E14]"
        aria-label={artifact.name}
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={artifact.displayUrl}
            alt={artifact.name}
            loading="lazy"
            onError={() => onBroken(artifact.id)}
            className="size-full object-cover transition group-hover:scale-[1.03]"
          />
        ) : (
          <>
            <Icon className={cn("size-9", accent)} aria-hidden />
            {artifact.kind === "video" ? (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex size-9 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
                  <Play className="size-4 fill-white text-white" />
                </span>
              </span>
            ) : null}
          </>
        )}
        {/* Top badge row — kind (left) + source/agent (right) live in ONE
            flex row spanning the frame width, with the source badge truncating.
            Previously both were independent `absolute` spans, so a long agent
            name ("Manager Pribadi") slid left and overlapped the kind label. */}
        <span className="pointer-events-none absolute inset-x-1.5 top-1.5 flex items-center justify-between gap-1">
          <span className="shrink-0 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-white/70 backdrop-blur-sm">
            {artifact.kind}
          </span>
          <span
            className={cn(
              "flex min-w-0 max-w-[68%] items-center rounded-md border px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] backdrop-blur-sm",
              fromUser
                ? "border-cyan-400/30 bg-cyan-400/15 text-cyan-100"
                : "border-fuchsia-400/30 bg-fuchsia-400/15 text-fuchsia-100",
            )}
          >
            <span className="truncate">
              {fromUser ? fromUserLabel : `${agentEmoji} ${agentName}`}
            </span>
          </span>
        </span>
      </button>

      {/* Footer */}
      <div className="flex min-w-0 flex-col gap-1.5 p-2.5">
        <p className="truncate text-[12px] font-medium text-white/90" title={artifact.name}>
          {artifact.name}
        </p>
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">
          {artifact.sizeBytes ? <span>{prettyFileSize(artifact.sizeBytes)}</span> : null}
          {artifact.sizeBytes ? <span aria-hidden>·</span> : null}
          <span>{relativeTime(artifact.createdAt)}</span>
        </div>
        {artifact.kind === "audio" ? (
          <audio
            src={artifact.displayUrl}
            controls
            preload="none"
            className="mt-0.5 h-7 w-full"
          />
        ) : null}
        <div className="mt-0.5 flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => onOpenChat(artifact.sessionKey)}
            title={artifact.sessionTitle}
            className="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-cyan-300/70 transition hover:text-cyan-200"
          >
            <MessageSquare className="size-3 shrink-0" />
            <span className="truncate">{artifact.sessionTitle}</span>
          </button>
          {artifact.kind === "document" ? (
            <button
              type="button"
              onClick={() => downloadAttachment(artifact.displayUrl, artifact.name)}
              className="shrink-0 text-[10px] font-medium text-white/45 transition hover:text-white"
            >
              Unduh
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentFilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition",
        active
          ? "border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-100"
          : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white/85",
      )}
    >
      <span className="truncate max-w-[140px]">{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 font-mono text-[9px]",
          active ? "bg-fuchsia-400/20 text-fuchsia-200" : "bg-white/[0.06] text-white/45",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-[13px] text-white/50">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-white/35">
        <ImageIcon className="size-6" />
      </div>
      <p className="text-[15px] font-semibold text-white/80">{title}</p>
      <p className="max-w-xs text-[12.5px] leading-relaxed text-white/45">{hint}</p>
    </div>
  );
}
