"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Calendar, Check, ChevronDown, Rocket, Sparkles, User } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { OnboardingAnswers } from "@/lib/onboarding/answers";
import { COUNTRIES, getCitiesForCountry } from "@/lib/onboarding/locations";
import {
  ROLES,
  INDUSTRIES,
  JURUSAN,
  roleCategory,
} from "@/lib/onboarding/professions";
import { GOALS, validGoalIds } from "@/lib/onboarding/goals";
import {
  Chip,
  FieldLabel,
  FieldNote,
  SelectField,
  SelectWithOther,
  StepHeader,
  TextField,
} from "./primitives";

const MAX_INTERESTS = 5;

export interface StepProps {
  answers: OnboardingAnswers;
  set: (patch: Partial<OnboardingAnswers>) => void;
}

const DOB_MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// Date-of-birth picker as 3 dropdowns in dd / month / yyyy order. The native
// <input type="date"> renders mm/dd/yyyy under a US browser locale (not
// controllable via attributes), so we own the order explicitly. Stores the same
// YYYY-MM-DD string in answers.dob; clamps the day to the selected month length.
function DobField({
  label,
  note,
  value,
  onChange,
}: {
  label: ReactNode;
  note?: ReactNode;
  value: string;
  onChange: (v: string) => void;
}) {
  // Keep the 3 parts in LOCAL state so a partial pick (e.g. day before month/
  // year) STICKS. answers.dob only receives a value once all 3 are chosen (it
  // needs a full YYYY-MM-DD, which isKenalanValid requires). Initialised from
  // the stored value for resume.
  const init = value ? value.split("-") : [];
  const [dob, setDob] = useState({
    y: init[0] ?? "",
    m: init[1] ?? "",
    d: init[2] ?? "",
  });

  const update = (patch: Partial<{ d: string; m: string; y: string }>) => {
    // Compute the next parts from the current closure value, then commit BOTH
    // the local state and the parent onChange in the event handler. onChange
    // must NOT live inside the setDob updater — React runs updaters during the
    // render phase, so calling the parent's setState there throws
    // "Cannot update a component while rendering a different component".
    const next = { ...dob, ...patch };
    setDob(next);
    if (next.d && next.m && next.y) {
      const max = new Date(Number(next.y), Number(next.m), 0).getDate();
      const cd = String(Math.min(Number(next.d), max)).padStart(2, "0");
      onChange(`${next.y}-${next.m}-${cd}`);
    } else {
      onChange("");
    }
  };

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 100 }, (_, i) => String(thisYear - i));
  const daysInMonth =
    dob.m && dob.y ? new Date(Number(dob.y), Number(dob.m), 0).getDate() : 31;
  const days = Array.from({ length: daysInMonth }, (_, i) =>
    String(i + 1).padStart(2, "0"),
  );

  const selCls = cn(
    "h-11 w-full appearance-none rounded-xl border border-white/10 bg-white/[0.03] px-3 pr-8 text-sm transition-all focus:outline-none",
    "focus:border-cyan-400/70 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(34,211,238,0.12)]",
  );
  const chev = (
    <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-white/40" />
  );

  return (
    <div className="flex flex-col">
      <FieldLabel>{label}</FieldLabel>
      <div className="grid grid-cols-[1fr_1.5fr_1.1fr] gap-2">
        <div className="relative">
          <select
            value={dob.d}
            onChange={(e) => update({ d: e.target.value })}
            aria-label="Tanggal"
            className={cn(selCls, dob.d ? "text-white" : "text-white/30")}
          >
            <option value="" disabled>Tgl</option>
            {days.map((d) => (
              <option key={d} value={d} className="bg-[#0B0E14]">
                {Number(d)}
              </option>
            ))}
          </select>
          {chev}
        </div>
        <div className="relative">
          <select
            value={dob.m}
            onChange={(e) => update({ m: e.target.value })}
            aria-label="Bulan"
            className={cn(selCls, dob.m ? "text-white" : "text-white/30")}
          >
            <option value="" disabled>Bulan</option>
            {DOB_MONTHS.map((name, i) => {
              const m = String(i + 1).padStart(2, "0");
              return (
                <option key={m} value={m} className="bg-[#0B0E14]">
                  {name}
                </option>
              );
            })}
          </select>
          {chev}
        </div>
        <div className="relative">
          <select
            value={dob.y}
            onChange={(e) => update({ y: e.target.value })}
            aria-label="Tahun"
            className={cn(selCls, dob.y ? "text-white" : "text-white/30")}
          >
            <option value="" disabled>Tahun</option>
            {years.map((y) => (
              <option key={y} value={y} className="bg-[#0B0E14]">
                {y}
              </option>
            ))}
          </select>
          {chev}
        </div>
      </div>
      {note ? <FieldNote>{note}</FieldNote> : null}
    </div>
  );
}

