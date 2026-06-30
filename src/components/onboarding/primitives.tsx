"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared visual primitives for the /onboarding wizard. Ported from the basecamp
// onboarding-modal aesthetic (deep-space #0B0E14 + cyan→indigo→fuchsia gradient)
// but generalised for a full-page, 6-step flow. Design-only; no data logic.

export function WizardCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full">
      <div
        aria-hidden
        className="absolute -inset-px rounded-[1.5rem] bg-gradient-to-br from-cyan-400/50 via-indigo-400/10 to-fuchsia-500/50 opacity-70 blur-[2px]"
      />
      <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#0B0E14]/90 shadow-[0_40px_120px_-20px_rgba(8,145,178,0.5)] backdrop-blur-2xl">
        {children}
      </div>
    </div>
  );
}

export function StepProgress({
  total,
  current,
  valueText,
}: {
  total: number;
  current: number;
  valueText?: string;
}) {
  return (
    <div
      className="flex gap-1.5 p-3.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current + 1}
      aria-valuetext={valueText}
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]"
        >
          <motion.span
            initial={false}
            animate={{
              width: i < current ? "100%" : i === current ? "50%" : "0%",
            }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              i <= current
                ? "bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                : "",
            )}
          />
        </div>
      ))}
    </div>
  );
}

export function StepHeader({
  icon,
  headline,
  subheadline,
  badge,
}: {
  icon: React.ReactNode;
  headline: string;
  subheadline: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="mb-3 inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-cyan-400/10 to-fuchsia-500/10">
          {icon}
        </div>
        <h1 className="font-display text-xl font-bold leading-tight sm:text-[1.5rem]">
          {headline}
        </h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/70">
          {subheadline}
        </p>
      </div>
      {badge ? <div className="mt-1 shrink-0">{badge}</div> : null}
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/50">
      {children}
    </span>
  );
}

export function FieldNote({ children }: { children: React.ReactNode }) {
  // text-white/55 clears WCAG AA (4.5:1) on the #0B0E14 surface; /40 did not.
  return <p className="mt-1.5 pl-1 text-[11px] text-white/55">{children}</p>;
}

export function TextField({
  label,
  icon,
  placeholder,
  value,
  onChange,
  type = "text",
  note,
  autoFocus,
  maxLength,
  onEnter,
}: {
  label?: string;
  icon?: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  note?: React.ReactNode;
  autoFocus?: boolean;
  maxLength?: number;
  onEnter?: () => void;
}) {
  return (
    <label className="flex flex-col">
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <span
        className={cn(
          "group flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 transition-all",
          "focus-within:border-cyan-400/70 focus-within:bg-white/[0.05]",
          "focus-within:shadow-[0_0_0_4px_rgba(34,211,238,0.12)]",
        )}
      >
        {icon ? (
          <span className="text-white/40 transition-colors group-focus-within:text-cyan-300">
            {icon}
          </span>
        ) : null}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          maxLength={maxLength}
          className="h-11 flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
      </span>
      {note ? <FieldNote>{note}</FieldNote> : null}
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  placeholder,
  options,
  note,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  note?: React.ReactNode;
}) {
  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? "",
    [value, options],
  );
  return (
    <div className="flex flex-col">
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-11 w-full appearance-none rounded-xl border border-white/10 bg-white/[0.03] px-3.5 pr-9 text-sm transition-all focus:outline-none",
            "focus:border-cyan-400/70 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(34,211,238,0.12)]",
            value ? "text-white" : "text-white/30",
          )}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#0B0E14]">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-white/40" />
        <span className="sr-only">{selectedLabel}</span>
      </div>
      {note ? <FieldNote>{note}</FieldNote> : null}
    </div>
  );
}

// A dropdown with a built-in "Lainnya → ketik" escape hatch. The bound `value`
// is always the EFFECTIVE string — a known option id, or whatever the user typed
// in the "other" input. On resume, a persisted custom value (not in options)
// auto-opens the text input.
export function SelectWithOther({
  label,
  value,
  onChange,
  placeholder,
  options,
  otherLabel,
  otherPlaceholder,
  note,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  otherLabel: string;
  otherPlaceholder: string;
  note?: React.ReactNode;
}) {
  const isKnown = options.some((o) => o.value === value);
  const [otherMode, setOtherMode] = useState(value !== "" && !isKnown);
  const showOther = otherMode || (value !== "" && !isKnown);
  const selectValue = showOther ? "__other" : value;

  return (
    <div className="flex flex-col">
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <div className="relative">
        <select
          value={selectValue}
          onChange={(e) => {
            if (e.target.value === "__other") {
              setOtherMode(true);
              onChange("");
            } else {
              setOtherMode(false);
              onChange(e.target.value);
            }
          }}
          className={cn(
            "h-11 w-full appearance-none rounded-xl border border-white/10 bg-white/[0.03] px-3.5 pr-9 text-sm transition-all focus:outline-none",
            "focus:border-cyan-400/70 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(34,211,238,0.12)]",
            selectValue ? "text-white" : "text-white/30",
          )}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#0B0E14]">
              {o.label}
            </option>
          ))}
          <option value="__other" className="bg-[#0B0E14]">
            {otherLabel}
          </option>
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-white/40" />
      </div>
      {showOther ? (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={otherPlaceholder}
          autoFocus
          maxLength={80}
          className={cn(
            "mt-2 h-11 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-sm text-white placeholder:text-white/30 transition-all focus:outline-none",
            "focus:border-fuchsia-400/60 focus:bg-white/[0.05]",
          )}
        />
      ) : null}
      {note ? <FieldNote>{note}</FieldNote> : null}
    </div>
  );
}

export function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all",
        active
          ? "border-cyan-400/60 bg-cyan-400/10 text-white shadow-[0_0_0_3px_rgba(34,211,238,0.1)]"
          : disabled
            ? "cursor-not-allowed border-white/5 bg-white/[0.02] text-white/30"
            : "border-white/10 bg-white/[0.03] text-white/70 hover:border-white/25 hover:bg-white/[0.06] hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  loading,
  children,
  icon,
  type = "button",
}: {
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl px-5 py-3 text-sm font-bold text-white transition-all",
        "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 shadow-[0_12px_32px_-6px_rgba(99,102,241,0.55)]",
        "hover:brightness-110 active:scale-[0.99]",
        "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:brightness-100",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
      />
      {loading ? (
        <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      ) : null}
      {children}
      {!loading && icon ? icon : null}
    </button>
  );
}

export function GhostButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] font-medium text-white/35 transition-colors hover:text-white/70"
    >
      {children}
    </button>
  );
}
