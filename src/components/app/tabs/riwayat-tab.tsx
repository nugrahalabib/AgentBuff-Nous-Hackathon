"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Receipt,
  Download,
  Crown,
  Zap,
  Package,
  CircleSlash,
  Search,
  X,
  RefreshCw,
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  SlidersHorizontal,
  Lock,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTransactions,
  useSubscriptionState,
  useProfile,
} from "@/hooks/use-api";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { formatPaymentMethod } from "@/lib/billing/payment-method";
import { cn } from "@/lib/utils";

const PERIODS = ["all", "7d", "30d", "90d"] as const;
const CATEGORIES = ["", "subscription", "topup", "skill-install"] as const;
const STATUSES = ["", "success", "pending", "failed"] as const;

// Settled "green" success states.
const PAID = new Set(["completed", "installed"]);
// Any state where MONEY WAS RECEIVED — incl. a paid skill whose install failed.
// These always get a struk (proof of payment) and must never read as a payment
// failure.
const MONEY_RECEIVED = new Set(["completed", "installed", "install_failed"]);

const TZ = "Asia/Jakarta";

function formatRp(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

// Client mirror of receipt-pdf.ts receiptNumber (AGB-<ymd>-<uuid no dashes>).
function strukNo(id: string, createdAtIso: string): string {
  const ymd = createdAtIso.slice(0, 10).replace(/-/g, "");
  return `AGB-${ymd}-${id.replace(/-/g, "").toUpperCase()}`;
}

// Normalize raw/legacy descriptions ("op_buff (monthly)") into friendly copy.
function friendlyDesc(desc: string): string {
  const d = desc.trim();
  const lower = d.toLowerCase();
  if (lower.startsWith("op_buff") || lower.startsWith("op buff")) {
    const yearly = lower.includes("year") || lower.includes("tahun");
    const perpanjang = lower.includes("perpanjang");
    return `OP Buff${perpanjang ? " — Perpanjang" : ""} (${yearly ? "Tahunan" : "Bulanan"})`;
  }
  return d;
}

function typeIcon(type: string) {
  if (type === "subscription") return <Crown className="size-4 text-fuchsia-300" />;
  if (type === "topup") return <Zap className="size-4 text-amber-300" />;
  if (type === "skill-install") return <Package className="size-4 text-cyan-300" />;
  return <Receipt className="size-4 text-white/40" />;
}

function statusIcon(s: string) {
  if (PAID.has(s)) return <CheckCircle2 className="size-3.5 text-emerald-300" />;
  if (s === "pending") return <Clock className="size-3.5 text-amber-300" />;
  if (s === "refunded") return <RefreshCw className="size-3.5 text-cyan-300" />;
  if (s === "install_failed")
    return <AlertTriangle className="size-3.5 text-amber-300" />;
  return <XCircle className="size-3.5 text-red-300" />;
}

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TZ,
  });
}