// ── Step 1: Kenalan ──────────────────────────────────────────────────────
export function StepKenalan({ answers, set }: StepProps) {
  const { t } = useI18n();
  const c = t.onboarding.kenalan;
  const countryOptions = COUNTRIES.map((o) => ({ value: o.id, label: o.label }));
  const cityOptions = getCitiesForCountry(answers.country).map((o) => ({
    value: o.id,
    label: o.label,
  }));

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<Sparkles className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />

      {/* Nickname (hero) */}
      <TextField
        label={c.nicknameLabel}
        icon={<Sparkles className="size-4" />}
        placeholder={c.nicknamePlaceholder}
        value={answers.nickname}
        onChange={(v) => set({ nickname: v })}
        maxLength={60}
        autoFocus
      />

      {/* DOB — explicit dd / month / yyyy order (the native date input shows
          mm/dd/yyyy under a US browser locale, which can't be forced). */}
      <DobField
        label={
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5" />
            {c.dobLabel}
          </span>
        }
        note={c.dobNote}
        value={answers.dob}
        onChange={(v) => set({ dob: v })}
      />

      {/* Country + city side-by-side (city cascades on country) — less stacking. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectWithOther
          label={c.countryLabel}
          value={answers.country}
          onChange={(v) => set({ country: v, city: "" })}
          placeholder={c.countryPlaceholder}
          options={countryOptions}
          otherLabel={c.otherLabel}
          otherPlaceholder={c.countryOtherPlaceholder}
        />
        <SelectWithOther
          label={c.cityLabel}
          value={answers.city}
          onChange={(v) => set({ city: v })}
          placeholder={c.cityPlaceholder}
          options={cityOptions}
          otherLabel={c.otherLabel}
          otherPlaceholder={c.cityOtherPlaceholder}
          note={c.cityNote}
        />
      </div>

      {/* Referral — secondary, demoted below a hairline so the required identity
          fields stay the focus. */}
      <div className="border-t border-white/[0.06] pt-4">
        <SelectWithOther
          label={c.referralLabel}
          value={answers.referralSource}
          onChange={(v) => set({ referralSource: v })}
          placeholder={c.referralPlaceholder}
          options={c.referrals.map((r) => ({ value: r.id, label: r.label }))}
          otherLabel={c.otherLabel}
          otherPlaceholder={c.referralOtherPlaceholder}
        />
      </div>
    </div>
  );
}

export function isKenalanValid(a: OnboardingAnswers): boolean {
  return (
    a.nickname.trim().length > 0 &&
    a.dob.length > 0 &&
    a.country.trim().length > 0 &&
    a.city.trim().length > 0
  );
}

