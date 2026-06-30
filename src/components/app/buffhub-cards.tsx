"use client";

// Beautiful in-chat renderers for BuffHub marketplace SEARCH + PURCHASE.
// The agent emits a fenced block with language `agentbuff-skills` (search) or
// `agentbuff-purchase` (buy). message-markdown.tsx intercepts those languages
// and renders these components instead of a raw code block. Design mirrors the
// basecamp /app dark kit (#0B0E14 surface, cyan accent, emerald success).
// All user-visible copy is bilingual via t.app.chat.buffhub.* (en/id locale).

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Store,
  Wallet,
  Headset,
  Megaphone,
  Rocket,
  Telescope,
  Building2,
  UserCheck,
  Sparkles,
  ShieldCheck,
  Check,
  Loader2,
  X,
  TrendingUp,
  ExternalLink,
  Receipt,
  Printer,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { localizeSkill } from "@/lib/billing/skill-catalog-i18n";

const ICONS: Record<string, LucideIcon> = {
  Store,
  Wallet,
  Headset,
  Megaphone,
  Rocket,
  Telescope,
  Building2,
  UserCheck,
  Sparkles,
};

const CATEGORY_ICON: Record<string, string> = {
  operasional: "Store",
  umkm: "Store",
  creator: "Megaphone",
  produktivitas: "Rocket",
  riset: "Telescope",
};

function resolveIcon(icon?: string, category?: string): LucideIcon {
  if (icon && ICONS[icon]) return ICONS[icon];
  if (category && CATEGORY_ICON[category] && ICONS[CATEGORY_ICON[category]]) {
    return ICONS[CATEGORY_ICON[category]];
  }
  return Sparkles;
}

function formatRp(n: number): string {
  return `Rp ${Math.max(0, Math.round(n || 0)).toLocaleString("id-ID")}`;
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function TrustChip() {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-emerald-300/90">
      <ShieldCheck className="size-3" aria-hidden />
      <span className="font-mono text-[9px] uppercase tracking-[0.14em]">{t.app.chat.buffhub.trustStripe}</span>
    </span>
  );
}

function buy(slug: string) {
  void useAppStore.getState().sendMessage(`Buy skill ${slug}`);
}

// ──────────────────────────────── SEARCH ────────────────────────────────

interface BuffhubSkill {
  name: string;
  slug: string;
  priceRp: number;
  tagline: string;
  status: "available" | "coming_soon";
  icon?: string;
  category?: string;
  description?: string;
}
interface BuffhubSearchPayload {
  query?: string;
  skills?: BuffhubSkill[];
}

function BeliButton({ slug, onClick }: { slug: string; onClick?: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
        buy(slug);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-semibold text-[#0B0E14]",
        "bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500",
        "shadow-[0_8px_24px_-8px_rgba(56,189,248,0.6)] transition-all hover:brightness-110 active:scale-[0.97]",
      )}
    >
      <Wallet className="size-4" aria-hidden />
      {t.app.chat.buffhub.buy}
    </button>
  );
}

