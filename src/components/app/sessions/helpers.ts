/**
 * Helpers untuk Sessions tab — pure functions, no React.
 * Translate engine raw fields → mass-market friendly Bahasa.
 */
import type { SessionSummary } from "@/lib/app/store";

/**
 * Session activity tier — driving status dot color.
 *   - "live"     : status === running OR very recent updatedAt (<30s)
 *   - "recent"   : updatedAt < 5 min
 *   - "today"    : updatedAt < 24h
 *   - "older"    : updatedAt < 7 days
 *   - "stale"    : > 7 days or no updatedAt
 */
export type SessionActivityTier =
  | "live"
  | "recent"
  | "today"
  | "older"
  | "stale";

export function activityOf(
  s: SessionSummary,
  now: number = Date.now(),
): SessionActivityTier {
  if (s.status === "running") return "live";
  const ts = s.updatedAt ?? 0;
  if (!ts) return "stale";
  const age = Math.max(0, now - ts);
  if (age < 30_000) return "live";
  if (age < 5 * 60_000) return "recent";
  if (age < 24 * 60 * 60_000) return "today";
  if (age < 7 * 24 * 60 * 60_000) return "older";
  return "stale";
}

/** Kind label di Bahasa. */
export function kindLabel(kind: SessionSummary["kind"]): string {
  switch (kind) {
    case "direct":
      return "Chat Pribadi";
    case "group":
      return "Chat Grup";
    case "global":
      return "Sesi Global";
    case "unknown":
    default:
      return "Lainnya";
  }
}

/** Tone palette per kind. */
export type SessionTone = "cyan" | "indigo" | "fuchsia" | "slate";
export function kindTone(kind: SessionSummary["kind"]): SessionTone {
  switch (kind) {
    case "direct":
      return "cyan";
    case "group":
      return "indigo";
    case "global":
      return "fuchsia";
    case "unknown":
    default:
      return "slate";
  }
}

/** Status label di Bahasa. Engine enum: "running" | "done" | "failed" | "killed" | "timeout". */
export function statusLabel(
  status: SessionSummary["status"] | undefined,
  abortedLastRun?: boolean,
): string {
  if (status === "running") return "Berjalan";
  if (status === "failed") return "Gagal";
  if (status === "killed" || abortedLastRun) return "Dibatalkan";
  if (status === "timeout") return "Timeout";
  if (status === "done") return "Selesai";
  return "Standby";
}

export function statusTone(
  status: SessionSummary["status"] | undefined,
): "emerald" | "amber" | "red" | "slate" {
  if (status === "running") return "emerald";
  if (status === "failed" || status === "killed") return "red";
  if (status === "timeout") return "amber";
  return "slate";
}

/** Format token count → "1.2k" / "4.5M" / "234". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Detailed breakdown — "in 1.2k · out 3.4k". */
export function formatTokenBreakdown(s: SessionSummary): string {
  const inTokens = s.inputTokens;
  const outTokens = s.outputTokens;
  if (inTokens == null && outTokens == null) {
    return formatTokens(s.totalTokens);
  }
  const parts: string[] = [];
  if (inTokens != null) parts.push(`↓${formatTokens(inTokens)}`);
  if (outTokens != null) parts.push(`↑${formatTokens(outTokens)}`);
  return parts.join(" ");
}

/** Format model display — strip provider prefix to be more readable. */
export function formatModel(
  model: string | null | undefined,
  provider: string | null | undefined,
): string | null {
  if (!model) return null;
  // Strip common prefixes like "google/" or "anthropic/"
  const cleaned = model.replace(/^[a-z-]+\//i, "");
  return cleaned;
}

/** Format model provider chip text — short brand name. */
export function modelProviderBadge(
  provider: string | null | undefined,
): string | null {
  if (!provider) return null;
  const lower = provider.toLowerCase();
  if (lower === "google") return "Google";
  if (lower === "anthropic") return "Anthropic";
  if (lower === "deepseek") return "DeepSeek";
  if (lower === "openai") return "OpenAI";
  if (lower === "z.ai" || lower === "zai" || lower === "z-ai") return "Z.AI";
  if (lower === "qwen") return "Qwen";
  if (lower === "kimi") return "Kimi";
  return provider;
}

/** Format relative time Bahasa Indonesia. */
export function formatRelative(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "Baru saja";
  if (sec < 60) return `${sec} detik lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} hari lalu`;
  if (days < 30) return `${Math.floor(days / 7)} minggu lalu`;
  return new Date(ts).toLocaleDateString("id-ID");
}

/** Format runtime ms → "12 detik" / "3 menit" / "1.2 jam". */
export function formatRuntime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} detik`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const remSec = sec - min * 60;
    return remSec > 0 ? `${min} menit ${remSec} detik` : `${min} menit`;
  }
  const hr = (ms / 3_600_000).toFixed(1);
  return `${hr} jam`;
}

/** Compute total token & total cost-style metrics across sessions. */
export function aggregateSessions(sessions: SessionSummary[]): {
  totalSessions: number;
  totalTokens: number;
  activeToday: number;
  largestSession: SessionSummary | null;
  runningCount: number;
} {
  const dayCutoff = Date.now() - 24 * 60 * 60_000;
  let totalTokens = 0;
  let activeToday = 0;
  let runningCount = 0;
  let largest: SessionSummary | null = null;
  let largestTokens = 0;
  for (const s of sessions) {
    const tok = s.totalTokens ?? 0;
    totalTokens += tok;
    if ((s.updatedAt ?? 0) >= dayCutoff) activeToday++;
    if (s.status === "running") runningCount++;
    if (tok > largestTokens) {
      largest = s;
      largestTokens = tok;
    }
  }
  return {
    totalSessions: sessions.length,
    totalTokens,
    activeToday,
    largestSession: largest,
    runningCount,
  };
}

/** Context percent (tokens used / context window). */
export function contextPercent(s: SessionSummary): number | null {
  if (!s.contextTokens || !s.totalTokens) return null;
  return Math.min(100, Math.round((s.totalTokens / s.contextTokens) * 100));
}

/** Compute behavior level label (Bahasa). */
export function thinkingLevelLabel(level?: string | null): string {
  const v = (level ?? "").toLowerCase();
  if (v === "off") return "Mati";
  if (v === "minimal") return "Minimal";
  if (v === "low") return "Rendah";
  if (v === "medium") return "Sedang";
  if (v === "high") return "Tinggi";
  if (v === "xhigh") return "Sangat Tinggi";
  if (v === "on") return "Aktif";
  return "Default";
}
