"use client";

/**
 * Usage tab — "Token & Biaya".
 *
 * Focused, honest, 100% wired to the Hermes engine session DB. Sources:
 *   - usage.cost      → daily token series + window totals + billing summary
 *   - sessions.usage  → per-session rows + aggregates (byModel / byChannelUsage)
 *
 * Cost is billing-aware, never a bare misleading $0:
 *   - subscription_included (e.g. Codex/ChatGPT plan) → "Langganan {provider}"
 *     because the user pays a flat fee, not per token (cost IS $0 incremental).
 *   - pay-per-token            → real $ from the engine's estimated cost.
 *   - unknown pricing          → "Belum terhitung" (not faked as $0).
 * Sections Hermes doesn't track (provider rate-limit windows, context-weight,
 * latency) are intentionally omitted rather than fabricated.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshCw, BarChart3, Layers, Zap, Gauge, CreditCard, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useRpc } from "@/lib/app/use-rpc";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { EmptyState } from "@/components/app/primitives/empty-state";
import { cn } from "@/lib/utils";

// ── Wire types (mirror the bridge usage shape) ──────────────────────────
type CostTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
};
type DailyEntry = CostTotals & { date: string };
type Billing = {
  provider: string | null;
  mode: string | null;
  subscriptionTokens: number;
  pricedTokens: number;
  unpricedTokens: number;
  freeTokens: number;
  paidCostUsd: number;
};
type UsageCostResult = {
  updatedAt: number;
  days: number;
  daily: DailyEntry[];
  totals: CostTotals;
  billing?: Billing;
};
type ModelRow = { model: string; count?: number; totals: CostTotals };
type ChannelRow = { channel: string; totals: CostTotals };
type SessionRow = {
  key: string;
  sessionId: string;
  label?: string | null;
  channel: string;
  model: string;
  updatedAt?: number | null;
  usage: (CostTotals & { messageCounts?: { total?: number } }) | null;
};
type SessionsUsageResult = {
  totals: CostTotals;
  sessions: SessionRow[];
  aggregates?: {
    byModel?: ModelRow[];
    byChannelUsage?: ChannelRow[];
    messages?: { total?: number; user?: number; assistant?: number };
  };
};

type PeriodDays = 7 | 14 | 30;
type Usage = ReturnType<typeof useI18n>["t"]["app"]["usage"];

// ── Formatters / helpers ────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) {
    const digits = n >= 10_000 ? 0 : 1;
    const k = n / 1_000;
    // Round-aware: 999_999 → "1000K" rolls over; promote to "1.0M".
    if (Number(k.toFixed(digits)) >= 1000) return "1.0M";
    return `${k.toFixed(digits)}K`;
  }
  return new Intl.NumberFormat("id-ID").format(n);
}
function formatFull(n: number): string {
  return new Intl.NumberFormat("id-ID").format(Math.max(0, Math.round(n)));
}
function formatRelative(ts?: number | null): string {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  return `${d} hari lalu`;
}
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord",
  slack: "Slack", google_chat: "Google Chat", tui: "Web Chat",
};
function humanChannel(c: string): string {
  return CHANNEL_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}
const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "Codex", "openai": "OpenAI", "anthropic": "Claude",
  "google": "Gemini", "gemini": "Gemini", "deepseek": "DeepSeek",
  "xai": "xAI", "groq": "Groq", "mistral": "Mistral", "openrouter": "OpenRouter",
};
function providerLabel(p?: string | null): string {
  if (!p) return "";
  return PROVIDER_LABELS[p] ?? p.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type DayPoint = { date: string; input: number; cacheRead: number; output: number; total: number };

/** Fill the trailing window so the chart spans the real period, not just the
 *  days that happened to have activity (was 2 fat bars in a 30-day window).
 *  Carries the input/cache/output split so the chart can stack them. */
function fillDailyWindow(daily: DailyEntry[], days: number): DayPoint[] {
  const map = new Map(daily.map((d) => [d.date, d]));
  const out: DayPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const e = map.get(key);
    out.push({
      date: key,
      input: e?.input ?? 0,
      cacheRead: e?.cacheRead ?? 0,
      output: e?.output ?? 0,
      total: e?.totalTokens ?? 0,
    });
  }
  return out;
}

