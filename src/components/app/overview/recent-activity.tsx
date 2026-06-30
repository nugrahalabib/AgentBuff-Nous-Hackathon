"use client";

/**
 * Recent Activity — Zone 6.
 *
 * Mix timeline: top 5 entries dari sessions + cron runs (sorted by recency).
 * Per row click → navigate ke session di /app/chat atau /app/cron.
 *
 * Data (Hermes bridge):
 * - sessions: `sessions.list` RPC. NOTE: its `updatedAt` is Unix SECONDS, while
 *   cron timestamps are MS — both are normalized to ms via `toMs` at ingest so
 *   sorting + relative formatting are correct (the old code treated seconds as
 *   ms → "20587 hari lalu").
 * - cron runs: `cron.list` RPC (the Hermes method; the old `cron.status` does
 *   not exist on this bridge). Timeline ts = state.lastRunAtMs ?? nextRunAtMs.
 *
 * Empty state: encourage onboarding ("Mulai dengan delegasi pertama!")
 */
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronRight, MessageSquare } from "lucide-react";
import { useRpc } from "@/lib/app/use-rpc";
import { useI18n } from "@/lib/i18n/context";

type SessionRow = {
  key: string;
  agentId?: string | null;
  displayName?: string | null;
  label?: string | null;
  derivedTitle?: string | null;
  lastMessagePreview?: string | null;
  updatedAt?: number | null;
  model?: string | null;
};

type SessionsListResult = {
  sessions?: SessionRow[];
  count?: number;
};

type CronJobRow = {
  id?: string;
  name?: string;
  spec?: string;
  state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    nextRunAtMs?: number;
  };
};

type CronListResult = {
  jobs?: CronJobRow[];
};

type TimelineEntry = {
  kind: "session" | "cron";
  ts: number;
  title: string;
  subtitle: string;
  href: string;
};

/**
 * Normalize a timestamp to milliseconds. The bridge mixes units: sessions.list
 * returns Unix SECONDS, cron.list returns MS. Anything below ~1e12 is treated
 * as seconds and scaled up. Guards against the seconds-as-ms bug that rendered
 * "20587 hari lalu".
 */
function toMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  // Future or invalid (clock skew) → treat as just now instead of a nonsense
  // negative/huge relative.
  if (diff < 60_000) return "baru saja";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

export function RecentActivity() {
  const { t } = useI18n();
  const router = useRouter();

  const sessionsQ = useRpc<SessionsListResult>({
    method: "sessions.list",
    params: {
      limit: 5,
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
  });
  const cronQ = useRpc<CronListResult>({ method: "cron.list" });

  const entries = useMemo<TimelineEntry[]>(() => {
    const items: TimelineEntry[] = [];

    // Defensive: server sessions.list bisa return shape `{count, sessions}` atau
    // bahkan primitive saat error/empty — TypeScript signature gak strict
    // enough buat catch ini di runtime. Guard pakai Array.isArray.
    const sessionsArr = Array.isArray(sessionsQ.data?.sessions)
      ? sessionsQ.data!.sessions
      : [];
    for (const s of sessionsArr) {
      if (!s || typeof s !== "object" || !s.updatedAt) continue;
      items.push({
        kind: "session",
        ts: toMs(s.updatedAt),
        title:
          s.derivedTitle ??
          s.label ??
          s.displayName ??
          s.key?.split(":").slice(-1)[0] ??
          s.key ??
          "Sesi",
        subtitle: s.lastMessagePreview ?? s.model ?? "",
        href: "/app/chat",
      });
    }

    const cronArr = Array.isArray(cronQ.data?.jobs) ? cronQ.data!.jobs : [];
    for (const j of cronArr) {
      if (!j || typeof j !== "object") continue;
      // Prefer the last run (a real past event) for the timeline; fall back to
      // the next scheduled run so a never-run job still shows.
      const ts = j.state?.lastRunAtMs ?? j.state?.nextRunAtMs;
      if (!ts) continue;
      items.push({
        kind: "cron",
        ts: toMs(ts),
        title: j.name ?? "Quest tanpa nama",
        subtitle:
          j.state?.lastStatus === "ok"
            ? "Berhasil dijalankan"
            : j.state?.lastStatus === "error"
              ? "Gagal dijalankan"
              : (j.spec ?? ""),
        href: "/app/cron",
      });
    }

    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, 5);
  }, [sessionsQ.data, cronQ.data]);

  const loading =
    (sessionsQ.loading && !sessionsQ.data) || (cronQ.loading && !cronQ.data);

  return (
    <article className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white/90">
          {t.app.overview.recentActivity.title}
        </h3>
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={() => router.push("/app/sessions")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45 transition hover:bg-white/[0.04] hover:text-white/80"
          >
            {t.app.overview.recentActivity.viewAll}
            <ChevronRight className="size-3" />
          </button>
        ) : null}
      </header>

      {loading ? (
        <ul className="flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
            >
              <div className="skeleton size-8 shrink-0 rounded-lg" aria-hidden />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="skeleton h-3 w-2/3 rounded" aria-hidden />
                <div className="skeleton h-2 w-1/2 rounded" aria-hidden />
              </div>
              <div className="skeleton h-3 w-16 rounded" aria-hidden />
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-6 text-center">
          <p className="text-xs text-white/55">
            {t.app.overview.recentActivity.empty}
          </p>
          <p className="text-[11px] text-white/35">
            {t.app.overview.recentActivity.emptyHint}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e, i) => (
            <li key={`${e.kind}:${e.ts}:${i}`}>
              <button
                type="button"
                onClick={() => router.push(e.href)}
                className="flex w-full items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition hover:border-cyan-400/30 hover:bg-white/[0.04]"
              >
                <span
                  aria-hidden
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${
                    e.kind === "session"
                      ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-200"
                      : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                  }`}
                >
                  {e.kind === "session" ? (
                    <MessageSquare className="size-4" />
                  ) : (
                    <CalendarClock className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white/85">
                    {e.title}
                  </div>
                  {e.subtitle ? (
                    <div className="truncate text-[11px] text-white/45">
                      {e.subtitle}
                    </div>
                  ) : null}
                </div>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  {formatRelative(e.ts)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