export function RiwayatTab() {
  const { t } = useI18n();
  const r = t.app.riwayat;
  const qc = useQueryClient();
  const router = useRouter();

  const [period, setPeriod] = useState<string>("all");
  const [category, setCategory] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Debounce the search box → q.
  useEffect(() => {
    const id = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const usingDateRange = Boolean(from || to);

  const { data, isLoading, error, refetch } = useTransactions({
    period: usingDateRange ? undefined : period,
    category: category || undefined,
    status: status || undefined,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined,
  });

  const { data: sub } = useSubscriptionState();
  const { data: profile } = useProfile();

  // Secondary filters (category + time) live behind the "Filter" disclosure.
  const secondaryCount =
    (category ? 1 : 0) + (period !== "all" ? 1 : 0) + (usingDateRange ? 1 : 0);
  const hasActiveFilters =
    status !== "" || q !== "" || searchInput !== "" || secondaryCount > 0;

  // We intentionally do NOT surface a "total spent" figure — anchoring users on
  // lifetime spend makes them self-limit, which hurts retention. Only the count
  // is shown, as a quiet record.
  const txCount = data?.length ?? 0;

  // Group transactions by month (of the displayed date) for a scannable ledger.
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: NonNullable<typeof data> }[] =
      [];
    const map = new Map<string, (typeof out)[number]>();
    for (const tx of data ?? []) {
      const d =
        MONEY_RECEIVED.has(tx.status) && tx.paidAt
          ? new Date(tx.paidAt)
          : new Date(tx.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: d.toLocaleDateString("id-ID", {
            month: "long",
            year: "numeric",
            timeZone: TZ,
          }),
          rows: [],
        };
        map.set(key, g);
        out.push(g);
      }
      g.rows.push(tx);
    }
    return out;
  }, [data]);

  const statusLabel = (s: string): string =>
    PAID.has(s)
      ? r.status.completed
      : s === "pending"
        ? r.status.pending
        : s === "install_failed"
          ? r.status.installIssue
          : s === "refunded"
            ? r.status.refunded
            : r.status.failed;

  const statusTone = (s: string): string =>
    PAID.has(s)
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
      : s === "pending" || s === "install_failed"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
        : s === "refunded"
          ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
          : "border-red-500/30 bg-red-500/10 text-red-200";

  const periodLabel = (p: string): string =>
    p === "all"
      ? r.filters.all
      : p === "7d"
        ? r.filters.last7d
        : p === "30d"
          ? r.filters.last30d
          : r.filters.last90d;

  const categoryLabel = (c: string): string =>
    c === ""
      ? r.filters.allCategories
      : c === "subscription"
        ? r.type.subscription
        : c === "topup"
          ? r.type.topup
          : r.type.skill;

  const statusFilterLabel = (s: string): string =>
    s === ""
      ? r.filters.allStatuses
      : s === "success"
        ? r.filters.statusSuccess
        : s === "pending"
          ? r.filters.statusPending
          : r.filters.statusFailed;

  // On-demand reconcile for a single pending row (fast settle path).
  const checkRowStatus = async (txId: string) => {
    setCheckingId(txId);
    try {
      const res = await fetch(`/api/billing/transactions/${txId}/reconcile`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      if (res.ok) {
        await refetch();
        void qc.invalidateQueries({ queryKey: ["subscription-state"] });
      }
    } catch {
      /* network error — leave the row as-is */
    } finally {
      setCheckingId(null);
    }
  };

  const onPickPeriod = (p: string) => {
    setPeriod(p);
    setFrom("");
    setTo("");
  };

  const resetAll = () => {
    setPeriod("all");
    setCategory("");
    setStatus("");
    setSearchInput("");
    setQ("");
    setFrom("");
    setTo("");
  };

  const sc = r.statusCard;
  const isSubscribed = sub?.status === "active" && sub.tier !== "starter";
  const trialDays = profile?.trial?.daysLeft ?? 0;
  const isTrial =
    !isSubscribed && profile?.trial?.status === "active" && trialDays > 0;
  const isExpired = !isSubscribed && !isTrial && sub?.status === "expired";
  const isCanceled = !isSubscribed && !isTrial && sub?.status === "canceled";
  const canRenew = isSubscribed && sub?.tier === "op_buff";

  // Countdown progress for the hero bar.
  const heroDays = isSubscribed
    ? (sub?.daysUntilExpire ?? 0)
    : isTrial
      ? trialDays
      : 0;
  const heroTotal = isTrial ? 14 : sub?.billingCycle === "yearly" ? 365 : 30;
  const heroPct = Math.max(
    3,
    Math.min(100, Math.round((heroDays / heroTotal) * 100)),
  );
  const heroSoon = heroDays > 0 && heroDays <= 7;

  const heroAccent = isSubscribed
    ? "border-fuchsia-400/25 from-fuchsia-500/[0.12] via-indigo-500/[0.05]"
    : isTrial
      ? "border-cyan-400/25 from-cyan-500/[0.10] via-cyan-500/[0.03]"
      : "border-white/[0.08] from-white/[0.04] via-transparent";

  const heroTitle = isSubscribed
    ? sc.statusActive
    : isTrial
      ? sc.statusTrial
      : isExpired
        ? sc.statusExpired
        : isCanceled
          ? sc.statusCanceled
          : sc.statusNone;

  const heroExpiryDate = isSubscribed
    ? sub?.expiresAt
    : isTrial
      ? (profile?.trial?.endsAt ?? null)
      : isExpired || isCanceled
        ? (sub?.expiresAt ?? null)
        : null;

  const chip = (active: boolean, accent: "cyan" | "fuchsia") =>
    cn(
      "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
      active
        ? accent === "cyan"
          ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
          : "border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-100"
        : "border-white/10 bg-white/[0.02] text-white/55 hover:border-white/20",
    );

  return (
    <div className="relative h-full overflow-y-auto px-4 py-6 xl:px-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-28">
        {/* Header */}
        <header className="flex items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/20">
            <Receipt className="size-5 text-cyan-200" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-black text-white">
              {r.title}
            </h1>
            <p className="mt-0.5 text-sm text-white/45">{r.subtitle}</p>
          </div>
        </header>

        {/* ── Status hero (focal point) ── */}
        <div
          className={cn(
            "relative overflow-hidden rounded-2xl border bg-gradient-to-br to-transparent p-5 backdrop-blur-xl",
            heroAccent,
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className={cn(
                  "relative grid size-11 shrink-0 place-items-center rounded-xl",
                  isSubscribed
                    ? "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14]"
                    : isTrial
                      ? "border border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                      : "border border-white/10 bg-white/[0.04] text-white/40",
                )}
              >
                {isSubscribed ? (
                  <Crown className="size-5" />
                ) : isTrial ? (
                  <Zap className="size-5" />
                ) : (
                  <Lock className="size-5" />
                )}
              </div>
              <div className="min-w-0">
                <p className="font-display text-base font-black text-white">
                  {heroTitle}
                </p>
                {heroExpiryDate ? (
                  <p className="mt-0.5 text-[13px] text-white/60">
                    {sc.activeUntil} {fmtLongDate(new Date(heroExpiryDate))}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[13px] text-white/50">
                    {isExpired || isCanceled ? sc.expiredHint : sc.noneHint}
                  </p>
                )}
                {isSubscribed && sub?.billingCycle ? (
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                    {sub.billingCycle === "yearly"
                      ? sc.cycleYearly
                      : sc.cycleMonthly}
                    {sub.priceRp ? ` · ${formatRp(sub.priceRp)}` : ""}
                  </p>
                ) : null}
              </div>
            </div>

            {/* CTA: renew (subscribed op_buff) / subscribe (everyone else, not enterprise) */}
            {canRenew ? (
              <button
                type="button"
                onClick={() => router.push("/app/shop?tab=langganan")}
                className="shrink-0 rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-3.5 py-2 text-xs font-bold text-[#0B0E14] shadow-[0_8px_24px_-8px_rgba(217,70,239,0.6)] transition hover:brightness-110 active:scale-[0.97]"
              >
                {t.plans.cta.renew}
              </button>
            ) : !isSubscribed ? (
              <button
                type="button"
                onClick={() => router.push("/app/shop?tab=langganan")}
                className="shrink-0 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3.5 py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20 active:scale-[0.97]"
              >
                {`${t.plans.cta.choosePrefix} OP Buff`}
              </button>
            ) : null}
          </div>

          {/* Countdown bar (active sub or trial) */}
          {(isSubscribed || isTrial) && heroDays > 0 ? (
            <div className="mt-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    heroSoon
                      ? "bg-gradient-to-r from-amber-400 to-orange-500"
                      : "bg-gradient-to-r from-cyan-400 to-fuchsia-500",
                  )}
                  style={{ width: `${heroPct}%` }}
                />
              </div>
              <p
                className={cn(
                  "mt-1.5 text-[11px] font-medium",
                  heroSoon ? "text-amber-200" : "text-white/45",
                )}
              >
                {sc.trialRemainingPrefix} {heroDays} {sc.trialDaysSuffix}
              </p>
            </div>
          ) : null}
        </div>

        {/* ── Search + status segmented + filter disclosure ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/30" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={r.filters.searchPlaceholder}
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  aria-label="Hapus pencarian"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-white/40 hover:text-white/80"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-semibold transition",
                showFilters || secondaryCount > 0
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                  : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20",
              )}
            >
              <SlidersHorizontal className="size-4" />
              {r.filters.more}
              {secondaryCount > 0 ? (
                <span className="grid size-4 place-items-center rounded-full bg-cyan-400 text-[9px] font-black text-[#0B0E14]">
                  {secondaryCount}
                </span>
              ) : null}
            </button>
          </div>

          {/* Status segmented control */}
          <div className="grid grid-cols-4 gap-1 rounded-xl border border-white/[0.06] bg-white/[0.03] p-1">
            {STATUSES.map((s) => (
              <button
                key={s || "all"}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  "rounded-lg py-1.5 text-xs font-semibold transition",
                  status === s
                    ? "bg-white/[0.10] text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                    : "text-white/45 hover:text-white/75",
                )}
              >
                {statusFilterLabel(s)}
              </button>
            ))}
          </div>

          {/* Secondary filters (collapsible) */}
          {showFilters ? (
            <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-[#0B0E14]/40 p-3">
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c || "all"}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={chip(category === c, "fuchsia")}
                  >
                    {categoryLabel(c)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onPickPeriod(p)}
                    className={chip(!usingDateRange && period === p, "cyan")}
                  >
                    {periodLabel(p)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-white/45">
                  {r.filters.dateFrom}
                  <input
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 [color-scheme:dark] focus:border-cyan-400/50 focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-white/45">
                  {r.filters.dateTo}
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 [color-scheme:dark] focus:border-cyan-400/50 focus:outline-none"
                  />
                </label>
                {usingDateRange ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFrom("");
                      setTo("");
                    }}
                    className="rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-white/55 transition hover:border-white/20"
                  >
                    {r.filters.resetDates}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasActiveFilters ? (
            <button
              type="button"
              onClick={resetAll}
              className="inline-flex w-fit items-center gap-1 self-end rounded-lg px-2 py-1 text-[11px] text-white/45 transition hover:text-white/80"
            >
              <RefreshCw className="size-3" />
              {r.filters.reset}
            </button>
          ) : null}
        </div>

        {/* ── Ledger ── */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-white/50">
            <Loader2 className="size-4 animate-spin" /> {r.loading}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-red-300">
            {r.error}
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-white/80 transition hover:border-cyan-400/40"
            >
              {r.retry}
            </button>
          </div>
        ) : !data || data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/[0.08] bg-[#0B0E14]/40 py-16 text-center text-sm text-white/45">
            <CircleSlash className="size-8 text-white/20" />
            {hasActiveFilters ? r.emptyFiltered : r.empty}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <p className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/30">
              {txCount} {r.summaryCount}
            </p>
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2">
                <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                  {group.label}
                </h2>
                <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 backdrop-blur-xl">
                  {group.rows.map((tx, i) => {
                    const moneyReceived = MONEY_RECEIVED.has(tx.status);
                    const pending = tx.status === "pending";
                    const date =
                      moneyReceived && tx.paidAt
                        ? new Date(tx.paidAt)
                        : new Date(tx.createdAt);
                    const method = formatPaymentMethod(tx.paymentMethod);
                    return (
                      <div
                        key={tx.id}
                        className={cn(
                          "px-4 py-3.5 transition hover:bg-white/[0.02]",
                          i > 0 && "border-t border-white/[0.05]",
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                            {typeIcon(tx.type)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-white/90">
                              {friendlyDesc(tx.description)}
                            </p>
                            <p className="mt-0.5 text-[11px] text-white/40">
                              {date.toLocaleDateString("id-ID", {
                                day: "numeric",
                                month: "short",
                                timeZone: TZ,
                              })}
                              {" · "}
                              {date.toLocaleTimeString("id-ID", {
                                hour: "2-digit",
                                minute: "2-digit",
                                timeZone: TZ,
                              })}
                              {method ? ` · ${method}` : ""}
                            </p>
                            {moneyReceived ? (
                              <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-white/25">
                                {strukNo(tx.id, tx.createdAt)}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <span className="font-display text-sm font-black text-white">
                              {formatRp(tx.amountRp)}
                            </span>
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                                statusTone(tx.status),
                              )}
                            >
                              {statusIcon(tx.status)}
                              {statusLabel(tx.status)}
                            </span>
                          </div>
                        </div>

                        {/* Row action: cek status (pending) / unduh struk (paid) */}
                        {pending ? (
                          <div className="mt-2.5 flex items-center justify-between gap-2 pl-12">
                            <span className="text-[11px] text-white/45">
                              {r.pendingHint}
                            </span>
                            <button
                              type="button"
                              disabled={checkingId === tx.id}
                              onClick={() => void checkRowStatus(tx.id)}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/[0.08] px-2.5 py-1 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-400/15 disabled:opacity-60"
                            >
                              {checkingId === tx.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <RefreshCw className="size-3" />
                              )}
                              {checkingId === tx.id ? r.checking : r.checkStatus}
                            </button>
                          </div>
                        ) : moneyReceived ? (
                          <div className="mt-2.5 flex justify-end pl-12">
                            <a
                              href={`/api/billing/transactions/${tx.id}/pdf`}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-semibold text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-100"
                            >
                              <Download className="size-3" />
                              {r.downloadStruk}
                            </a>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
