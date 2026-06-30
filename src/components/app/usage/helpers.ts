/**
 * Helpers untuk Usage tab — formatters + insight computation.
 *
 * Engine source of truth:
 *   - usage.cost { days } → { totals, daily[] }
 *   - sessions.usage { startDate, endDate, limit } → { sessions[], totals, aggregates }
 *   - usage.status {} → { providers[] }
 *
 * Aggregates dari engine kasih byModel/byChannel/byAgent — itu yang
 * AgentBuff sebelumnya tidak expose. V2 expose semua.
 */

export type CostTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};

export type CostDailyEntry = CostTotals & { date: string };

export type ModelUsageRow = {
  model: string;
  provider?: string;
  totals: CostTotals;
};

export type AgentUsageRow = {
  agentId: string;
  totals: CostTotals;
};

export type ChannelUsageRow = {
  channel: string;
  totals: CostTotals;
};

/**
 * NOTE — field names verified against
 *   Reff/openclaw/src/gateway/server-methods/usage-types.ts
 *   Reff/openclaw/src/gateway/server-methods/usage-aggregates.ts
 * Don't rename without rechecking those files first.
 */

export type SessionMessageCounts = {
  total: number;
  user?: number;
  assistant?: number;
  toolCalls?: number;
  toolResults?: number;
  errors?: number;
};

export type SessionToolUsageEntry = {
  name: string;
  count: number;
};

export type SessionToolUsage = {
  totalCalls: number;
  uniqueTools: number;
  tools?: SessionToolUsageEntry[];
};

export type SessionLatencyStats = {
  count?: number;
  avgMs?: number;
  p95Ms?: number;
  minMs?: number;
  maxMs?: number;
};

export type SessionDailyLatency = {
  date: string;
  avgMs?: number;
  p95Ms?: number;
  count?: number;
};

export type SessionDailyModelUsage = {
  date: string;
  provider?: string;
  model?: string;
  tokens: number;
  cost: number;
  count: number;
};

export type SessionDailyEntry = {
  date: string;
  tokens: number;
  cost: number;
  messages?: number;
  toolCalls?: number;
  errors?: number;
};

export type ModelUsageRowWithCount = ModelUsageRow & { count?: number };

export type SessionsUsageAggregates = {
  messages?: SessionMessageCounts;
  tools?: SessionToolUsage;
  byModel: ModelUsageRowWithCount[];
  byProvider: ModelUsageRowWithCount[];
  byAgent: AgentUsageRow[];
  byChannel: ChannelUsageRow[];
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: SessionDailyEntry[];
};

export type SessionUsageOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: string;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

/* ── Per-session detail shapes (engine sessions.usage when includeContextWeight=true) ── */

/** Engine's `SessionCostSummary` extended with all per-session aggregates.
 *  Field names verified against `infra/session-cost-usage.types.ts:124-139`. */
export type SessionCostDetail = CostTotals & {
  firstActivity?: number;
  lastActivity?: number;
  durationMs?: number;
  activityDates?: string[];
  messageCounts?: SessionMessageCounts;
  toolUsage?: SessionToolUsage;
  modelUsage?: Array<{
    provider?: string;
    model?: string;
    count: number;
    totals: CostTotals;
  }>;
  latency?: SessionLatencyStats;
  dailyBreakdown?: Array<{
    date: string;
    tokens: number;
    cost: number;
  }>;
  dailyMessageCounts?: Array<{
    date: string;
    total: number;
    user?: number;
    assistant?: number;
    toolCalls?: number;
    errors?: number;
  }>;
  dailyLatency?: SessionDailyLatency[];
  dailyModelUsage?: SessionDailyModelUsage[];
};

/** `contextWeight.skills/files/systemPrompt/tools` only returned when
 *  `sessions.usage` is called with `includeContextWeight: true`.
 *  Source: `Reff/openclaw/src/config/sessions/types.ts:470-486`. */
export type SessionSystemPromptReport = {
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  skills?: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  injectedWorkspaceFiles?: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  tools?: {
    summaryChars: number;
    schemaChars: number;
    entries?: Array<{ name: string; chars: number }>;
  };
};

