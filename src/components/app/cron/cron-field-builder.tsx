"use client";

/**
 * CronFieldBuilder — visual cron builder yang 100% pake friendly Bahasa picker.
 *
 * User gak pernah liat raw cron syntax. Semua jadi clickable visual:
 *   - Menit: Tiap menit / Tiap N menit / 0-59 grid
 *   - Jam: Tiap jam / 24-hour grid dengan label waktu
 *   - Tanggal: Tiap tanggal / 1-31 calendar grid
 *   - Bulan: Tiap bulan / 12 month chips (multi-select)
 *   - Hari: Tiap hari / kerja / akhir pekan / 7 day chips (multi-select)
 *
 * Tiap pilihan langsung compile ke cron field string (engine schema valid),
 * tapi user gak perlu peduli — yang kelihatan cuma "Tiap 15 menit" dll.
 *
 * Power user toggle "Mode raw" untuk ketik cron expression langsung.
 */
import { Check, ChevronDown, Code2, HelpCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export function CronFieldBuilder({
  expr,
  onChange,
}: {
  expr: string;
  onChange: (next: string) => void;
}) {
  const parts = useMemo(() => parseExpr(expr), [expr]);
  const [showRaw, setShowRaw] = useState(false);
  const [rawDraft, setRawDraft] = useState(expr);

  const setField = (index: 0 | 1 | 2 | 3 | 4, value: string) => {
    const next = [...parts] as [string, string, string, string, string];
    next[index] = value.trim() || "*";
    const joined = next.join(" ");
    onChange(joined);
    setRawDraft(joined);
  };

  return (
    <div className="space-y-2">
      <MinutePicker value={parts[0]} onChange={(v) => setField(0, v)} />
      <HourPicker value={parts[1]} onChange={(v) => setField(1, v)} />
      <DayPicker value={parts[2]} onChange={(v) => setField(2, v)} />
      <MonthPicker value={parts[3]} onChange={(v) => setField(3, v)} />
      <DowPicker value={parts[4]} onChange={(v) => setField(4, v)} />

      {/* Bottom toggle */}
      <div className="flex flex-wrap items-center justify-end pt-1 text-[10px]">
        <button
          type="button"
          onClick={() => {
            setShowRaw((v) => !v);
            setRawDraft(parts.join(" "));
          }}
          className="inline-flex items-center gap-1 font-mono uppercase tracking-[0.18em] text-white/55 hover:text-cyan-200"
        >
          <Code2 className="size-3" aria-hidden />
          {showRaw ? "Tutup mode raw" : "Mode raw (untuk power user)"}
        </button>
      </div>

      {showRaw ? (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
          <label className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
            Raw cron expression
          </label>
          <input
            type="text"
            value={rawDraft}
            onChange={(e) => {
              setRawDraft(e.target.value);
              onChange(e.target.value);
            }}
            placeholder="0 8 * * *"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
          <p className="mt-1 font-mono text-[10px] text-white/45">
            Format: <code className="text-cyan-200">menit jam tanggal bulan hari</code>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ── Generic FieldShell — handles collapse + display ────────────── */

function FieldShell({
  label,
  selection,
  defaultOpen,
  children,
}: {
  label: string;
  selection: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            {label}
          </div>
          <div
            className={cn(
              "min-w-0 truncate text-[13px] font-semibold",
              open ? "text-cyan-200" : "text-cyan-100",
            )}
          >
            {selection}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-white/55 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="border-t border-white/[0.06] px-3 pb-3 pt-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ── Quick option row ────────────────────────────────────────────── */

function OptionRow({
  active,
  onClick,
  children,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left transition",
        active
          ? "bg-cyan-400/15 text-cyan-100"
          : "text-white/85 hover:bg-white/[0.04]",
      )}
    >
      <span className="min-w-0">
        <span className="text-[12px] font-semibold">{children}</span>
        {hint ? (
          <span className="ml-2 text-[10px] text-white/45">{hint}</span>
        ) : null}
      </span>
      {active ? (
        <Check className="size-3.5 shrink-0 text-cyan-300" aria-hidden />
      ) : null}
    </button>
  );
}

/* ── Number grid (multi-select supported) ─────────────────────────── */

function NumberGrid({
  min,
  max,
  cols,
  selected,
  labels,
  onToggle,
  startLabel,
}: {
  min: number;
  max: number;
  cols: number;
  selected: Set<number>;
  labels?: (n: number) => string;
  onToggle: (n: number) => void;
  startLabel?: string;
}) {
  const nums: number[] = [];
  for (let i = min; i <= max; i++) nums.push(i);
  return (
    <div>
      {startLabel ? (
        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
          {startLabel}
        </div>
      ) : null}
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {nums.map((n) => {
          const active = selected.has(n);
          return (
            <button
              key={n}
              type="button"
              onClick={() => onToggle(n)}
              className={cn(
                "rounded-md border px-1.5 py-1.5 font-mono text-[11px] font-semibold transition",
                active
                  ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100 shadow-[0_0_12px_-4px_rgba(34,211,238,0.5)]"
                  : "border-white/10 bg-white/[0.02] text-white/70 hover:border-white/25 hover:text-white",
              )}
            >
              {labels ? labels(n) : n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Minute picker ───────────────────────────────────────────────── */

function MinutePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = useMemo(() => parseList(value, 0, 59), [value]);
  const isStar = value === "*";
  const stepMatch = /^\*\/(\d+)$/.exec(value);
  const stepN = stepMatch ? Number(stepMatch[1]) : null;
  const display = useMemo(() => describeMinute(value), [value]);

  return (
    <FieldShell label="Menit" selection={display}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <OptionRow active={isStar} onClick={() => onChange("*")}>
            Tiap menit
          </OptionRow>
          <OptionRow active={stepN === 5} onClick={() => onChange("*/5")}>
            Tiap 5 menit
          </OptionRow>
          <OptionRow active={stepN === 10} onClick={() => onChange("*/10")}>
            Tiap 10 menit
          </OptionRow>
          <OptionRow active={stepN === 15} onClick={() => onChange("*/15")}>
            Tiap 15 menit
          </OptionRow>
          <OptionRow active={stepN === 30} onClick={() => onChange("*/30")}>
            Tiap 30 menit
          </OptionRow>
        </div>
        <NumberGrid
          startLabel="ATAU pilih menit spesifik (bisa banyak)"
          min={0}
          max={59}
          cols={10}
          selected={isStar || stepN ? new Set() : selected}
          onToggle={(n) => {
            const next = isStar || stepN ? new Set<number>() : new Set(selected);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            onChange(setToCron(next, "*"));
          }}
        />
      </div>
    </FieldShell>
  );
}

/* ── Hour picker ─────────────────────────────────────────────────── */

function HourPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = useMemo(() => parseList(value, 0, 23), [value]);
  const isStar = value === "*";
  const display = useMemo(() => describeHour(value), [value]);

  return (
    <FieldShell label="Jam" selection={display}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <OptionRow active={isStar} onClick={() => onChange("*")}>
            Tiap jam
          </OptionRow>
          <OptionRow
            active={value === "8"}
            onClick={() => onChange("8")}
            hint="08:00 — pagi"
          >
            Jam 8 pagi
          </OptionRow>
          <OptionRow
            active={value === "12"}
            onClick={() => onChange("12")}
            hint="12:00 — siang"
          >
            Jam 12 siang
          </OptionRow>
          <OptionRow
            active={value === "18"}
            onClick={() => onChange("18")}
            hint="18:00 — sore"
          >
            Jam 6 sore
          </OptionRow>
          <OptionRow
            active={value === "9-17"}
            onClick={() => onChange("9-17")}
            hint="09:00 – 17:00"
          >
            Jam kerja (9–17)
          </OptionRow>
        </div>
        <NumberGrid
          startLabel="ATAU pilih jam spesifik (bisa banyak)"
          min={0}
          max={23}
          cols={6}
          selected={isStar ? new Set() : selected}
          labels={(n) => String(n).padStart(2, "0")}
          onToggle={(n) => {
            const next = isStar ? new Set<number>() : new Set(selected);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            onChange(setToCron(next, "*"));
          }}
        />
      </div>
    </FieldShell>
  );
}

/* ── Day-of-month picker ─────────────────────────────────────────── */

function DayPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = useMemo(() => parseList(value, 1, 31), [value]);
  const isStar = value === "*";
  const display = useMemo(() => describeDay(value), [value]);

  return (
    <FieldShell label="Tanggal" selection={display}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <OptionRow active={isStar} onClick={() => onChange("*")}>
            Tiap tanggal
          </OptionRow>
          <OptionRow
            active={value === "1"}
            onClick={() => onChange("1")}
            hint="Awal bulan"
          >
            Tanggal 1
          </OptionRow>
          <OptionRow
            active={value === "15"}
            onClick={() => onChange("15")}
            hint="Tengah bulan"
          >
            Tanggal 15
          </OptionRow>
          <OptionRow
            active={value === "28"}
            onClick={() => onChange("28")}
            hint="Akhir bulan (tiap bulan punya tanggal 28)"
          >
            Tanggal 28
          </OptionRow>
        </div>
        <NumberGrid
          startLabel="ATAU pilih tanggal spesifik (bisa banyak)"
          min={1}
          max={31}
          cols={7}
          selected={isStar ? new Set() : selected}
          onToggle={(n) => {
            const next = isStar ? new Set<number>() : new Set(selected);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            onChange(setToCron(next, "*"));
          }}
        />
      </div>
    </FieldShell>
  );
}

/* ── Month picker (multi-select) ─────────────────────────────────── */

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

function MonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = useMemo(() => parseList(value, 1, 12), [value]);
  const isStar = value === "*";
  const display = useMemo(() => describeMonth(value), [value]);

  return (
    <FieldShell label="Bulan" selection={display}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <OptionRow active={isStar} onClick={() => onChange("*")}>
            Tiap bulan
          </OptionRow>
        </div>
        <div>
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
            ATAU pilih bulan spesifik (bisa banyak)
          </div>
          <div className="grid grid-cols-4 gap-1">
            {MONTH_NAMES.map((name, idx) => {
              const n = idx + 1;
              const active = !isStar && selected.has(n);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    const next = isStar
                      ? new Set<number>()
                      : new Set(selected);
                    if (next.has(n)) next.delete(n);
                    else next.add(n);
                    onChange(setToCron(next, "*"));
                  }}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[12px] font-semibold transition",
                    active
                      ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100"
                      : "border-white/10 bg-white/[0.02] text-white/75 hover:border-white/25 hover:text-white",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </FieldShell>
  );
}

/* ── Day-of-week picker (multi-select) ───────────────────────────── */

const DOW_NAMES = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

function DowPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = useMemo(() => parseList(value, 0, 6), [value]);
  const isStar = value === "*";
  const isWeekday = value === "1-5";
  const isWeekend = value === "0,6" || value === "6,0";
  const display = useMemo(() => describeDow(value), [value]);

  return (
    <FieldShell label="Hari Minggu" selection={display}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <OptionRow active={isStar} onClick={() => onChange("*")}>
            Tiap hari
          </OptionRow>
          <OptionRow
            active={isWeekday}
            onClick={() => onChange("1-5")}
            hint="Senin – Jumat"
          >
            Hari kerja
          </OptionRow>
          <OptionRow
            active={isWeekend}
            onClick={() => onChange("0,6")}
            hint="Sabtu + Minggu"
          >
            Akhir pekan
          </OptionRow>
        </div>
        <div>
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
            ATAU pilih hari spesifik (bisa banyak)
          </div>
          <div className="grid grid-cols-7 gap-1">
            {DOW_NAMES.map((name, n) => {
              const active = !isStar && !isWeekday && !isWeekend && selected.has(n);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    const next =
                      isStar || isWeekday || isWeekend
                        ? new Set<number>()
                        : new Set(selected);
                    if (next.has(n)) next.delete(n);
                    else next.add(n);
                    onChange(setToCron(next, "*"));
                  }}
                  className={cn(
                    "rounded-md border px-1 py-1.5 text-[11px] font-semibold transition",
                    active
                      ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100"
                      : "border-white/10 bg-white/[0.02] text-white/75 hover:border-white/25 hover:text-white",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </FieldShell>
  );
}

/* ── Parsing helpers ─────────────────────────────────────────────── */

function parseExpr(expr: string): [string, string, string, string, string] {
  const parts = expr.trim().split(/\s+/);
  return [
    parts[0] ?? "*",
    parts[1] ?? "*",
    parts[2] ?? "*",
    parts[3] ?? "*",
    parts[4] ?? "*",
  ];
}

/** Parse cron field into Set<number> for grid selection display. Handles:
 *  - "*" → empty set (caller treats as "all selected" specially)
 *  - "5" → {5}
 *  - "1,3,5" → {1,3,5}
 *  - "1-5" → {1,2,3,4,5}
 *  - step expression like *\/5 → empty (UI shows step option active instead)
 */
function parseList(value: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  if (value === "*" || /^\*\/\d+$/.test(value)) return out;
  for (const part of value.split(",")) {
    const p = part.trim();
    if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n >= lo && n <= hi) out.add(n);
    } else if (/^(\d+)-(\d+)$/.test(p)) {
      const m = p.match(/^(\d+)-(\d+)$/)!;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a >= lo && b <= hi) {
        for (let i = a; i <= b; i++) out.add(i);
      }
    }
  }
  return out;
}

/** Compile a Set<number> back to cron field string. Empty set → fallback (mis. "*"). */
function setToCron(s: Set<number>, fallback: string): string {
  if (s.size === 0) return fallback;
  return Array.from(s)
    .sort((a, b) => a - b)
    .join(",");
}

/* ── Friendly descriptions (for collapsed display) ───────────────── */

function describeMinute(v: string): string {
  if (v === "*") return "Tiap menit";
  const step = /^\*\/(\d+)$/.exec(v);
  if (step) return `Tiap ${step[1]} menit`;
  const list = parseList(v, 0, 59);
  if (list.size === 0) return v;
  if (list.size === 1) return `Menit ke-${Array.from(list)[0]}`;
  if (list.size <= 5)
    return `Menit ${Array.from(list).sort((a, b) => a - b).join(", ")}`;
  return `${list.size} menit dipilih`;
}

function describeHour(v: string): string {
  if (v === "*") return "Tiap jam";
  if (v === "9-17") return "Jam kerja (09:00 – 17:00)";
  const step = /^\*\/(\d+)$/.exec(v);
  if (step) return `Tiap ${step[1]} jam`;
  const list = parseList(v, 0, 23);
  if (list.size === 0) return v;
  if (list.size === 1) {
    const h = Array.from(list)[0];
    return `Jam ${String(h).padStart(2, "0")}:00 ${hourLabel(h)}`;
  }
  if (list.size <= 4)
    return (
      "Jam " +
      Array.from(list)
        .sort((a, b) => a - b)
        .map((h) => String(h).padStart(2, "0"))
        .join(", ")
    );
  return `${list.size} jam dipilih`;
}

function hourLabel(h: number): string {
  if (h < 4) return "(dini hari)";
  if (h < 11) return "(pagi)";
  if (h < 15) return "(siang)";
  if (h < 18) return "(sore)";
  return "(malam)";
}

function describeDay(v: string): string {
  if (v === "*") return "Tiap tanggal";
  const list = parseList(v, 1, 31);
  if (list.size === 0) return v;
  if (list.size === 1) return `Tanggal ${Array.from(list)[0]}`;
  if (list.size <= 5)
    return (
      "Tanggal " +
      Array.from(list)
        .sort((a, b) => a - b)
        .join(", ")
    );
  return `${list.size} tanggal dipilih`;
}

function describeMonth(v: string): string {
  if (v === "*") return "Tiap bulan";
  const list = parseList(v, 1, 12);
  if (list.size === 0) return v;
  if (list.size === 12) return "Tiap bulan";
  return Array.from(list)
    .sort((a, b) => a - b)
    .map((n) => MONTH_NAMES[n - 1] ?? n)
    .join(", ");
}

function describeDow(v: string): string {
  if (v === "*") return "Tiap hari";
  if (v === "1-5") return "Hari kerja (Sen – Jum)";
  if (v === "0,6" || v === "6,0") return "Akhir pekan (Sab + Min)";
  const list = parseList(v, 0, 6);
  if (list.size === 0) return v;
  if (list.size === 7) return "Tiap hari";
  return Array.from(list)
    .sort((a, b) => a - b)
    .map((n) => DOW_NAMES[n] ?? n)
    .join(", ");
}
