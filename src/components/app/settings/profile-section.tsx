"use client";

import { Loader2, UserRound, Crown, Clock, Sparkles } from "lucide-react";
import { useProfile, useSubscriptionState } from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { openBillingPopup } from "@/lib/app/billing-popup";
import {
  getRoleLabel,
  getJurusanLabel,
  getIndustryLabel,
} from "@/lib/onboarding/professions";
import { getGoalLabel } from "@/lib/onboarding/goals";

// Read-only profile card: shows the identity the user gave at onboarding (their
// role/status, birthday, business or major, industry, focus) + a highlighted
// account-status banner (OP Buff subscription with crown, or trial days left).
// Only the email is shown verbatim (from Google, locked). No edit form.
export function ProfileSection() {
  const { t, locale } = useI18n();
  const p = t.app.settings.profile;
  const { data, isLoading } = useProfile();
  const { data: sub } = useSubscriptionState();

  const fmtDate = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    // noon avoids a timezone day-shift on a date-only string
    const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(locale === "en" ? "en-US" : "id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  const profile = data?.profile ?? null;
  const email = data?.user.email ?? "";
  const nickname = profile?.nickname || profile?.displayName || "";
  const roleLabel = getRoleLabel(profile?.role) ?? null;
  const industries = (profile?.industryIds ?? "")
    .split(",")
    .map((id) => getIndustryLabel(id.trim()))
    .filter((x): x is string => Boolean(x));

  const isSubscribed = sub?.status === "active" && sub.tier !== "starter";
  const trial = data?.trial ?? null;
  const onTrial = !isSubscribed && trial?.status === "active" && trial.daysLeft > 0;
  const tierName = sub?.tier === "guild_master" ? "Guild Master" : p.account.opBuff;
  const cycleName =
    sub?.billingCycle === "yearly" ? p.account.cycleYearly : p.account.cycleMonthly;

  const avatarGlyph = profile?.avatarEmoji?.trim() || nickname.slice(0, 1).toUpperCase() || "?";

  return (
    <section className="scroll-mt-4 overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 backdrop-blur-xl">
      {/* ── Account status banner (highlighted) ── */}
      {isSubscribed ? (
        <div className="flex items-center gap-3 border-b border-white/10 bg-gradient-to-r from-cyan-500/20 via-indigo-500/15 to-fuchsia-500/20 px-5 py-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_24px_-6px_rgba(99,102,241,0.6)]">
            <Crown className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="font-display text-sm font-black text-white">
              {tierName} · {p.account.active}
            </p>
            <p className="text-xs text-white/55">
              {cycleName}
              {sub?.expiresAt
                ? ` · ${p.account.until} ${fmtDate(sub.expiresAt)}`
                : ""}
            </p>
          </div>
        </div>
      ) : onTrial ? (
        <div className="flex items-center gap-3 border-b border-white/10 bg-cyan-400/[0.08] px-5 py-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-200">
            <Clock className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-bold text-white">
              {p.account.trial}
            </p>
            <p className="text-xs text-white/55">
              {p.account.daysLeftPrefix} {trial?.daysLeft} {p.account.daysLeftSuffix}
            </p>
          </div>
          <button
            type="button"
            onClick={() => openBillingPopup("/checkout", "agentbuff-billing-subscription")}
            className="shrink-0 rounded-lg bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-3 py-1.5 text-xs font-bold text-[#0B0E14] transition hover:brightness-110"
          >
            {p.account.upgradeCta}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 border-b border-white/10 bg-white/[0.02] px-5 py-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03] text-white/50">
            <Sparkles className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-bold text-white/90">
              {p.account.starter}
            </p>
            <p className="text-xs text-white/45">{p.account.starterDesc}</p>
          </div>
          <button
            type="button"
            onClick={() => openBillingPopup("/checkout", "agentbuff-billing-subscription")}
            className="shrink-0 rounded-lg bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-3 py-1.5 text-xs font-bold text-[#0B0E14] transition hover:brightness-110"
          >
            {p.account.upgradeCta}
          </button>
        </div>
      )}

      <div className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <UserRound className="size-4 text-cyan-300" />
          <h2 className="text-base font-semibold text-white">{p.title}</h2>
        </div>

        {isLoading || !data ? (
          <div className="flex items-center gap-2 py-4 text-sm text-white/50">
            <Loader2 className="size-4 animate-spin" /> {p.loading}
          </div>
        ) : (
          <>
            {/* Profile header */}
            <div className="mb-5 flex items-center gap-3">
              <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/20 text-2xl">
                {avatarGlyph}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-display text-lg font-black text-white">
                    {nickname || "—"}
                  </p>
                  {isSubscribed ? (
                    <Crown className="size-4 shrink-0 text-amber-300" />
                  ) : null}
                </div>
                {roleLabel ? (
                  <p className="text-sm text-cyan-300/90">{roleLabel}</p>
                ) : null}
              </div>
            </div>

            {/* Info grid (read-only) */}
            <dl className="grid gap-px overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <InfoRow label={p.emailLabel} value={email} locked={p.emailLocked} />
              {roleLabel ? <InfoRow label={p.status} value={roleLabel} /> : null}
              <InfoRow label={p.dob} value={fmtDate(profile?.dob)} fallback={p.notSet} />
              {profile?.businessName ? (
                <InfoRow label={p.businessName} value={profile.businessName} />
              ) : null}
              {getJurusanLabel(profile?.jurusan) ? (
                <InfoRow label={p.jurusan} value={getJurusanLabel(profile?.jurusan)} />
              ) : null}
              {industries.length ? (
                <InfoRow label={p.industry} value={industries.join(", ")} />
              ) : null}
              {getGoalLabel(profile?.focus) ? (
                <InfoRow label={p.focus} value={getGoalLabel(profile?.focus)} />
              ) : null}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}

function InfoRow({
  label,
  value,
  fallback,
  locked,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
  locked?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 bg-[#0B0E14]/40 px-3.5 py-3">
      <span className="shrink-0 text-xs font-medium text-white/45">{label}</span>
      <span className="flex items-center gap-2 truncate text-sm text-white/85">
        <span className="truncate">{value || fallback || "—"}</span>
        {locked ? (
          <span className="shrink-0 rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/40">
            {locked}
          </span>
        ) : null}
      </span>
    </div>
  );
}