/** `sessions.usage.timeseries` result — per-session hourly tokens/cost. */
export type SessionUsageTimePoint = {
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  cumulativeTokens: number;
  cumulativeCost: number;
};

export type SessionUsageTimeSeries = {
  sessionId?: string;
  points: SessionUsageTimePoint[];
};

/** `sessions.usage.logs` result — per-session message log. */
export type SessionLogEntry = {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
};

export type SessionLogsResult = {
  logs: SessionLogEntry[];
};

/* ── Helpers untuk UI-computed metrics ────────────────────────────────── */

/** Engine convention dari `usage-metrics.ts:11-15`. */
export const CHARS_PER_TOKEN = 4;

export function charsToTokens(chars: number | null | undefined): number {
  if (chars == null || !Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Format duration ms → "10d 7h" / "2h 13m" / "3m 24s" / "1.2s" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

/* ── Activity heatmap (UI-computed) ───────────────────────────────────── */

export type ActivityHeatmap = {
  hourTotals: number[]; // 24 cells
  weekdayTotals: number[]; // 7 cells (Sun=0..Sat=6)
  maxHour: number;
  maxWeekday: number;
  totalTokens: number;
};

export type SessionForHeatmap = {
  usage: {
    firstActivity?: number;
    lastActivity?: number;
    totalTokens: number;
  } | null;
};

/** Allocate session tokens proportionally across the hours/weekdays it spans.
 *  Mirrors engine UI's `buildUsageMosaicStats()` (usage-metrics.ts:138-184). */
export function buildActivityHeatmap(
  sessions: SessionForHeatmap[],
): ActivityHeatmap {
  const hourTotals = new Array(24).fill(0);
  const weekdayTotals = new Array(7).fill(0);
  let totalTokens = 0;
  for (const s of sessions) {
    const u = s.usage;
    if (!u || !u.totalTokens || !u.firstActivity || !u.lastActivity) continue;
    const start = u.firstActivity;
    const end = u.lastActivity;
    if (end < start) continue;
    const durationMs = Math.max(1, end - start);
    // Walk the session timeline in 1-min steps and accrue tokens
    // proportionally per hour/weekday bucket. Capped at 24*60 steps to avoid
    // pathological sessions burning CPU on the worker.
    const stepMs = 60_000;
    const steps = Math.min(
      24 * 60,
      Math.max(1, Math.ceil(durationMs / stepMs)),
    );
    const tokensPerStep = u.totalTokens / steps;
    for (let i = 0; i < steps; i++) {
      const t = start + (i * durationMs) / steps;
      const d = new Date(t);
      const hour = d.getHours();
      const weekday = d.getDay();
      hourTotals[hour] += tokensPerStep;
      weekdayTotals[weekday] += tokensPerStep;
    }
    totalTokens += u.totalTokens;
  }
  return {
    hourTotals,
    weekdayTotals,
    maxHour: Math.max(...hourTotals, 0),
    maxWeekday: Math.max(...weekdayTotals, 0),
    totalTokens,
  };
}

/* ── Throughput + averages (UI-computed) ──────────────────────────────── */

export type ThroughputStats = {
  totalDurationMs: number;
  durationSessionCount: number;
  tokensPerMin: number | null;
  costPerMin: number | null;
  avgDurationMs: number | null;
  avgTokensPerMessage: number | null;
  avgCostPerMessage: number | null;
  cacheHitRate: number | null;
  errorRate: number | null;
};

export type SessionForThroughput = {
  usage: {
    totalTokens: number;
    totalCost: number;
    durationMs?: number;
    messageCounts?: SessionMessageCounts;
  } | null;
};

export function buildThroughputStats(
  sessions: SessionForThroughput[],
  totals: CostTotals,
  messages: SessionMessageCounts | undefined,
): ThroughputStats {
  let totalDurationMs = 0;
  let durationSessionCount = 0;
  for (const s of sessions) {
    const u = s.usage;
    if (!u) continue;
    if (u.durationMs && u.durationMs > 0) {
      totalDurationMs += u.durationMs;
      durationSessionCount++;
    }
  }
  const tokensPerMin =
    totalDurationMs > 0
      ? (totals.totalTokens / totalDurationMs) * 60_000
      : null;
  const costPerMin =
    totalDurationMs > 0
      ? (totals.totalCost / totalDurationMs) * 60_000
      : null;
  const avgDurationMs =
    durationSessionCount > 0
      ? totalDurationMs / durationSessionCount
      : null;
  const totalMessages = messages?.total ?? 0;
  const avgTokensPerMessage =
    totalMessages > 0 ? totals.totalTokens / totalMessages : null;
  const avgCostPerMessage =
    totalMessages > 0 ? totals.totalCost / totalMessages : null;
  // Cache hit rate = cacheRead / (cacheRead + input). 0 input → null (no calls).
  const cacheDenom = totals.cacheRead + totals.input;
  const cacheHitRate =
    cacheDenom > 0 ? (totals.cacheRead / cacheDenom) * 100 : null;
  // Error rate = errors / total messages (treat assistant errors as numerator).
  const errors = messages?.errors ?? 0;
  const errorRate =
    totalMessages > 0 ? (errors / totalMessages) * 100 : null;
  return {
    totalDurationMs,
    durationSessionCount,
    tokensPerMin,
    costPerMin,
    avgDurationMs,
    avgTokensPerMessage,
    avgCostPerMessage,
    cacheHitRate,
    errorRate,
  };
}

/* ── Peak error hour/day (UI-computed) ────────────────────────────────── */

export type PeakErrorEntry = {
  // hour-of-day OR date string YYYY-MM-DD
  bucket: string;
  errors: number;
  messages: number;
  rate: number; // 0..1
};

/** Find top error hours from aggregates.daily + per-hour distribution.
 *  We don't have per-hour errors directly — engine ships errors per DAY via
 *  `aggregates.daily[].errors`. So peakHour falls back to overall hourTotals
 *  weight; peakDay reads aggregates.daily directly. */
export function buildPeakErrorDay(
  daily: Array<{ date: string; errors?: number; messages?: number }>,
  maxResults = 3,
): PeakErrorEntry[] {
  const candidates = daily
    .filter((d) => (d.errors ?? 0) > 0 && (d.messages ?? 0) > 0)
    .map((d) => ({
      bucket: d.date,
      errors: d.errors ?? 0,
      messages: d.messages ?? 0,
      rate: (d.errors ?? 0) / (d.messages ?? 1),
    }))
    .sort((a, b) => b.rate - a.rate);
  return candidates.slice(0, maxResults);
}

/* ── Formatters ─────────────────────────────────────────────────────────── */

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(n: number, fractionDigits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(fractionDigits)}%`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatDateShort(iso: string): string {
  // Engine returns YYYY-MM-DD
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [, mm, dd] = parts;
  return `${dd}/${mm}`;
}

export function formatDateBahasa(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/* ── Calendar helpers (local timezone aware) ──────────────────────────── */
//
// Engine `usage.cost.daily[].date` returns "YYYY-MM-DD". We treat that as a
// calendar date in the USER's local timezone — matching what the user
// intuitively means by "hari ini". For server-local edge cases (engine in UTC,
// user in WIB) the mismatch is at most ~1 day around local midnight, which we
// accept as a known compromise. The alternative — passing tz to the engine —
// would require an engine source change (hard constraint).

/** Local-tz `YYYY-MM-DD` for today. */
export function todayDateString(): string {
  return formatLocalDate(new Date());
}

/** Local-tz `YYYY-MM-DD` for `daysAgo` days before today. */
export function dateStringDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatLocalDate(d);
}

/** Days elapsed from `iso` (YYYY-MM-DD) to today, local tz. Negative if in
 *  future, 0 if today. */
export function daysBetweenTodayAnd(iso: string): number {
  const [y, m, day] = iso.split("-").map(Number);
  if (!y || !m || !day) return 0;
  const target = new Date(y, m - 1, day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = today.getTime() - target.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Empty (zero) entry for a given date — used to fill gaps in sparse engine
 *  series. Engine skips days with no activity; UI needs the dense window. */
export function emptyDailyEntry(date: string): CostDailyEntry {
  return {
    date,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

/** Take sparse engine `daily` series and return a dense calendar window of
 *  `windowDays` entries ending at today (inclusive). Gaps are filled with
 *  zero entries. Output is sorted ascending by date. */
export function fillDailyWindow(
  daily: CostDailyEntry[],
  windowDays: number,
): CostDailyEntry[] {
  const byDate = new Map<string, CostDailyEntry>();
  for (const d of daily) byDate.set(d.date, d);
  const out: CostDailyEntry[] = [];
  // Oldest first → newest (today) last. windowDays=30 → 29 days ago … today.
  for (let i = windowDays - 1; i >= 0; i--) {
    const ds = dateStringDaysAgo(i);
    out.push(byDate.get(ds) ?? emptyDailyEntry(ds));
  }
  return out;
}

/* ── Comparison helpers ─────────────────────────────────────────────────── */

export type ComparisonStat = {
  current: number;
  previous: number;
  delta: number; // signed
  pct: number; // signed percent
  direction: "up" | "down" | "flat";
};

export function compareValues(current: number, previous: number): ComparisonStat {
  const delta = current - previous;
  const pct = previous === 0 ? (current > 0 ? 100 : 0) : (delta / previous) * 100;
  const direction =
    Math.abs(pct) < 1 ? "flat" : delta > 0 ? "up" : "down";
  return { current, previous, delta, pct, direction };
}

/**
 * Trend stats pivoted on the user's CALENDAR TODAY (local timezone).
 *
 * Engine `usage.cost.daily` only returns days with cost > 0 (sparse), so a
 * naive "today = last entry" picks a stale date if today happens to have no
 * activity. We instead synthesize a `$0` entry for the actual today date and
 * mark it via `hasTodayActivity`. Consumers (hero card, insights) read that
 * flag to render empty-state copy instead of misleading "$X hari ini" when
 * the engine's last data point is days old.
 *
 * Window for "rata-rata 7 hari" is the strict 7 calendar days before today
 * (excluding today). Empty days count as $0 in the average — so the user
 * sees a realistic average that includes their idle days.
 */
export type TrendStats = {
  /** Today's entry — synthesized as $0 if engine has no record for today. */
  today: CostDailyEntry;
  /** Yesterday's entry — synthesized as $0 if no record. */
  yesterday: CostDailyEntry;
  /** True when today has any cost or tokens. False = idle today. */
  hasTodayActivity: boolean;
  /** Most recent engine entry with cost > 0 (or tokens > 0). Null if engine
   *  has never recorded any activity. Useful for "Terakhir aktif: {date}". */
  lastActiveEntry: CostDailyEntry | null;
  /** Calendar days from today back to `lastActiveEntry`. 0 = today is active,
   *  1 = yesterday, etc. Null if never active. */
  daysSinceLastActivity: number | null;
  /** Average of strictly the 7 calendar days before today (empties count as $0). */
  avgPast7: number;
  costVsYesterday: ComparisonStat;
  costVsAvg: ComparisonStat;
  tokensVsYesterday: ComparisonStat;
};

export function computeTrendStats(daily: CostDailyEntry[]): TrendStats {
  const todayStr = todayDateString();
  const yesterdayStr = dateStringDaysAgo(1);
  const byDate = new Map<string, CostDailyEntry>();
  for (const d of daily) byDate.set(d.date, d);

  const today = byDate.get(todayStr) ?? emptyDailyEntry(todayStr);
  const yesterday = byDate.get(yesterdayStr) ?? emptyDailyEntry(yesterdayStr);
  const hasTodayActivity = today.totalCost > 0 || today.totalTokens > 0;

  // last active day = most recent entry with cost or tokens > 0
  const sortedDesc = [...daily].sort((a, b) => b.date.localeCompare(a.date));
  const lastActiveEntry =
    sortedDesc.find((d) => d.totalCost > 0 || d.totalTokens > 0) ?? null;
  const daysSinceLastActivity = lastActiveEntry
    ? daysBetweenTodayAnd(lastActiveEntry.date)
    : null;

  // strict calendar 7-day window before today (exclude today). Missing = $0.
  let sum = 0;
  for (let i = 1; i <= 7; i++) {
    const ds = dateStringDaysAgo(i);
    const entry = byDate.get(ds);
    if (entry) sum += entry.totalCost;
  }
  const avgPast7 = sum / 7;

  return {
    today,
    yesterday,
    hasTodayActivity,
    lastActiveEntry,
    daysSinceLastActivity,
    avgPast7,
    costVsYesterday: compareValues(today.totalCost, yesterday.totalCost),
    costVsAvg: compareValues(today.totalCost, avgPast7),
    tokensVsYesterday: compareValues(today.totalTokens, yesterday.totalTokens),
  };
}

/* ── Insights generator ─────────────────────────────────────────────────── */

export type Insight = {
  kind: "info" | "warning" | "success";
  icon: "trend-up" | "trend-down" | "model" | "channel" | "cache" | "tool";
  title: string;
  detail: string;
};

export function computeInsights(
  totals: CostTotals,
  aggregates: SessionsUsageAggregates | null | undefined,
  trend: ReturnType<typeof computeTrendStats>,
): Insight[] {
  const insights: Insight[] = [];

  // Idle-today insight (only fires when there's no activity today AND we have
  // a recorded last-active day — so user sees "terakhir aktif kapan" instead
  // of a confused empty state)
  if (
    !trend.hasTodayActivity &&
    trend.lastActiveEntry &&
    trend.daysSinceLastActivity != null &&
    trend.daysSinceLastActivity > 0
  ) {
    const days = trend.daysSinceLastActivity;
    const label =
      days === 1 ? "kemarin" : `${days} hari lalu`;
    insights.push({
      kind: "info",
      icon: "trend-down",
      title: `Belum ada aktivitas hari ini`,
      detail: `Terakhir aktif ${label} (${formatDateBahasa(trend.lastActiveEntry.date)}) dengan biaya ${formatUsd(trend.lastActiveEntry.totalCost)}.`,
    });
  }

  // Trend vs yesterday — only fires when today is genuinely active (avoid
  // misleading "X% lebih boros" when today is $0)
  if (trend.hasTodayActivity && trend.today.totalCost > 0.001) {
    const c = trend.costVsYesterday;
    if (c.direction === "up" && c.pct >= 10) {
      const yesterdayPart =
        c.previous > 0
          ? `Naik dari ${formatUsd(c.previous)} → ${formatUsd(c.current)}.`
          : `Kemarin gak ada aktivitas, hari ini ${formatUsd(c.current)}.`;
      insights.push({
        kind: "warning",
        icon: "trend-up",
        title:
          c.previous > 0
            ? `Hari ini ${c.pct.toFixed(0)}% lebih boros dari kemarin`
            : `Hari ini mulai aktif lagi`,
        detail: `${yesterdayPart} Cek model atau channel yang paling sering dipake.`,
      });
    } else if (c.direction === "down" && c.pct <= -10) {
      insights.push({
        kind: "success",
        icon: "trend-down",
        title: `Hari ini ${Math.abs(c.pct).toFixed(0)}% lebih hemat dari kemarin`,
        detail: `Turun dari ${formatUsd(c.previous)} → ${formatUsd(c.current)}. Mantap, lanjutkan!`,
      });
    }
  }

  // Top model
  if (aggregates?.byModel && aggregates.byModel.length > 0 && totals.totalCost > 0) {
    const sortedModels = [...aggregates.byModel].sort(
      (a, b) => b.totals.totalCost - a.totals.totalCost,
    );
    const topModel = sortedModels[0];
    if (topModel && topModel.totals.totalCost > 0) {
      const pct = (topModel.totals.totalCost / totals.totalCost) * 100;
      if (pct >= 60) {
        insights.push({
          kind: "info",
          icon: "model",
          title: `Model ${stripModelPrefix(topModel.model)} pakai ${pct.toFixed(0)}% biaya`,
          detail: `${formatUsd(topModel.totals.totalCost)} dari total ${formatUsd(totals.totalCost)}. Coba switch ke model lebih murah kalau task ringan.`,
        });
      }
    }
  }

  // Top channel
  if (
    aggregates?.byChannel &&
    aggregates.byChannel.length > 0 &&
    totals.totalCost > 0
  ) {
    const sortedChannels = [...aggregates.byChannel].sort(
      (a, b) => b.totals.totalCost - a.totals.totalCost,
    );
    const topChannel = sortedChannels[0];
    if (topChannel && topChannel.totals.totalCost > 0) {
      const pct = (topChannel.totals.totalCost / totals.totalCost) * 100;
      if (pct >= 40) {
        insights.push({
          kind: "info",
          icon: "channel",
          title: `${humanChannel(topChannel.channel)} paling boros (${pct.toFixed(0)}%)`,
          detail: `${formatUsd(topChannel.totals.totalCost)} dari ${formatUsd(totals.totalCost)}. Channel ini punya volume chat paling tinggi.`,
        });
      }
    }
  }

  // Cache efficiency
  const totalNonCache = totals.input + totals.output;
  const cacheHit = totals.cacheRead;
  if (totalNonCache > 0 && cacheHit > 0) {
    const cachePct = (cacheHit / (cacheHit + totals.input)) * 100;
    if (cachePct >= 30) {
      insights.push({
        kind: "success",
        icon: "cache",
        title: `Cache hit ${cachePct.toFixed(0)}% — kamu hemat token!`,
        detail: `${formatTokens(cacheHit)} token dipake dari cache (jauh lebih murah dari input baru).`,
      });
    }
  }

  return insights;
}

/* ── Display helpers ───────────────────────────────────────────────────── */

export function stripModelPrefix(model: string | null | undefined): string {
  if (!model) return "—";
  return model.replace(/^[a-z-]+\//i, "");
}

export function humanChannel(channel: string | null | undefined): string {
  if (!channel) return "—";
  const c = channel.toLowerCase();
  if (c === "whatsapp" || c === "wa") return "WhatsApp";
  if (c === "telegram" || c === "tg") return "Telegram";
  if (c === "discord") return "Discord";
  if (c === "slack") return "Slack";
  if (c === "google_chat" || c === "googlechat" || c === "google-chat")
    return "Google Chat";
  if (c === "webchat" || c === "web" || c === "agentbuff") return "Chat AgentBuff";
  return channel;
}

export function humanToolName(tool: string | null | undefined): string {
  if (!tool) return "—";
  // Drop common prefixes: "mcp__server__tool" → "tool"
  const stripped = tool.replace(/^mcp__[^_]+__/, "");
  // snake_case + kebab-case → Title Case
  return stripped
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function humanSurfaceName(surface: string | null | undefined): string {
  if (!surface) return "—";
  const s = surface.toLowerCase();
  // surface format often: "whatsapp:+62...", "telegram:@id", "web:..."
  const [head] = s.split(":");
  if (!head) return surface;
  return humanChannel(head);
}

export function humanProviderName(provider: string | null | undefined): string {
  if (!provider) return "—";
  const p = provider.toLowerCase();
  if (p === "google") return "Google";
  if (p === "anthropic") return "Anthropic";
  if (p === "openai") return "OpenAI";
  if (p === "deepseek") return "DeepSeek";
  if (p === "z.ai" || p === "zai") return "Z.AI";
  if (p === "qwen") return "Qwen";
  if (p === "kimi") return "Kimi";
  return provider;
}

/* ── Chart helpers ─────────────────────────────────────────────────────── */

export type ChartPoint = {
  date: string;
  value: number;
  cost: number;
  tokens: number;
  /** Engine session aggregate enrichments (optional). */
  messages?: number;
  toolCalls?: number;
  errors?: number;
};

export function dailyToChartPoints(
  daily: CostDailyEntry[],
  mode: "cost" | "tokens",
  sessionsDaily?: SessionDailyEntry[],
): ChartPoint[] {
  const sessionByDate = new Map<string, SessionDailyEntry>();
  for (const d of sessionsDaily ?? []) sessionByDate.set(d.date, d);
  return [...daily]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const extra = sessionByDate.get(d.date);
      return {
        date: d.date,
        value: mode === "cost" ? d.totalCost : d.totalTokens,
        cost: d.totalCost,
        tokens: d.totalTokens,
        messages: extra?.messages,
        toolCalls: extra?.toolCalls,
        errors: extra?.errors,
      };
    });
}

export function chartMaxValue(points: ChartPoint[]): number {
  let max = 0;
  for (const p of points) if (p.value > max) max = p.value;
  return max || 1;
}