function SkillResultCard({
  skill,
  index,
  onOpen,
}: {
  skill: BuffhubSkill;
  index: number;
  onOpen: (s: BuffhubSkill) => void;
}) {
  const { t } = useI18n();
  const Icon = resolveIcon(skill.icon, skill.category);
  const available = skill.status === "available";
  return (
    <motion.div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(skill);
        }
      }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index * 0.06, 0.4), ease: "easeOut" }}
      whileHover={{ y: -2 }}
      className={cn(
        "group relative w-full cursor-pointer overflow-hidden rounded-2xl border bg-[#0B0E14]/60 p-4 backdrop-blur-xl transition-all",
        "border-cyan-400/20 hover:border-cyan-400/50",
        "hover:shadow-[0_18px_50px_-16px_rgba(34,211,238,0.5)]",
      )}
    >
      <div
        className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-gradient-to-br from-cyan-400/15 to-fuchsia-500/10 blur-2xl"
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/15 to-indigo-500/10 text-cyan-200">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-[15px] font-semibold text-white/95">{skill.name}</h4>
            <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">
              {t.app.chat.buffhub.skillBadge}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-white/55">{skill.tagline}</p>
        </div>
        <span className="mt-0.5 shrink-0 self-center font-mono text-[9px] uppercase tracking-[0.14em] text-cyan-300/50 opacity-0 transition-opacity group-hover:opacity-100">
          {t.app.chat.buffhub.detail}
        </span>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[15px] font-bold text-white/90">{formatRp(skill.priceRp)}</span>
          <span className="mt-0.5"><TrustChip /></span>
        </div>
        {available ? (
          <BeliButton slug={skill.slug} />
        ) : (
          <span className="rounded-xl border border-amber-400/30 bg-amber-400/15 px-3 py-2 text-[12px] font-medium text-amber-100">
            {t.app.chat.buffhub.comingSoon}
          </span>
        )}
      </div>
    </motion.div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: BuffhubSkill; onClose: () => void }) {
  const { t } = useI18n();
  const Icon = resolveIcon(skill.icon, skill.category);
  const available = skill.status === "available";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 280, damping: 26 }}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-cyan-400/25 bg-[#0B0E14]/95 p-6 shadow-[0_30px_80px_-20px_rgba(34,211,238,0.45)] backdrop-blur-2xl"
      >
        <div
          className="pointer-events-none absolute -right-16 -top-16 size-44 rounded-full bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/10 blur-3xl"
          aria-hidden
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t.app.chat.buffhub.close}
          className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>

        <div className="flex items-start gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/20 to-indigo-500/10 text-cyan-200">
            <Icon className="size-7" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 pr-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">{t.app.chat.buffhub.buffhubSkill}</span>
            <h3 className="mt-1 text-[19px] font-bold leading-tight text-white">{skill.name}</h3>
            <p className="mt-0.5 text-[13px] text-white/55">{skill.tagline}</p>
          </div>
        </div>

        {skill.description ? (
          <p className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 text-[13px] leading-relaxed text-white/70">
            {skill.description}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-[22px] font-bold text-white">{formatRp(skill.priceRp)}</span>
            <TrustChip />
          </div>
          {available ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                buy(skill.slug);
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-[14px] font-semibold text-[#0B0E14]",
                "bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500",
                "shadow-[0_10px_30px_-8px_rgba(56,189,248,0.65)] transition-all hover:brightness-110 active:scale-[0.97]",
              )}
            >
              <Wallet className="size-4" aria-hidden />
              {t.app.chat.buffhub.buyNow}
            </button>
          ) : (
            <span className="rounded-2xl border border-amber-400/30 bg-amber-400/15 px-4 py-3 text-[13px] font-medium text-amber-100">
              {t.app.chat.buffhub.comingSoon}
            </span>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

export function BuffhubSkills({ raw }: { raw: string }) {
  const { t, locale } = useI18n();
  const data = safeParse<BuffhubSearchPayload>(raw);
  const skills = (data?.skills ?? []).map((s) => localizeSkill(s, locale));
  const [selected, setSelected] = useState<BuffhubSkill | null>(null);

  if (!data || skills.length === 0) {
    return (
      <div className="my-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[13px] text-white/55">
        {t.app.chat.buffhub.noResults}
      </div>
    );
  }
  return (
    <div className="my-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Sparkles className="size-3.5 text-cyan-300" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">{t.app.chat.buffhub.marketplace}</span>
        <span className="text-[11px] text-white/35">· {skills.length} {t.app.chat.buffhub.skillsFound}</span>
      </div>
      <div className="grid gap-2.5">
        {skills.map((s, i) => (
          <SkillResultCard key={s.slug || i} skill={s} index={i} onOpen={setSelected} />
        ))}
      </div>
      <AnimatePresence>
        {selected ? <SkillDetailModal skill={selected} onClose={() => setSelected(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────── PURCHASE ───────────────────────────────

interface BuffhubPurchasePayload {
  name: string;
  slug: string;
  priceRp: number;
  status: "purchased" | "failed";
  icon?: string;
  webAppUrl?: string;
  receiptRef?: string;
  paidAt?: string;
  paymentRef?: string;
}

function formatStrukDate(iso?: string): string {
  if (!iso) return "";
  try {
    return (
      new Date(iso).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }) + " WIB"
    );
  } catch {
    return "";
  }
}

export function BuffhubPurchase({ raw }: { raw: string }) {
  const { t, locale } = useI18n();
  const data = safeParse<BuffhubPurchasePayload>(raw);
  const slug = data?.slug;
  const purchased = data?.status === "purchased";
  // Receipt details (date/ref/order) come from the SERVER by slug — NOT from the
  // agent-pasted block, which Nemotron may trim. The block is only a fallback.
  const [receipt, setReceipt] = useState<{
    orderId?: string;
    paidAt?: string;
    paymentRef?: string;
  } | null>(null);
  useEffect(() => {
    if (!purchased) return;
    let alive = true;
    const url = slug
      ? `/api/me/last-receipt?slug=${encodeURIComponent(slug)}`
      : `/api/me/last-receipt`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j?.found) {
          setReceipt({ orderId: j.orderId, paidAt: j.paidAt, paymentRef: j.paymentRef });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [purchased, slug]);

  if (!data) {
    return (
      <div className="my-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[13px] text-white/55">
        {t.app.chat.buffhub.purchaseProcessing}
      </div>
    );
  }
  const ok = data.status === "purchased";
  const Icon = resolveIcon(data.icon);

  if (!ok) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="my-3 overflow-hidden rounded-2xl border border-red-500/40 bg-red-500/[0.06] p-4 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-red-500/15 text-red-300">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="flex-1">
            <p className="text-[14px] font-semibold text-red-100">{t.app.chat.buffhub.purchaseFailed}</p>
            <p className="text-[12px] text-red-200/70">{data.name} {t.app.chat.buffhub.notPurchasedSuffix}</p>
          </div>
          <button
            type="button"
            onClick={() => buy(data.slug)}
            className="rounded-xl border border-red-500/50 bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-100 transition-colors hover:bg-red-500/30"
          >
            {t.app.chat.buffhub.retry}
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 22 }}
      className={cn(
        "relative my-3 overflow-hidden rounded-2xl border border-emerald-400/40 bg-[#0B0E14]/70 p-4 backdrop-blur-xl",
        "shadow-[0_0_44px_-8px_rgba(16,185,129,0.55)] ring-1 ring-emerald-400/30",
      )}
    >
      <div
        className="pointer-events-none absolute -left-10 -top-10 size-28 rounded-full bg-emerald-400/15 blur-2xl"
        aria-hidden
      />
      <div className="flex items-center gap-3">
        <motion.span
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 16, delay: 0.08 }}
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300"
        >
          <Check className="size-5" strokeWidth={3} aria-hidden />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-emerald-200/90" aria-hidden />
            <h4 className="truncate text-[15px] font-semibold text-white/95">{data.name}</h4>
          </div>
          <p className="text-[12.5px] text-emerald-200/75">{t.app.chat.buffhub.purchaseSuccess}</p>
        </div>
      </div>
      {/* Inline receipt / proof of payment — shown right in chat */}
      <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Receipt className="size-3.5 text-emerald-300/80" aria-hidden />
          <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-emerald-300/70">
            {t.app.chat.buffhub.receiptTitle}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="min-w-0 truncate pr-2 text-white/60">1× {data.name}</span>
          <span className="shrink-0 text-white/85">{formatRp(data.priceRp)}</span>
        </div>
        <div className="mt-2 space-y-1 border-t border-dashed border-white/[0.08] pt-2 text-[11px]">
          <div className="flex justify-between">
            <span className="text-white/40">{t.app.chat.buffhub.method}</span>
            <span className="text-white/65">{t.app.chat.buffhub.methodValue}</span>
          </div>
          {receipt?.paidAt ?? data.paidAt ? (
            <div className="flex justify-between">
              <span className="text-white/40">{t.app.chat.buffhub.date}</span>
              <span className="text-white/65">{formatStrukDate(receipt?.paidAt ?? data.paidAt)}</span>
            </div>
          ) : null}
          {receipt?.paymentRef ?? data.paymentRef ? (
            <div className="flex justify-between gap-3">
              <span className="text-white/40">{t.app.chat.buffhub.ref}</span>
              <span className="truncate font-mono text-[10px] text-white/55">{receipt?.paymentRef ?? data.paymentRef}</span>
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.08] pt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/25">
            <Check className="size-3" strokeWidth={3} aria-hidden /> {t.app.chat.buffhub.paid}
          </span>
          <span className="text-[15px] font-bold text-emerald-100">{formatRp(data.priceRp)}</span>
        </div>
      </div>
      {receipt?.orderId ?? data.receiptRef ? (
        <a
          href={`/struk/${encodeURIComponent((receipt?.orderId ?? data.receiptRef) as string)}?lang=${locale}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-[12.5px] font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
        >
          <Printer className="size-4" aria-hidden />
          {t.app.chat.buffhub.fullReceipt}
        </a>
      ) : null}
      {data.webAppUrl ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <a
            href={data.webAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold text-[#0B0E14]",
              "bg-gradient-to-r from-emerald-300 via-emerald-400 to-cyan-400",
              "shadow-[0_8px_24px_-8px_rgba(16,185,129,0.6)] transition-all hover:brightness-110 active:scale-[0.98]",
            )}
          >
            <ExternalLink className="size-4" aria-hidden />
            {t.app.chat.buffhub.openPosApp}
          </a>
          <p className="text-center text-[11px] text-white/45">
            {t.app.chat.buffhub.operateHint}
          </p>
        </div>
      ) : null}
    </motion.div>
  );
}

// ───────────────────────── POS REPORT (via MCP) ─────────────────────────

interface PosReportPayload {
  period?: string;
  omzet?: number;
  transaksi?: number;
  ringkasan?: string;
}

export function BuffhubPosReport({ raw }: { raw: string }) {
  const { t, locale } = useI18n();
  const d = safeParse<PosReportPayload>(raw);
  if (!d) {
    return (
      <div className="my-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[13px] text-white/55">
        {t.app.chat.buffhub.posReportProcessing}
      </div>
    );
  }
  const period = d.period ?? t.app.chat.buffhub.periodToday;
  const reportTitle =
    locale === "en"
      ? `POS UMKM · ${period} ${t.app.chat.buffhub.reportWord}`
      : `POS UMKM · ${t.app.chat.buffhub.reportWord} ${period}`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 22 }}
      className={cn(
        "relative my-3 overflow-hidden rounded-2xl border border-emerald-400/30 bg-[#0B0E14]/70 p-4 backdrop-blur-xl",
        "shadow-[0_0_44px_-10px_rgba(16,185,129,0.45)]",
      )}
    >
      <div
        className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-emerald-400/15 blur-2xl"
        aria-hidden
      />
      <div className="mb-2 flex items-center gap-2">
        <TrendingUp className="size-3.5 text-emerald-300" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">
          {reportTitle}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[11px] text-white/45">{t.app.chat.buffhub.revenue}</span>
          <div className="text-[26px] font-bold leading-tight text-white">{formatRp(d.omzet ?? 0)}</div>
        </div>
        <div className="shrink-0 text-right">
          <span className="text-[11px] text-white/45">{t.app.chat.buffhub.transactions}</span>
          <div className="text-[20px] font-semibold text-emerald-200">{d.transaksi ?? 0}</div>
        </div>
      </div>
      {d.ringkasan ? (
        <p className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12.5px] leading-relaxed text-white/70">
          {d.ringkasan}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-end border-t border-white/[0.06] pt-2.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-emerald-300/90">
          <ShieldCheck className="size-3" aria-hidden />
          <span className="font-mono text-[9px] uppercase tracking-[0.14em]">{t.app.chat.buffhub.posMcpLive}</span>
        </span>
      </div>
    </motion.div>
  );
}

export function BuffhubProcessing() {
  const { t } = useI18n();
  return (
    <div className="my-3 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
      <Loader2 className="size-4 animate-spin text-cyan-300" aria-hidden />
      <span className="text-[13px] text-white/60">{t.app.chat.buffhub.payingViaStripe}</span>
      <span className="ml-auto"><TrustChip /></span>
    </div>
  );
}
