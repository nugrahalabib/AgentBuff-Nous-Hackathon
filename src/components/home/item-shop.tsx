"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Crown, Castle, Coins, Rocket } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { EarlyAccessModal } from "@/components/home/early-access-modal";
import { openBillingPopup } from "@/lib/app/billing-popup";
import {
  PLANS_ORDERED,
  formatRp,
  type PlanTier,
  type PlanDef,
} from "@/lib/billing/plans";
import { usePricing } from "@/hooks/use-api";

// Whole months saved by paying yearly vs 12x monthly, from EFFECTIVE prices
// (admin override > catalog) rather than the static catalog helper.
function saveMonthsFor(m: number | null, y: number | null): number {
  if (!m || !y) return 0;
  return Math.max(0, Math.round((m * 12 - y) / m));
}

/* ─── Tier visual configs (keyed by PlanTier — plans.ts is the catalog) ─── */
type TierVisual = {
  Icon: typeof Coins;
  iconGradient: string;
  border: string;
  borderHover: string;
  checkColor: string;
  btnClass: string;
  glowActive: boolean;
};

const NEUTRAL_BTN =
  "border border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.06] dark:text-white/70 dark:hover:bg-white/[0.10] dark:hover:text-white";

const TIER_VISUALS: Record<PlanTier, TierVisual> = {
  starter: {
    Icon: Rocket,
    iconGradient: "from-emerald-400 to-cyan-500",
    border: "border-emerald-500/30 dark:border-emerald-500/15",
    borderHover: "border-emerald-500/50 dark:border-emerald-400/30",
    checkColor: "text-emerald-500",
    btnClass: NEUTRAL_BTN,
    glowActive: false,
  },
  op_buff: {
    Icon: Crown,
    iconGradient: "from-cyan-400 to-violet-500",
    border: "border-cyan-500/40 dark:border-cyan-500/25",
    borderHover: "border-cyan-500/60 dark:border-cyan-400/40",
    checkColor: "text-cyan-500",
    btnClass:
      "bg-gradient-to-r from-cyan-500 via-indigo-500 to-violet-500 text-white shadow-[0_0_30px_-5px_rgba(6,182,212,0.4)] hover:shadow-[0_0_45px_-5px_rgba(6,182,212,0.55)] hover:brightness-110",
    glowActive: true,
  },
  full_managed: {
    Icon: Coins,
    iconGradient: "from-slate-400 to-slate-500",
    border: "border-slate-200 dark:border-white/[0.08]",
    borderHover: "border-slate-300 dark:border-white/[0.15]",
    checkColor: "text-slate-500",
    btnClass: NEUTRAL_BTN,
    glowActive: false,
  },
  guild_master: {
    Icon: Castle,
    iconGradient: "from-amber-400 to-orange-500",
    border: "border-amber-500/30 dark:border-amber-500/15",
    borderHover: "border-amber-500/50 dark:border-amber-400/30",
    checkColor: "text-amber-500",
    btnClass: NEUTRAL_BTN,
    glowActive: false,
  },
};

