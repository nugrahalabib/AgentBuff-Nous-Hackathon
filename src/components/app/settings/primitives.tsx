"use client";

/**
 * Shared settings primitives for /app/pengaturan.
 *
 * Extracted from pengaturan-tab.tsx so the larger Voice panel (voice-settings.tsx)
 * can reuse the exact same Row / Toggle / Select / Number / Text controls without
 * duplicating geometry or creating a circular import back into the tab file.
 */

import { cn } from "@/lib/utils";

export const SELECT_CLS =
  "min-w-[9rem] max-w-[12rem] rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white/90 outline-none transition focus:border-cyan-400/50";

export function Row({
  label,
  help,
  control,
}: {
  label: string;
  help?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-white/90">{label}</div>
        {help ? <div className="mt-0.5 text-xs leading-snug text-white/45">{help}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  // Canonical (shadcn) switch geometry: track h-6 w-11 with border-2 border-
  // transparent -> inner box 40x20; knob size-5 (20px) vertically centered by
  // items-center; checked translate-x-5 (20px) lands flush inside the track.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400/50",
        checked ? "bg-emerald-500" : "bg-white/15",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-5 rounded-full bg-white shadow ring-0 transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function ToggleRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return <Row label={label} help={help} control={<Toggle checked={checked} onChange={onChange} />} />;
}

export function SelectRow({
  label,
  help,
  value,
  options,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Row
      label={label}
      help={help}
      control={
        <select className={SELECT_CLS} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#0B0E14] text-white">
              {o.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

export function NumberRow({
  label,
  help,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  help?: string;
  unit?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row
      label={label}
      help={help}
      control={
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={Number.isFinite(value) ? value : 0}
            min={min}
            max={max}
            onChange={(e) => {
              let n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n)) n = min ?? 0;
              if (min != null) n = Math.max(min, n);
              if (max != null) n = Math.min(max, n);
              onChange(n);
            }}
            className="w-20 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-right text-sm text-white/90 outline-none transition focus:border-cyan-400/50"
          />
          {unit ? <span className="text-xs text-white/45">{unit}</span> : null}
        </div>
      }
    />
  );
}

export function TextRow({
  label,
  help,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Row
      label={label}
      help={help}
      control={
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-40 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white/90 outline-none transition placeholder:text-white/25 focus:border-cyan-400/50"
        />
      }
    />
  );
}

/**
 * SubGroup — a labelled "kotak" inside a Section. Used by the Voice panel to
 * split TTS vs STT so a long field list reads as two clear boxes instead of one
 * overwhelming stack.
 */
export function SubGroup({
  icon,
  title,
  desc,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      </div>
      {desc ? <p className="mt-0.5 text-xs leading-snug text-white/45">{desc}</p> : null}
      <div className="mt-1 divide-y divide-white/[0.05]">{children}</div>
    </div>
  );
}