type CostView = { value: string; note: string; tone: "sub" | "paid" | "unknown" | "free" };
function resolveCost(billing: Billing | undefined, totals: CostTotals | undefined, u: Usage): CostView {
  const paid = billing?.paidCostUsd ?? 0;
  if (paid > 0) {
    // A tiny-but-nonzero spend must not read as "$0.0000" (looks free).
    const value = paid < 0.01 ? "<$0.01" : `$${paid < 1 ? paid.toFixed(4) : paid.toFixed(2)}`;
    return { value, note: u.billingPaidNote, tone: "paid" };
  }
  const sub = billing?.subscriptionTokens ?? 0;
  const unpriced = billing?.unpricedTokens ?? 0;
  if (sub > 0 && sub >= unpriced) {
    const prov = providerLabel(billing?.provider);
    return {
      value: prov ? `${u.billingSubscriptionLabel} ${prov}` : u.billingSubscriptionLabel,
      note: u.billingSubscriptionNote,
      tone: "sub",
    };
  }
  if (unpriced > 0) {
    return { value: u.billingUnknownLabel, note: u.billingUnknownNote, tone: "unknown" };
  }
  return { value: "$0", note: "", tone: "free" };
}

export function UsageTab() {
  const { t } = useI18n();
  const u = t.app.usage;
  const [days, setDays] = useState<PeriodDays>(30);

  const costParams = useMemo(() => ({ days }), [days]);
  // sessions.usage accepts startDate/endDate (bridge windows the snapshot). Pass
  // the SAME period as usage.cost so the hero token count + composition + Top
  // Sessions match the selected 7/14/30-day range (was a fixed all-time {limit:50}).
  const sessionsParams = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { limit: 50, startDate: fmt(start), endDate: fmt(end) };
  }, [days]);

  const cost = useRpc<UsageCostResult, typeof costParams>({ method: "usage.cost", params: costParams, deps: [days] });
  const sessions = useRpc<SessionsUsageResult, typeof sessionsParams>({ method: "sessions.usage", params: sessionsParams, deps: [days] });

  const loading = (cost.loading && !cost.data) || (sessions.loading && !sessions.data);
  const refreshAll = useCallback(() => { void cost.refetch(); void sessions.refetch(); }, [cost, sessions]);

  const totals = cost.data?.totals;
  const billing = cost.data?.billing;
  const byModel = sessions.data?.aggregates?.byModel ?? [];
  const byChannel = sessions.data?.aggregates?.byChannelUsage ?? [];
  const sessionRows = sessions.data?.sessions ?? [];
  const msg = sessions.data?.aggregates?.messages;

  const filled = useMemo(() => fillDailyWindow(cost.data?.daily ?? [], days), [cost.data?.daily, days]);

  const total = totals?.totalTokens ?? 0;
  const cacheHit = totals && totals.input + totals.cacheRead > 0
    ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100) : 0;
  const avgPerSession = sessionRows.length > 0 ? Math.round(total / sessionRows.length) : 0;
  const costView = resolveCost(billing, totals, u);
  const hasAnyData = total > 0 || sessionRows.length > 0;
  // Distinguish a real RPC failure from a genuinely-empty account.
  const errMsg = cost.error ?? sessions.error;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow={u.eyebrow}
        title={u.title}
        subtitle={u.subtitle}
        actions={
          <div className="flex items-center gap-2">
            <PeriodPicker days={days} onChange={setDays} u={u} />
            <button
              type="button"
              onClick={refreshAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              <RefreshCw className={cn("size-3.5", (cost.loading || sessions.loading) && "animate-spin")} aria-hidden />
              {u.refresh}
            </button>
          </div>
        }
      />

      <div aria-busy={loading} className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          {loading && !cost.data ? (
            <HeroSkeleton />
          ) : errMsg && !hasAnyData ? (
            <div
              role="alert"
              className="rounded-2xl border border-red-500/30 bg-red-500/[0.06] px-6 py-10 text-center"
            >
              <AlertTriangle className="mx-auto mb-3 size-8 text-red-300" aria-hidden />
              <p className="text-[14px] font-semibold text-white/90">
                Gagal memuat data penggunaan
              </p>
              <p className="mx-auto mt-1.5 max-w-md break-words text-[12px] text-red-200/80">
                {errMsg}
              </p>
              <button
                type="button"
                onClick={refreshAll}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/85 hover:bg-white/[0.1]"
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {u.refresh}
              </button>
            </div>
          ) : !hasAnyData ? (
            <EmptyState icon={BarChart3} title={u.chartEmpty} subtitle={u.subtitle} />
          ) : (
            <>
              {/* Hero — total + composition + billing */}
              <CompositionHero totals={totals} costView={costView} u={u} />

              {/* Stat chips */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Chip icon={<Layers className="size-4" />} label={u.sessionsLabel} value={formatFull(sessionRows.length)} accent="cyan" />
                <Chip icon={<BarChart3 className="size-4" />} label={u.messagesLabel} value={formatFull(msg?.total ?? 0)} sub={msg ? `${msg.user ?? 0} masuk · ${msg.assistant ?? 0} keluar` : undefined} accent="indigo" />
                <Chip icon={<Zap className="size-4" />} label={u.cacheHitLabel} value={`${cacheHit}%`} sub={u.cacheHitNote} accent="emerald" />
                <Chip icon={<Gauge className="size-4" />} label={u.avgPerSession} value={formatTokens(avgPerSession)} sub={u.avgPerSessionNote} accent="fuchsia" />
              </section>

              {/* Daily chart */}
              <DailyChart data={filled} days={days} u={u} />

              {/* Breakdowns */}
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <BreakdownCard
                  title={u.colModel}
                  rows={byModel.map((m) => ({ label: m.model, value: m.totals.totalTokens, meta: m.count ? `${m.count} ${u.sessionsLabel.toLowerCase()}` : undefined }))}
                  u={u}
                />
                <BreakdownCard
                  title={u.channelLabel}
                  rows={byChannel.map((c) => ({ label: humanChannel(c.channel), value: c.totals.totalTokens }))}
                  u={u}
                />
              </section>

              {/* Top sessions */}
              <TopSessions rows={sessionRows} u={u} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PeriodPicker({ days, onChange, u }: { days: PeriodDays; onChange: (d: PeriodDays) => void; u: Usage }) {
  const opts: Array<{ d: PeriodDays; label: string }> = [
    { d: 7, label: u.periodChoice7 }, { d: 14, label: u.periodChoice14 }, { d: 30, label: u.periodChoice30 },
  ];
  return (
    <div role="group" aria-label={u.eyebrow} className="inline-flex rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
      {opts.map((o) => (
        <button key={o.d} type="button" onClick={() => onChange(o.d)} aria-pressed={days === o.d}
          className={cn("rounded-md px-2.5 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50", days === o.d ? "bg-cyan-400/20 text-cyan-100" : "text-white/55 hover:text-white/85")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CompositionHero({ totals, costView, u }: { totals?: CostTotals; costView: CostView; u: Usage }) {
  const input = totals?.input ?? 0;
  const output = totals?.output ?? 0;
  const cacheRead = totals?.cacheRead ?? 0;
  const total = totals?.totalTokens ?? 0;
  const parts = [
    { key: "input", label: u.inputLabel, value: input, cls: "bg-cyan-400", dot: "bg-cyan-400" },
    { key: "cache", label: u.cacheReadLabel, value: cacheRead, cls: "bg-indigo-400", dot: "bg-indigo-400" },
    { key: "output", label: u.outputLabel, value: output, cls: "bg-fuchsia-400", dot: "bg-fuchsia-400" },
  ];
  // Denominator = sum of the rendered parts so the segments fill 100% and the
  // percentages are consistent. (totalTokens also includes cacheWrite, which has
  // no segment here — basing denom on `total` left an unexplained gap.)
  const denom = Math.max(1, input + cacheRead + output);
  const toneCls =
    costView.tone === "paid" ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
      : costView.tone === "sub" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
        : costView.tone === "unknown" ? "border-white/15 bg-white/[0.05] text-white/70"
          : "border-white/15 bg-white/[0.05] text-white/70";

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-cyan-500/[0.06] to-fuchsia-500/[0.03] p-5 backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">{u.summaryTokens}</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-4xl font-bold tracking-tight text-white">{formatTokens(total)}</span>
            <span className="text-sm text-white/40">{formatFull(total)} token</span>
          </div>
        </div>
        {/* Billing badge */}
        <div className={cn("inline-flex items-center gap-2 rounded-xl border px-3 py-2", toneCls)}>
          <CreditCard className="size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight">{costView.value}</div>
            {costView.note ? <div className="text-[10px] opacity-80">{costView.note}</div> : null}
          </div>
        </div>
      </div>

      {/* Composition bar */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">{u.compositionTitle}</span>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.05]">
          {parts.map((p) => (
            <div key={p.key} className={cn("h-full", p.cls)} style={{ width: `${(p.value / denom) * 100}%` }} title={`${p.label}: ${formatFull(p.value)}`} />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.key} className="flex items-center gap-1.5 text-[11px]">
              <span className={cn("size-2 rounded-full", p.dot)} aria-hidden />
              <span className="text-white/55">{p.label}</span>
              <span className="font-medium text-white/85">{formatTokens(p.value)}</span>
              <span className="text-white/35">({Math.round((p.value / denom) * 100)}%)</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Chip({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent: "cyan" | "indigo" | "emerald" | "fuchsia" }) {
  const ring =
    accent === "cyan" ? "text-cyan-300/80" : accent === "indigo" ? "text-indigo-300/80"
      : accent === "emerald" ? "text-emerald-300/80" : "text-fuchsia-300/80";
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/[0.06] bg-[#0B0E14]/40 p-3.5 backdrop-blur-xl">
      <span className={cn("flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/50", ring)}>
        <span className={ring} aria-hidden>{icon}</span>
        <span className="text-white/50">{label}</span>
      </span>
      <span className="font-display text-xl font-bold tracking-tight text-white">{value}</span>
      {sub ? <span className="text-[10px] text-white/40">{sub}</span> : null}
    </div>
  );
}

const CHART_PX = 180; // usable bar area height in pixels (NOT % — % won't resolve
                      // inside a flex column without an explicit parent height).

function DailyChart({ data, days, u }: { data: DayPoint[]; days: number; u: Usage }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.total));
  const activeDays = data.filter((d) => d.total > 0).length;
  const windowTotal = data.reduce((sum, d) => sum + d.total, 0);
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : 5;
  const px = (v: number) => (v > 0 ? Math.max(2, Math.round((v / max) * CHART_PX)) : 0);

  const legend = [
    { label: u.inputLabel, cls: "bg-cyan-400" },
    { label: u.cacheReadLabel, cls: "bg-indigo-400" },
    { label: u.outputLabel, cls: "bg-fuchsia-400" },
  ];

  const hd = hover != null ? data[hover] : null;
  // Tooltip horizontal anchor — clamp so edge days don't overflow the card.
  const hoverLeftPct = hover != null ? ((hover + 0.5) / data.length) * 100 : 50;
  const align = hoverLeftPct < 18 ? "left" : hoverLeftPct > 82 ? "right" : "center";

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white/90">{u.chartTokens}</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
          {formatTokens(max)} {u.colTokens.toLowerCase()} · {activeDays}/{days} {u.periodNote}
        </span>
      </div>
      {/* legend */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5 text-[10px] text-white/45">
            <span className={cn("size-2 rounded-full", l.cls)} aria-hidden />
            {l.label}
          </span>
        ))}
      </div>

      {activeDays === 0 ? (
        <p className="py-8 text-center text-xs text-white/45">{u.chartEmpty}</p>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          {/* Floating tooltip */}
          {hd ? (
            <div
              className="pointer-events-none absolute bottom-full z-20 mb-2"
              style={{
                left: `${hoverLeftPct}%`,
                transform: align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : "translateX(0)",
              }}
            >
              <div className="w-44 rounded-xl border border-white/10 bg-[#0B0E14] p-3 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.8)]">
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-white/[0.06] pb-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">{hd.date}</span>
                  <span className="font-display text-sm font-bold text-white">{formatTokens(hd.total)}</span>
                </div>
                <ul className="flex flex-col gap-1">
                  <TipRow dot="bg-cyan-400" label={u.inputLabel} value={hd.input} total={hd.total} />
                  <TipRow dot="bg-indigo-400" label={u.cacheReadLabel} value={hd.cacheRead} total={hd.total} />
                  <TipRow dot="bg-fuchsia-400" label={u.outputLabel} value={hd.output} total={hd.total} />
                </ul>
              </div>
            </div>
          ) : null}

          <div
            role="img"
            aria-label={`Grafik token harian ${days} hari: ${formatFull(windowTotal)} token total, ${activeDays} dari ${days} hari ada aktivitas, puncak ${formatFull(max)} token/hari.`}
            className="flex items-end gap-[3px]"
            style={{ height: `${CHART_PX + 16}px` }}
          >
            {data.map((d, i) => {
              const isHover = hover === i;
              return (
                <div
                  key={d.date}
                  className="flex min-w-0 flex-1 cursor-default flex-col items-center justify-end gap-1"
                  onMouseEnter={() => setHover(i)}
                >
                  {/* Stacked bar — input (bottom) / cache / output (top). */}
                  <div
                    className={cn(
                      "flex w-full flex-col justify-end overflow-hidden rounded-t transition-all",
                      isHover
                        ? "shadow-[0_0_0_1px_rgba(34,211,238,0.5)] brightness-125"
                        : hover != null && "opacity-45",
                    )}
                    style={{ height: `${CHART_PX}px` }}
                  >
                    {d.output > 0 ? <div className="w-full bg-fuchsia-400/85" style={{ height: `${px(d.output)}px` }} /> : null}
                    {d.cacheRead > 0 ? <div className="w-full bg-indigo-400/80" style={{ height: `${px(d.cacheRead)}px` }} /> : null}
                    {d.input > 0 ? <div className="w-full bg-cyan-400/85" style={{ height: `${px(d.input)}px` }} /> : null}
                    {d.total === 0 ? <div className="h-px w-full bg-white/10" /> : null}
                  </div>
                  <span
                    className={cn(
                      "h-3 truncate font-mono text-[8px]",
                      isHover ? "text-cyan-200/90" : "text-white/30",
                    )}
                  >
                    {isHover ? d.date.slice(5) : i % labelEvery === 0 ? d.date.slice(5) : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function TipRow({ dot, label, value, total }: { dot: string; label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="text-white/55">{label}</span>
      <span className="ml-auto font-mono font-medium text-white/85">{formatTokens(value)}</span>
      <span className="w-8 text-right font-mono text-[10px] text-white/35">{pct}%</span>
    </li>
  );
}

function BreakdownCard({ title, rows, u }: { title: string; rows: Array<{ label: string; value: number; meta?: string }>; u: Usage }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  return (
    <article className="flex flex-col rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <h3 className="mb-3 text-sm font-semibold text-white/90">{title}</h3>
      {sorted.length === 0 ? (
        <p className="py-6 text-center text-xs text-white/45">{u.chartEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {sorted.map((r) => (
            <li key={r.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="truncate font-medium text-white/85">{r.label}</span>
                <span className="shrink-0 font-mono text-white/60">
                  {formatTokens(r.value)}
                  {r.meta ? <span className="ml-1 text-white/35">· {r.meta}</span> : null}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400" style={{ width: `${Math.max(3, Math.round((r.value / max) * 100))}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function TopSessions({ rows, u }: { rows: SessionRow[]; u: Usage }) {
  const sorted = [...rows].sort((a, b) => (b.usage?.totalTokens ?? 0) - (a.usage?.totalTokens ?? 0)).slice(0, 15);
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-4 backdrop-blur-xl">
      <h3 className="mb-3 text-sm font-semibold text-white/90">{u.topSessionsHeader}</h3>
      {sorted.length === 0 ? (
        <p className="py-6 text-center text-xs text-white/45">{u.topSessionsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-white/[0.06] font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                <th scope="col" className="py-2 pr-3 font-medium">{u.colSession}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{u.colModel}</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">{u.channelLabel}</th>
                <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">{u.colMessages}</th>
                <th scope="col" className="py-2 text-right font-medium">{u.colTokens}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.key} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="max-w-[220px] truncate py-2 pr-3 text-white/85">
                    {s.label || s.sessionId.slice(0, 16)}
                    <span className="ml-2 font-mono text-[10px] text-white/35">{formatRelative(s.updatedAt)}</span>
                  </td>
                  <td className="py-2 pr-3 text-white/70">{s.model}</td>
                  <td className="hidden py-2 pr-3 text-white/60 sm:table-cell">{humanChannel(s.channel)}</td>
                  <td className="hidden py-2 pr-3 text-right text-white/60 sm:table-cell">{s.usage?.messageCounts?.total ?? 0}</td>
                  <td className="py-2 text-right font-mono font-semibold text-cyan-200/90">{formatTokens(s.usage?.totalTokens ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="h-32 rounded-2xl border border-white/[0.06] bg-white/[0.02]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl border border-white/[0.06] bg-white/[0.02]" />
        ))}
      </div>
    </div>
  );
}