// ── Step 2: Peran & bisnis ───────────────────────────────────────────────
export function StepPeran({ answers, set }: StepProps) {
  const { t } = useI18n();
  const c = t.onboarding.peran;
  const otherLabel = t.onboarding.kenalan.otherLabel;
  const cat = answers.role ? roleCategory(answers.role) : null;

  // Role is a confident tile picker (Q2 hybrid) instead of a dropdown. A custom
  // role (not a known ROLE id) keeps the "Lainnya" input open; clicking a tile
  // closes it. `role` still stores the id OR the typed string — no data-model
  // change, so roleCategory + isPeranValid + the complete route are untouched.
  const isKnownRole = ROLES.some((r) => r.id === answers.role);
  const [roleOtherMode, setRoleOtherMode] = useState(
    answers.role !== "" && !isKnownRole,
  );
  const showRoleOther = roleOtherMode || (answers.role !== "" && !isKnownRole);

  const toggleIndustry = (id: string) =>
    set({
      industryIds: answers.industryIds.includes(id)
        ? answers.industryIds.filter((x) => x !== id)
        : [...answers.industryIds, id],
    });

  // The "bidang" question label adapts to the role.
  const bidangLabel =
    cat === "business"
      ? c.bidangUsahaLabel
      : cat === "worker"
        ? c.bidangPekerjaanLabel
        : c.industryLabel;

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<User className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />
      <div>
        <FieldLabel>{c.roleLabel}</FieldLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ROLES.map((r) => {
            const active = !showRoleOther && answers.role === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setRoleOtherMode(false);
                  set({ role: r.id });
                }}
                aria-pressed={active}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-left text-[12px] font-medium transition-all",
                  active
                    ? "border-cyan-400/70 bg-cyan-400/[0.08] text-white shadow-[0_0_0_2px_rgba(34,211,238,0.15)]"
                    : "border-white/10 bg-white/[0.03] text-white/80 hover:border-cyan-400/40 hover:bg-white/[0.06]",
                )}
              >
                {r.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setRoleOtherMode(true);
              set({ role: "" });
            }}
            aria-pressed={showRoleOther}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-left text-[12px] font-medium transition-all",
              showRoleOther
                ? "border-fuchsia-400/60 bg-fuchsia-400/[0.08] text-white shadow-[0_0_0_2px_rgba(217,70,239,0.15)]"
                : "border-white/10 bg-white/[0.03] text-white/80 hover:border-fuchsia-400/40 hover:bg-white/[0.06]",
            )}
          >
            {otherLabel}
          </button>
        </div>
        {showRoleOther ? (
          <input
            type="text"
            value={answers.role}
            onChange={(e) => set({ role: e.target.value })}
            placeholder={c.roleOtherPlaceholder}
            autoFocus
            maxLength={80}
            className={cn(
              "mt-2.5 h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-sm text-white placeholder:text-white/30 transition-all focus:outline-none",
              "focus:border-fuchsia-400/60 focus:bg-white/[0.05]",
            )}
          />
        ) : null}
      </div>

      {/* Contextual follow-up — only after a role is chosen. Students get a
          major question; everyone else gets the (role-labelled) field chips. */}
      {cat === "student" ? (
        <SelectWithOther
          label={c.jurusanLabel}
          value={answers.jurusan}
          onChange={(v) => set({ jurusan: v })}
          placeholder={c.jurusanPlaceholder}
          options={JURUSAN.map((j) => ({ value: j.id, label: j.label }))}
          otherLabel={otherLabel}
          otherPlaceholder={c.jurusanOtherPlaceholder}
        />
      ) : cat ? (
        <div>
          <FieldLabel>{bidangLabel}</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {INDUSTRIES.map((ind) => (
              <Chip
                key={ind.id}
                active={answers.industryIds.includes(ind.id)}
                onClick={() => toggleIndustry(ind.id)}
              >
                <span>{ind.icon}</span>
                <span>{ind.label}</span>
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      {/* Business → business name + team size. Worker → company/institution. */}
      {cat === "business" ? (
        <>
          <TextField
            label={c.businessNameLabel}
            placeholder={c.businessNamePlaceholder}
            value={answers.businessName}
            onChange={(v) => set({ businessName: v })}
            note={c.businessNameNote}
            maxLength={120}
          />
          <SelectField
            label={c.teamSizeLabel}
            value={answers.teamSize}
            onChange={(v) => set({ teamSize: v })}
            placeholder={c.teamSizePlaceholder}
            options={c.teamSizes.map((s) => ({ value: s.id, label: s.label }))}
          />
        </>
      ) : cat === "worker" ? (
        <TextField
          label={c.companyNameLabel}
          placeholder={c.companyNamePlaceholder}
          value={answers.businessName}
          onChange={(v) => set({ businessName: v })}
          maxLength={120}
        />
      ) : null}
    </div>
  );
}

export function isPeranValid(a: OnboardingAnswers): boolean {
  if (a.role.trim().length === 0) return false;
  const cat = roleCategory(a.role);
  if (cat === "student") return a.jurusan.trim().length > 0;
  if (cat === "business" || cat === "worker") return a.industryIds.length > 0;
  return true; // general (freelancer, creator, IRT, custom): role alone is enough
}

// ── Step 3: Quest ────────────────────────────────────────────────────────
export function StepQuest({ answers, set }: StepProps) {
  const { t } = useI18n();
  const c = t.onboarding.quest;
  const interests = GOALS;
  // Count only ids that still exist as a goal — drops stale ids from an earlier
  // draft where options were renamed (that was the "3/3 but only 2 picked" bug).
  const selected = validGoalIds(answers.interestIds);
  const atMax = selected.length >= MAX_INTERESTS;

  // Prune stale ids once on mount so the stored data is clean too.
  useEffect(() => {
    if (selected.length !== answers.interestIds.length) {
      set({ interestIds: selected });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleInterest = (id: string) => {
    if (answers.interestIds.includes(id)) {
      set({ interestIds: answers.interestIds.filter((x) => x !== id) });
    } else if (selected.length < MAX_INTERESTS) {
      set({ interestIds: [...answers.interestIds, id] });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        icon={<Rocket className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
        badge={
          <span
            className={cn(
              "rounded-full border px-3 py-1 font-mono text-[11px] font-semibold",
              atMax
                ? "border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-200"
                : "border-cyan-400/30 bg-cyan-400/5 text-cyan-200",
            )}
          >
            {c.counterLabel} {selected.length}/{MAX_INTERESTS}
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {interests.map((it) => {
          const active = answers.interestIds.includes(it.id);
          const comingSoon = !!it.comingSoon;
          const disabled = comingSoon || (!active && atMax);
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => {
                if (!comingSoon) toggleInterest(it.id);
              }}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                "group relative flex flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-all",
                active
                  ? "border-cyan-400/70 bg-cyan-400/[0.08] shadow-[0_0_0_2px_rgba(34,211,238,0.15),0_10px_28px_-14px_rgba(34,211,238,0.6)]"
                  : comingSoon
                    ? "cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-55"
                    : disabled
                      ? "cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-40"
                      : "border-white/10 bg-white/[0.03] hover:-translate-y-0.5 hover:border-cyan-400/40 hover:bg-white/[0.06]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg text-lg transition-colors",
                  active
                    ? "bg-gradient-to-br from-cyan-400/30 to-fuchsia-500/30"
                    : "bg-white/[0.05] group-hover:bg-white/[0.08]",
                )}
              >
                {it.icon}
              </span>
              <p
                className={cn(
                  "text-[12.5px] font-semibold leading-snug",
                  active ? "text-white" : "text-white/85",
                )}
              >
                {it.label}
              </p>
              {active ? (
                <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-cyan-400 text-[#0B0E14]">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : comingSoon ? (
                <span className="absolute right-2 top-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-amber-200">
                  Soon
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {atMax ? (
        <p className="text-center text-[11px] text-fuchsia-300/80">{c.maxNote}</p>
      ) : null}
    </div>
  );
}

export function isQuestValid(a: OnboardingAnswers): boolean {
  return validGoalIds(a.interestIds).length > 0;
}
