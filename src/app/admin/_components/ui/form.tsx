"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, Minus, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Option } from "./enums";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-zinc-900/50 disabled:text-zinc-600";

// --- FormRow: label + help + inline error + required marker ---

export function FormRow({
  label,
  help,
  error,
  required,
  htmlFor,
  children,
}: {
  label: string;
  help?: string;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-xs font-medium text-zinc-300">
        {label}
        {required && <span className="text-red-400">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[11px] text-red-400">{error}</p>
      ) : help ? (
        <p className="text-[11px] text-zinc-500">{help}</p>
      ) : null}
    </div>
  );
}

// --- Select (native, styled) ---

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  id,
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: Option<T>[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(INPUT, "appearance-none pr-8 [color-scheme:dark]")}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.hint ? ` — ${o.hint}` : ""}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
    </div>
  );
}

// --- Combobox: searchable; optional free-entry. Self-contained popover. ---

export function Combobox<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Pilih…",
  allowCustom = false,
  disabled,
  emptyText = "Tidak ada hasil",
  loading,
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: Option<T>[];
  placeholder?: string;
  allowCustom?: boolean;
  disabled?: boolean;
  emptyText?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selected = options.find((o) => o.value === value);
  const display = selected?.label ?? (value || "");

  const commit = (v: T) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(INPUT, "flex items-center justify-between gap-2 text-left")}
      >
        <span className={cn("truncate", !display && "text-zinc-500")}>{display || placeholder}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-500" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 shadow-xl">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5">
            <Search className="size-3.5 text-zinc-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setHi((h) => Math.min(h + 1, filtered.length - 1));
                else if (e.key === "ArrowUp") setHi((h) => Math.max(h - 1, 0));
                else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered[hi]) commit(filtered[hi].value);
                  else if (allowCustom && query.trim()) commit(query.trim() as T);
                } else if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Ketik untuk cari…"
              className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
            />
          </div>
          <ul className="max-h-56 overflow-auto py-1">
            {loading && <li className="px-3 py-2 text-xs text-zinc-500">Memuat…</li>}
            {!loading && filtered.length === 0 && !allowCustom && (
              <li className="px-3 py-2 text-xs text-zinc-500">{emptyText}</li>
            )}
            {!loading &&
              filtered.map((o, i) => (
                <li key={o.value}>
                  <button
                    type="button"
                    onMouseEnter={() => setHi(i)}
                    onClick={() => commit(o.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm",
                      i === hi ? "bg-cyan-500/10 text-cyan-100" : "text-zinc-300 hover:bg-zinc-800",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{o.label}</span>
                      {o.hint && <span className="block truncate text-[11px] text-zinc-500">{o.hint}</span>}
                    </span>
                    {o.value === value && <Check className="size-3.5 shrink-0 text-cyan-400" />}
                  </button>
                </li>
              ))}
            {!loading && allowCustom && query.trim() && !filtered.some((o) => o.value === query.trim()) && (
              <li>
                <button
                  type="button"
                  onClick={() => commit(query.trim() as T)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  <Plus className="size-3.5 text-zinc-500" />
                  Pakai &ldquo;{query.trim()}&rdquo;
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Toggle (switch) ---

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
          checked ? (danger ? "bg-red-500" : "bg-cyan-500") : "bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 transform rounded-full bg-white shadow transition",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
      {label && <span className="text-sm text-zinc-300">{label}</span>}
    </button>
  );
}

// --- SegmentedControl ---

export function SegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-800/60 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md font-medium transition",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              active ? "bg-zinc-950 text-zinc-100 shadow" : "text-zinc-500 hover:text-zinc-200",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// --- NumberStepper (+ unit, presets, clamp) ---

export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  presets,
  id,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  presets?: number[];
  id?: string;
  placeholder?: string;
}) {
  const clamp = (n: number) => {
    let v = n;
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    return v;
  };
  const cur = value ?? 0;
  return (
    <div className="space-y-1.5">
      <div className="inline-flex items-stretch rounded-md border border-zinc-700 bg-zinc-900">
        <button
          type="button"
          onClick={() => onChange(clamp(cur - step))}
          disabled={typeof min === "number" && cur <= min}
          className="px-2 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
          aria-label="Kurangi"
        >
          <Minus className="size-3.5" />
        </button>
        <div className="flex items-center border-x border-zinc-800">
          <input
            id={id}
            type="number"
            value={value ?? ""}
            min={min}
            max={max}
            step={step}
            placeholder={placeholder}
            onChange={(e) => {
              const n = e.target.value === "" ? min ?? 0 : Number(e.target.value);
              if (!Number.isNaN(n)) onChange(clamp(n));
            }}
            className="w-20 bg-transparent px-2 py-1.5 text-center text-sm tabular-nums text-zinc-100 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          {unit && <span className="pr-2 text-xs text-zinc-500">{unit}</span>}
        </div>
        <button
          type="button"
          onClick={() => onChange(clamp(cur + step))}
          disabled={typeof max === "number" && cur >= max}
          className="px-2 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
          aria-label="Tambah"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(clamp(p))}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px] transition",
                value === p
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-800",
              )}
            >
              {p}
              {unit ? ` ${unit}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- CurrencyField (Rp, thousands) ---

export function CurrencyField({
  value,
  onChange,
  max,
  min = 0,
  id,
}: {
  value: number | null;
  onChange: (v: number) => void;
  max?: number;
  min?: number;
  id?: string;
}) {
  // Fully derived from `value` — display reformats from props on every render,
  // no local mirror state (avoids the reset-via-effect anti-pattern).
  const display = value != null ? value.toLocaleString("id-ID") : "";
  return (
    <div className="flex items-center rounded-md border border-zinc-700 bg-zinc-900 focus-within:border-cyan-500/50 focus-within:ring-2 focus-within:ring-cyan-500/30">
      <span className="pl-2.5 text-sm text-zinc-500">Rp</span>
      <input
        id={id}
        inputMode="numeric"
        value={display}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d]/g, "");
          const n = digits === "" ? 0 : Number(digits);
          let v = Math.max(min, n);
          if (typeof max === "number") v = Math.min(max, v);
          onChange(v);
        }}
        className="w-full bg-transparent px-2 py-1.5 text-right text-sm tabular-nums text-zinc-100 outline-none"
      />
    </div>
  );
}

// --- DateField ---

export function DateField({
  value,
  onChange,
  showTime,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  showTime?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      type={showTime ? "datetime-local" : "date"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(INPUT, "[color-scheme:dark]")}
    />
  );
}

// --- MultiSelectChips (tag input) ---

export function MultiSelectChips({
  values,
  onChange,
  placeholder = "Ketik lalu Enter…",
  max,
  validate,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  max?: number;
  validate?: (v: string) => boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (validate && !validate(v)) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    if (typeof max === "number" && values.length >= max) return;
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 focus-within:border-cyan-500/50 focus-within:ring-2 focus-within:ring-cyan-500/30">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300"
        >
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Hapus ${v}`}>
            <X className="size-3 text-zinc-500 hover:text-zinc-200" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ""}
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
      />
    </div>
  );
}

// --- SaveBar (sticky, dirty-aware) ---

export function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
  savedAt,
  message,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onReset?: () => void;
  savedAt?: string | null;
  message?: string;
}) {
  if (!dirty && !saving) {
    return savedAt ? <p className="text-[11px] text-zinc-500">Tersimpan {savedAt}</p> : null;
  }
  return (
    <div className="sticky bottom-0 z-20 mt-4 flex items-center justify-between gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 backdrop-blur">
      <span className="text-xs text-cyan-200">{message ?? "Ada perubahan belum disimpan."}</span>
      <div className="flex items-center gap-2">
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          >
            Batal
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-60"
        >
          {saving ? "Menyimpan…" : "Simpan"}
        </button>
      </div>
    </div>
  );
}

export const useFieldId = useId;
