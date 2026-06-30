"use client";

/**
 * CronFrequencyPicker — Apple Reminders style preset list + dynamic sub-form.
 *
 * UX research:
 *  - Apple Reminders: preset list with checkmark, "Custom" drill-down
 *  - Notion / Google Calendar: frequency tabs + sentence-construction
 *  - Crontab.guru: live human-readable preview + "next runs"
 *
 * User never sees raw cron syntax. Underlying CronSchedule compiled by
 * schedule-codec.compileSchedule().
 */
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Calendar,
  CalendarDays,
  CalendarRange,
  Check,
  Clock,
  Coffee,
  Code2,
  Repeat,
  Sun,
  Sunrise,
  Sunset,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CronTimezonePicker, getDefaultTimezone } from "./cron-timezone-picker";
import {
  type FrequencyKind,
  type FrequencyState,
  type IntervalUnit,
  compileSchedule,
  computeNextRuns,
  decompileSchedule,
  describeFrequency,
  formatBahasaRelativeRun,
} from "./schedule-codec";
import type { CronSchedule } from "./helpers";

const DOW_FULL = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const DOW_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function CronFrequencyPicker({
  schedule,
  onChange,
  deleteAfterRun,
  onDeleteAfterRun,
}: {
  schedule: CronSchedule;
  onChange: (next: CronSchedule) => void;
  deleteAfterRun: boolean;
  onDeleteAfterRun: (v: boolean) => void;
}) {
  // Decompile incoming schedule once on mount; thereafter manage local state.
  const [state, setState] = useState<FrequencyState>(() =>
    decompileSchedule(schedule, getDefaultTimezone()),
  );

  // Re-decompile when an external schedule.kind change happens (mis. user
  // switching modes externally — not currently used, but defensive).
  // We intentionally do NOT re-decompile on every render to avoid losing
  // sub-form state when user toggles between options.

  // Pure local update — parent gets synced via useEffect below (avoids
  // "setState during render" warning when caller setState fires onChange).
  const update = (patch: Partial<FrequencyState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  };

  // Sync local state → parent schedule (debounced to next tick after render).
  //
  // ALWAYS fire on initial mount too — decompileSchedule auto-fills tz from
  // browser when parent's schedule.tz is undefined, and that needs to
  // propagate UP so engine doesn't fire jobs in server TZ (UTC) instead of
  // user's local TZ. compileSchedule is deterministic so no loop risk:
  // child state stable → useEffect fires once per state change → parent
  // re-renders with new schedule but useState lazy-init only ran once on
  // mount so child state doesn't reset.
  useEffect(() => {
    onChange(compileSchedule(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Propagate deleteAfterRun upward for "once" kind
  useEffect(() => {
    onDeleteAfterRun(state.kind === "once" && state.deleteAfterRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, state.deleteAfterRun]);

  // Sync external deleteAfterRun changes back
  useEffect(() => {
    if (deleteAfterRun !== state.deleteAfterRun) {
      setState((p) => ({ ...p, deleteAfterRun }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteAfterRun]);

  const nextRuns = useMemo(() => computeNextRuns(state, 3), [state]);
  const humanReadable = useMemo(() => describeFrequency(state), [state]);

  return (
    <div className="space-y-4">
      {/* Preset list — Apple Reminders style */}
      <PresetList state={state} onPick={(kind) => update({ kind })} />

      {/* Dynamic sub-form per kind */}
      <motion.div
        key={state.kind}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-4"
      >
        <SubForm state={state} onChange={update} />
      </motion.div>

      {/* Live preview footer */}
      <PreviewFooter
        humanReadable={humanReadable}
        nextRuns={nextRuns}
        tz={state.tz}
      />
    </div>
  );
}

/* ── Preset list ───────────────────────────────────────────────── */

type PresetMeta = {
  kind: FrequencyKind;
  icon: typeof Sun;
  title: string;
  hint: string;
};

const PRESETS: PresetMeta[] = [
  {
    kind: "daily",
    icon: Sun,
    title: "Tiap hari",
    hint: "Setiap hari, pada jam yang sama",
  },
  {
    kind: "weekdays",
    icon: Coffee,
    title: "Hari kerja",
    hint: "Senin – Jumat, jam yang sama tiap hari",
  },
  {
    kind: "weekends",
    icon: Sunrise,
    title: "Akhir pekan",
    hint: "Sabtu + Minggu, jam yang sama",
  },
  {
    kind: "weekly",
    icon: CalendarRange,
    title: "Tiap minggu (pilih hari)",
    hint: "Pilih hari spesifik dalam seminggu",
  },
  {
    kind: "monthly",
    icon: CalendarDays,
    title: "Tiap bulan",
    hint: "Tanggal tertentu setiap bulan",
  },
  {
    kind: "interval",
    icon: Repeat,
    title: "Tiap N menit/jam/hari",
    hint: "Misal: tiap 30 menit, tiap 3 jam",
  },
  {
    kind: "once",
    icon: Zap,
    title: "Sekali aja",
    hint: "Jalan satu kali di tanggal + jam tertentu",
  },
  {
    kind: "custom",
    icon: Code2,
    title: "Custom (advanced)",
    hint: "Ketik cron expression manual",
  },
];

function PresetList({
  state,
  onPick,
}: {
  state: FrequencyState;
  onPick: (kind: FrequencyKind) => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
      {PRESETS.map((p, idx) => {
        const Icon = p.icon;
        const active = state.kind === p.kind;
        return (
          <button
            key={p.kind}
            type="button"
            onClick={() => onPick(p.kind)}
            className={cn(
              "flex w-full items-center gap-3 px-4 py-3 text-left transition",
              active
                ? "bg-cyan-400/10 text-cyan-100"
                : "text-white/85 hover:bg-white/[0.03]",
              idx < PRESETS.length - 1 && "border-b border-white/[0.04]",
            )}
          >
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg border transition",
                active
                  ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
                  : "border-white/10 bg-white/[0.03] text-white/70",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "text-[14px] font-semibold",
                  active ? "text-cyan-100" : "text-white/95",
                )}
              >
                {p.title}
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-white/55">
                {p.hint}
              </p>
            </div>
            {active ? (
              <Check
                className="size-4 shrink-0 text-cyan-300"
                aria-hidden
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ── Sub-form per kind ─────────────────────────────────────────── */

function SubForm({
  state,
  onChange,
}: {
  state: FrequencyState;
  onChange: (patch: Partial<FrequencyState>) => void;
}) {
  const setTz = (next: string | undefined) => onChange({ tz: next });

  if (state.kind === "daily" || state.kind === "weekdays" || state.kind === "weekends") {
    return (
      <div className="space-y-4">
        <TimeRow state={state} onChange={onChange} />
        <CronTimezonePicker value={state.tz} onChange={setTz} />
      </div>
    );
  }

  if (state.kind === "weekly") {
    return (
      <div className="space-y-4">
        <WeekdayChips state={state} onChange={onChange} />
        <TimeRow state={state} onChange={onChange} />
        <CronTimezonePicker value={state.tz} onChange={setTz} />
      </div>
    );
  }

  if (state.kind === "monthly") {
    return (
      <div className="space-y-4">
        <MonthDayPicker state={state} onChange={onChange} />
        <TimeRow state={state} onChange={onChange} />
        <CronTimezonePicker value={state.tz} onChange={setTz} />
      </div>
    );
  }

  if (state.kind === "interval") {
    return (
      <div className="space-y-2">
        <label className="block text-[13px] font-semibold text-white/90">
          Setiap berapa lama?
        </label>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <span className="text-[13px] text-white/85">Setiap</span>
          <input
            type="number"
            min={1}
            max={9999}
            value={state.intervalN}
            onChange={(e) =>
              onChange({
                intervalN: Math.max(1, Number(e.target.value) || 1),
              })
            }
            className="w-16 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-center font-mono text-[14px] font-semibold text-white focus:border-cyan-400/50 focus:outline-none"
          />
          <select
            value={state.intervalUnit}
            onChange={(e) =>
              onChange({
                intervalUnit: e.target.value as IntervalUnit,
              })
            }
            className="rounded-md border border-white/10 bg-black/30 px-3 py-1 text-[13px] font-semibold text-white focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="minutes" className="bg-[#0B0E14]">
              menit
            </option>
            <option value="hours" className="bg-[#0B0E14]">
              jam
            </option>
            <option value="days" className="bg-[#0B0E14]">
              hari
            </option>
          </select>
        </div>
        <p className="text-[11px] text-white/55">
          Engine fire mulai dari saat rutinitas dibuat, lalu lanjut sesuai
          interval.
        </p>
      </div>
    );
  }

  if (state.kind === "once") {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="block text-[13px] font-semibold text-white/90">
            Kapan tepatnya?
          </label>
          <input
            type="datetime-local"
            value={state.onceDateTime}
            onChange={(e) => onChange({ onceDateTime: e.target.value })}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[14px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
          <p className="text-[11px] text-white/55">
            Pakai zona waktu lokal browser kamu.
          </p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
          <input
            type="checkbox"
            checked={state.deleteAfterRun}
            onChange={(e) =>
              onChange({ deleteAfterRun: e.target.checked })
            }
            className="mt-0.5 size-4 shrink-0 accent-cyan-400"
          />
          <div>
            <div className="text-[13px] font-semibold text-white/90">
              Hapus rutinitas setelah selesai
            </div>
            <p className="text-[11px] text-white/55">
              Sekali jalan, lalu rutinitas auto-deleted (one-shot).
            </p>
          </div>
        </label>
      </div>
    );
  }

  if (state.kind === "custom") {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="block text-[13px] font-semibold text-white/90">
            Cron expression
          </label>
          <input
            type="text"
            value={state.customExpr}
            onChange={(e) => onChange({ customExpr: e.target.value })}
            placeholder="0 9 * * 1-5"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[14px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
          <p className="text-[11px] leading-snug text-white/55">
            5 field cron: menit · jam · tanggal · bulan · hari-minggu. Pakai
            mode ini cuma kalau preset di atas gak cukup spesifik.
          </p>
        </div>
        <details className="rounded-lg border border-cyan-400/15 bg-cyan-400/[0.03] px-3 py-2 text-[11px] text-white/75">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
            Bantuan syntax
          </summary>
          <ul className="mt-1 space-y-0.5">
            <li>
              <code className="text-cyan-200">*</code> = semua nilai
            </li>
            <li>
              <code className="text-cyan-200">8</code> = nilai spesifik
            </li>
            <li>
              <code className="text-cyan-200">1-5</code> = range
            </li>
            <li>
              <code className="text-cyan-200">{"*"}/15</code> = setiap N langkah
            </li>
            <li>
              <code className="text-cyan-200">0,15,30,45</code> = list
            </li>
            <li>
              Contoh: <code className="text-cyan-200">{"*"}/15 9-17 * * 1-5</code>{" "}
              = tiap 15 menit, jam 9-17, hari kerja
            </li>
          </ul>
        </details>
        <CronTimezonePicker
          value={state.tz}
          onChange={(next) => onChange({ tz: next })}
        />
      </div>
    );
  }

  return null;
}

/* ── Sub-form helpers ──────────────────────────────────────────── */

function TimeRow({
  state,
  onChange,
}: {
  state: FrequencyState;
  onChange: (patch: Partial<FrequencyState>) => void;
}) {
  // Use native <input type="time"> for the picker UX (gives browser-native
  // time spinner / clock UI, which is exactly what user asked for in
  // earlier feedback re. SEKALI AJA datetime-local picker).
  const hh = String(state.hour).padStart(2, "0");
  const mm = String(state.minute).padStart(2, "0");
  const value = `${hh}:${mm}`;
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-[13px] font-semibold text-white/90">
        <Clock className="size-4 text-cyan-300" aria-hidden />
        Jam berapa?
      </label>
      <div className="flex items-center gap-3">
        <input
          type="time"
          value={value}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map((n) => Number(n));
            onChange({
              hour: Number.isFinite(h) ? h : state.hour,
              minute: Number.isFinite(m) ? m : state.minute,
            });
          }}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[18px] font-semibold text-white focus:border-cyan-400/50 focus:outline-none"
        />
        <QuickTimes
          current={value}
          onPick={(h, m) => onChange({ hour: h, minute: m })}
        />
      </div>
    </div>
  );
}

function QuickTimes({
  current,
  onPick,
}: {
  current: string;
  onPick: (hour: number, minute: number) => void;
}) {
  const presets: Array<{ label: string; hour: number; minute: number; icon: React.ReactNode }> = [
    { label: "Pagi", hour: 8, minute: 0, icon: <Sunrise className="size-3" /> },
    { label: "Siang", hour: 12, minute: 0, icon: <Sun className="size-3" /> },
    { label: "Sore", hour: 17, minute: 0, icon: <Sunset className="size-3" /> },
    { label: "Malam", hour: 20, minute: 0, icon: <Sunset className="size-3" /> },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {presets.map((p) => {
        const v = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
        const active = current === v;
        return (
          <button
            key={p.label}
            type="button"
            onClick={() => onPick(p.hour, p.minute)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
              active
                ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100"
                : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white",
            )}
          >
            {p.icon}
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function WeekdayChips({
  state,
  onChange,
}: {
  state: FrequencyState;
  onChange: (patch: Partial<FrequencyState>) => void;
}) {
  const set = new Set(state.weekdays);
  const toggle = (d: number) => {
    const next = new Set(set);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    onChange({ weekdays: Array.from(next).sort((a, b) => a - b) });
  };
  return (
    <div className="space-y-2">
      <label className="block text-[13px] font-semibold text-white/90">
        Hari apa?
      </label>
      <div className="grid grid-cols-7 gap-1.5">
        {DOW_SHORT.map((name, idx) => {
          const active = set.has(idx);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(idx)}
              className={cn(
                "rounded-lg border px-1 py-2 text-[12px] font-semibold transition",
                active
                  ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100 shadow-[0_0_16px_-4px_rgba(34,211,238,0.5)]"
                  : "border-white/10 bg-white/[0.02] text-white/70 hover:border-white/25 hover:text-white",
              )}
              title={DOW_FULL[idx]}
            >
              {name}
            </button>
          );
        })}
      </div>
      {state.weekdays.length === 0 ? (
        <p className="flex items-center gap-1 text-[11px] text-amber-300/85">
          <AlertTriangle className="size-3" aria-hidden />
          Pilih minimal 1 hari
        </p>
      ) : null}
    </div>
  );
}

function MonthDayPicker({
  state,
  onChange,
}: {
  state: FrequencyState;
  onChange: (patch: Partial<FrequencyState>) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[13px] font-semibold text-white/90">
        Tanggal berapa?
      </label>
      <p className="text-[11px] text-white/55">
        Tip: kalau pilih tanggal &gt; 28, bulan Februari akan di-skip.
      </p>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
          const active = state.monthDay === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange({ monthDay: d })}
              className={cn(
                "rounded-md border py-2 font-mono text-[13px] font-semibold transition",
                active
                  ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100 shadow-[0_0_16px_-4px_rgba(34,211,238,0.5)]"
                  : "border-white/10 bg-white/[0.02] text-white/70 hover:border-white/25 hover:text-white",
              )}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Preview footer ────────────────────────────────────────────── */

function PreviewFooter({
  humanReadable,
  nextRuns,
  tz,
}: {
  humanReadable: string;
  nextRuns: Date[];
  tz: string | undefined;
}) {
  return (
    <div className="rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.06] via-[#0B0E14]/40 to-fuchsia-400/[0.04] p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/15">
          <Calendar className="size-4 text-cyan-300" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
            Jadwal final
          </div>
          <div className="mt-0.5 text-[15px] font-bold text-white">
            {humanReadable}
            {tz ? (
              <span className="ml-2 text-[12px] font-normal text-white/55">
                ({tz})
              </span>
            ) : null}
          </div>
          {nextRuns.length > 0 ? (
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
                3 jadwal berikutnya
              </div>
              <ul className="mt-1 space-y-0.5">
                {nextRuns.map((d, i) => (
                  <li
                    key={i}
                    className="font-mono text-[11px] text-white/75"
                  >
                    <span className="text-cyan-300/85">{i + 1}.</span>{" "}
                    {formatBahasaRelativeRun(d)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