/* ─── Pricing Card ─── */
function PricingCard({
  def,
  visual,
  copy,
  priceText,
  periodText,
  savedLabel,
  ctaLabel,
  freeTrial,
  index,
  onCtaClick,
}: {
  def: PlanDef;
  visual: TierVisual;
  copy: { name: string; tagline: string; features: readonly string[] };
  // priceText null = no buyable price (enterprise → "Custom"); the card shows the
  // tagline in the price slot instead of a false purchase affordance.
  priceText: string | null;
  periodText: string;
  savedLabel: string | null;
  ctaLabel: string;
  // Set only for the free Starter tier — folds the old standalone "coba gratis"
  // banner (badge + desc) into the card itself.
  freeTrial: { badge: string; desc: string } | null;
  index: number;
  onCtaClick: () => void;
}) {
  const isPro = def.highlighted;
  const isFreeTrial = freeTrial !== null;
  const Icon = visual.Icon;
  // No buyable price (enterprise) → mirror the old "coming-soon" treatment: show
  // status copy in the price slot, hide the savings badge.
  const showPrice = priceText !== null;

  return (
    <motion.div
      className={`relative ${isPro ? "lg:z-20" : "lg:z-10"}`}
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
    >
      {/* Crown floating above center card */}
      {isPro && (
        <motion.div
          className="absolute -top-6 left-1/2 z-30 -translate-x-1/2"
          animate={{ y: [0, -4, 0] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 shadow-[0_0_25px_rgba(6,182,212,0.5)]">
            <Crown className="size-6 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.4)]" />
          </div>
        </motion.div>
      )}

      {/* "GRATIS 14 HARI" ribbon floating above the free Starter card — the
          standalone banner's headline copy, folded into the card. */}
      {isFreeTrial && (
        <div className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
          <span className="whitespace-nowrap rounded-full border border-emerald-300/60 bg-gradient-to-r from-emerald-500 to-cyan-500 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-white shadow-[0_0_20px_-4px_rgba(16,185,129,0.7)]">
            {freeTrial.badge}
          </span>
        </div>
      )}

      <motion.div
        className={`relative flex h-full flex-col overflow-hidden rounded-2xl border backdrop-blur-xl sm:rounded-3xl transition-all duration-300 ${
          visual.border
        } ${isPro ? "lg:scale-[1.05]" : ""} ${
          isPro
            ? "bg-gradient-to-br from-cyan-50 via-violet-50 to-white shadow-[0_0_60px_-15px_rgba(6,182,212,0.25)] dark:from-cyan-500/[0.08] dark:via-violet-500/[0.06] dark:to-slate-900/70 dark:shadow-[0_0_60px_-15px_rgba(6,182,212,0.15)]"
            : isFreeTrial
              ? "bg-gradient-to-br from-emerald-50 via-cyan-50/60 to-white shadow-[0_0_40px_-16px_rgba(16,185,129,0.35)] dark:from-emerald-500/[0.08] dark:via-cyan-500/[0.04] dark:to-slate-900/70"
              : "bg-gradient-to-br from-white to-slate-50 shadow-sm dark:from-white/[0.04] dark:to-slate-900/60 dark:shadow-none"
        }`}
        whileHover={{ y: isPro ? -8 : -4 }}
      >
        {/* Inner content */}
        <div className={`p-6 sm:p-8 ${isPro ? "pt-8 sm:pt-10" : isFreeTrial ? "pt-7 sm:pt-9" : ""}`}>
          {/* Top row: icon + tier info */}
          <div className="flex items-center gap-3">
            <div className={`flex size-10 items-center justify-center rounded-xl bg-gradient-to-br ${visual.iconGradient} shadow-lg`}>
              <Icon className="size-5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
            </div>
            <div>
              <p className={`text-sm font-bold ${isPro ? "text-slate-900 dark:text-white" : "text-slate-800 dark:text-white/80"}`}>{copy.name}</p>
              {showPrice && (
                <p className="text-[11px] text-slate-500 dark:text-white/25">{copy.tagline}</p>
              )}
            </div>
          </div>

          {/* Price — no-price tiers (enterprise) show their tagline, not a buyable
              price + savings badge (avoids a false purchase affordance). */}
          {!showPrice ? (
            <div className="mt-6 flex h-12 items-center">
              <span className="text-xl font-bold text-slate-400 dark:text-white/40">
                {copy.tagline}
              </span>
            </div>
          ) : (
            <div className="mt-6 flex h-12 items-baseline gap-1.5">
              <AnimatePresence mode="wait">
                <motion.span
                  key={priceText}
                  className="whitespace-nowrap text-[2rem] font-black tracking-tight text-slate-900 sm:text-[2.5rem] dark:text-white"
                  style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  {priceText}
                </motion.span>
              </AnimatePresence>
              {periodText && (
                <span className="whitespace-nowrap text-sm text-slate-500 dark:text-white/25">{periodText}</span>
              )}
            </div>
          )}

          {/* Yearly save label */}
          {showPrice && savedLabel && (
            <motion.span
              className="mt-2 inline-block rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400"
              initial={{ scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              {savedLabel}
            </motion.span>
          )}

          {/* CTA Button */}
          <motion.button
            className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold tracking-wide transition-all ${visual.btnClass}`}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={onCtaClick}
          >
            {ctaLabel}
          </motion.button>

          {/* Free-trial reassurance — the standalone banner's body copy, now
              living inside the card it describes. */}
          {isFreeTrial && (
            <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/[0.08] px-3 py-2 text-center text-[11px] font-medium leading-relaxed text-emerald-700 dark:text-emerald-300">
              {freeTrial.desc}
            </p>
          )}

          {/* Divider */}
          <div className="my-6 h-px bg-slate-200 dark:bg-white/[0.06]" />

          {/* Features */}
          <ul className="flex flex-col gap-3">
            {copy.features.map((f, j) => (
              <li key={j} className="flex items-start gap-3">
                <Check className={`mt-0.5 size-4 flex-shrink-0 ${visual.checkColor}`} />
                <span className="text-sm leading-relaxed text-slate-600 dark:text-white/45">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Item Shop Pricing
   ═══════════════════════════════════════════════════ */
export function HomeItemShop() {
  const { t } = useI18n();
  const s = t.itemShop;
  const p = t.plans;
  const [isYearly, setIsYearly] = useState(false);
  const [earlyAccessOpen, setEarlyAccessOpen] = useState(false);
  // Admin-effective prices/status (placeholderData = static catalog, so the
  // grid renders instantly and degrades to the compiled-in default offline).
  const { data: pricingData } = usePricing();
  const pricing = pricingData?.plans;

  // CTA dispatch driven by the plan catalog's ctaKind — single source of truth.
  const handleTierCta = (def: PlanDef) => {
    switch (def.ctaKind) {
      case "subscribe":
        // OP Buff — full-page exclusive checkout, carrying the period the user
        // picked with the Bulanan/Tahunan toggle. /checkout handles both: guests
        // get a "daftar dulu" panel, members get the Snap embed.
        openBillingPopup(`/checkout?cycle=${isYearly ? "yearly" : "monthly"}`);
        return;
      case "early_access":
        // Full Managed — COMING SOON. Opens the early-access form, which records
        // the lead server-side (/api/early-access → early_access_lead) for the
        // Admin page to read. NOT buyable yet, so never sent to /register.
        setEarlyAccessOpen(true);
        return;
      case "external":
        // Guild Master — enterprise/custom, handled by Spead AI (Chief's
        // enterprise arm for corporate / BUMN / Gov projects).
        if (def.externalUrl) {
          window.open(def.externalUrl, "_blank", "noopener,noreferrer");
        }
        return;
      case "current":
        // Starter (free) — no purchase. Send to login (Google-only auth; the
        // register route was removed) to start the free trial. assign() (not
        // href=) keeps the react-hooks/immutability lint happy.
        window.location.assign("/login");
        return;
    }
  };

  const cycle = isYearly ? "yearly" : "monthly";

  // CTA label by ctaKind. The subscribe button composes "${choosePrefix} ${name}".
  const ctaLabelFor = (def: PlanDef, name: string): string => {
    switch (def.ctaKind) {
      case "subscribe":
        return `${p.cta.choosePrefix} ${name}`;
      case "early_access":
        return p.cta.earlyAccess;
      case "external":
        return p.cta.enterprise;
      case "current":
        return s.freeTrialBanner.cta;
    }
  };

  return (
    <section id="item-shop" className="relative overflow-hidden bg-white py-16 dark:bg-[#030014] sm:py-24 lg:py-28">
      {/* Grid bg */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.3) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Ambient glow for center card */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-2/3 h-[500px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/5 blur-[180px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* ── Header ── */}
        <motion.div
          className="mb-10 text-center sm:mb-12"
          initial={{ y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <h2
            className="text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl"
            style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
          >
            {s.title}{" "}
            <span className="bg-gradient-to-r from-cyan-500 via-fuchsia-500 to-indigo-500 bg-clip-text text-transparent dark:from-cyan-400 dark:via-fuchsia-400 dark:to-indigo-400">
              {s.titleHighlight}
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-500 dark:text-white/40 sm:text-base">
            {s.subtitle}
          </p>
        </motion.div>

        {/* ── Monthly / Yearly Toggle ── */}
        <motion.div
          className="mb-14 flex items-center justify-center gap-3 sm:mb-16"
          initial={{ y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2 }}
        >
          <span className={`text-sm font-medium transition-colors ${!isYearly ? "text-slate-900 dark:text-white" : "text-slate-500 dark:text-white/30"}`}>
            {s.toggleMonthly}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isYearly}
            aria-label={`${s.toggleMonthly} / ${s.toggleYearly}`}
            onClick={() => setIsYearly(!isYearly)}
            className="relative flex h-7 w-[52px] items-center rounded-full border border-slate-200 bg-slate-100 p-0.5 backdrop-blur-md transition-colors hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.06] dark:hover:border-white/20"
          >
            <motion.div
              className="size-6 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 shadow-[0_0_10px_rgba(6,182,212,0.4)]"
              animate={{ x: isYearly ? 23 : 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            />
          </button>
          <span className={`text-sm font-medium transition-colors ${isYearly ? "text-slate-900 dark:text-white" : "text-slate-500 dark:text-white/30"}`}>
            {s.toggleYearly}
          </span>
          {isYearly && (
            <motion.span
              className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              {s.saveLabel}
            </motion.span>
          )}
        </motion.div>

        {/* ── Pricing Grid ── */}
        {/* items-stretch = cards become equal height + aligned (no staggered
            float). Wider gap gives the scaled center card room to breathe. The
            highlighted (OP Buff) card stands out via scale + crown + glow. The
            tier list is driven by PLANS_ORDERED (plans.ts catalog). */}
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-4 lg:items-stretch lg:gap-6">
          {PLANS_ORDERED.map((def, i) => {
            const copy = p.tiers[def.tier];
            // Overlay admin-effective price + status onto the catalog def; visuals
            // / order / ctaKind stay catalog-driven.
            const eff = pricing?.[def.tier] ?? def;
            const savedMonths = saveMonthsFor(eff.priceMonthly, eff.priceYearly);
            // Starter (free) shows "Gratis"; enterprise shows no price (Custom via
            // tagline slot). Everything else shows the formatted effective price.
            const priceText =
              eff.status === "free"
                ? p.free
                : eff.status === "enterprise"
                  ? null
                  : formatRp(
                      (cycle === "yearly" ? eff.priceYearly : eff.priceMonthly) ?? 0,
                    );
            const periodText =
              eff.status === "free" || eff.status === "enterprise"
                ? ""
                : isYearly
                  ? p.perYear
                  : p.perMonth;
            const savedLabel =
              isYearly && savedMonths > 0
                ? `${p.saveMonthsPrefix}${savedMonths} ${p.saveMonthsSuffix}`
                : null;

            return (
              <PricingCard
                key={def.tier}
                def={def}
                visual={TIER_VISUALS[def.tier]}
                copy={copy}
                priceText={priceText}
                periodText={periodText}
                savedLabel={savedLabel}
                ctaLabel={ctaLabelFor(def, copy.name)}
                freeTrial={
                  eff.status === "free"
                    ? { badge: s.freeTrialBanner.badge, desc: s.freeTrialBanner.desc }
                    : null
                }
                index={i}
                onCtaClick={() => handleTierCta(def)}
              />
            );
          })}
        </div>

        {/* 14-day free-trial guarantee — surfaced inside the price list so the
            trial promise lives with the pricing, not just elsewhere on the
            page. (s.guarantee was previously defined but never rendered.) */}
        <p className="mx-auto mt-10 max-w-xl text-center text-sm font-medium text-slate-500 dark:text-white/45">
          {s.guarantee}
        </p>
      </div>

      <EarlyAccessModal
        open={earlyAccessOpen}
        onClose={() => setEarlyAccessOpen(false)}
        tier="full-managed"
      />
    </section>
  );
}
