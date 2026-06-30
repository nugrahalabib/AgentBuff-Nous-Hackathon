/**
 * schedule-codec — UI-level frequency model ↔ engine CronSchedule.
 *
 * User picks high-level "Tiap hari" / "Tiap minggu" / "Sekali aja" / dll.
 * Codec compile ke 3 engine schedule kinds (at/every/cron) tanpa user lihat
 * cron syntax. Decompile dipakai kalau edit existing job — kita pattern-match
 * cron expression umum kembali ke FrequencyKind, fallback ke "custom".
 *
 * computeNextRuns: simple deterministic next-fire calculator untuk preview
 * footer. Cover semua FrequencyKind. Pure (no engine call).
 */

import type { CronSchedule } from "./helpers";

export type FrequencyKind =
  | "daily"
  | "weekdays"
  | "weekends"
  | "weekly"
  | "monthly"
  | "interval"
  | "once"
  | "custom";

export type IntervalUnit = "minutes" | "hours" | "days";

export type FrequencyState = {
  kind: FrequencyKind;
  hour: number; // 0-23
  minute: number; // 0-59
  weekdays: number[]; // 0=Min..6=Sab (for "weekly")
  monthDay: number; // 1-31 (for "monthly")
  intervalN: number; // for "interval"
  intervalUnit: IntervalUnit;
  onceDateTime: string; // YYYY-MM-DDTHH:MM (for "once")
  customExpr: string; // for "custom"
  deleteAfterRun: boolean; // only meaningful for "once"
  tz?: string;
};

export function defaultFrequencyState(opts?: {
  tz?: string;
}): FrequencyState {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return {
    kind: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1, 3], // Mon + Wed default for weekly
    monthDay: 1,
    intervalN: 30,
    intervalUnit: "minutes",
    onceDateTime: formatLocalDateTime(d),
    customExpr: "0 9 * * *",
    deleteAfterRun: false,
    tz: opts?.tz,
  };
}

function formatLocalDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hr}:${min}`;
}

/* ── Compile FrequencyState → CronSchedule ─────────────────────── */

export function compileSchedule(state: FrequencyState): CronSchedule {
  const m = state.minute;
  const h = state.hour;
  const tz = state.tz || undefined;

  switch (state.kind) {
    case "daily":
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
    case "weekdays":
      return { kind: "cron", expr: `${m} ${h} * * 1-5`, tz };
    case "weekends":
      return { kind: "cron", expr: `${m} ${h} * * 0,6`, tz };
    case "weekly": {
      const days =
        state.weekdays.length === 0
          ? "*"
          : [...state.weekdays].sort((a, b) => a - b).join(",");
      return { kind: "cron", expr: `${m} ${h} * * ${days}`, tz };
    }
    case "monthly":
      return { kind: "cron", expr: `${m} ${h} ${state.monthDay} * *`, tz };
    case "interval": {
      const ms =
        state.intervalUnit === "days"
          ? state.intervalN * 86_400_000
          : state.intervalUnit === "hours"
            ? state.intervalN * 3_600_000
            : state.intervalN * 60_000;
      return { kind: "every", everyMs: ms };
    }
    case "once":
      return { kind: "at", at: state.onceDateTime };
    case "custom":
      return { kind: "cron", expr: state.customExpr, tz };
  }
}

/* ── Decompile CronSchedule → FrequencyState (for editing existing) ─── */

export function decompileSchedule(
  schedule: CronSchedule,
  fallbackTz?: string,
): FrequencyState {
  const base = defaultFrequencyState({ tz: fallbackTz });

  if (schedule.kind === "at") {
    return { ...base, kind: "once", onceDateTime: schedule.at };
  }

  if (schedule.kind === "every") {
    const ms = schedule.everyMs;
    // Clamp to >=1: a sub-30s everyMs would round to 0 here and recompile into
    // an invalid 0-interval schedule. Smallest representable interval is 1 min.
    let intervalN = Math.max(1, Math.round(ms / 60_000));
    let intervalUnit: IntervalUnit = "minutes";
    if (ms % 86_400_000 === 0) {
      intervalN = ms / 86_400_000;
      intervalUnit = "days";
    } else if (ms % 3_600_000 === 0) {
      intervalN = ms / 3_600_000;
      intervalUnit = "hours";
    }
    return { ...base, kind: "interval", intervalN, intervalUnit };
  }

  // schedule.kind === "cron"
  const expr = schedule.expr.trim();
  const tz = schedule.tz ?? base.tz;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    return { ...base, kind: "custom", customExpr: expr, tz };
  }
  const [minStr, hourStr, dom, mon, dow] = parts;
  const minNum = Number(minStr);
  const hourNum = Number(hourStr);
  const isSimpleHm =
    /^\d+$/.test(minStr) &&
    /^\d+$/.test(hourStr) &&
    minNum >= 0 && minNum <= 59 &&
    hourNum >= 0 && hourNum <= 23;

  if (isSimpleHm && mon === "*") {
    // daily: m h * * *
    if (dom === "*" && dow === "*") {
      return { ...base, kind: "daily", hour: hourNum, minute: minNum, tz };
    }
    // weekdays: m h * * 1-5
    if (dom === "*" && dow === "1-5") {
      return { ...base, kind: "weekdays", hour: hourNum, minute: minNum, tz };
    }
    // weekends: m h * * 0,6 or 6,0
    if (dom === "*" && (dow === "0,6" || dow === "6,0")) {
      return { ...base, kind: "weekends", hour: hourNum, minute: minNum, tz };
    }
    // weekly: m h * * 1,3 (specific weekdays)
    if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
      const days = dow.split(",").map((d) => Number(d));
      return {
        ...base,
        kind: "weekly",
        hour: hourNum,
        minute: minNum,
        weekdays: days,
        tz,
      };
    }
    // monthly: m h <day> * *
    if (/^\d+$/.test(dom) && dow === "*") {
      const day = Number(dom);
      if (day >= 1 && day <= 31) {
        return {
          ...base,
          kind: "monthly",
          hour: hourNum,
          minute: minNum,
          monthDay: day,
          tz,
        };
      }
    }
  }

  return { ...base, kind: "custom", customExpr: expr, tz };
}

/* ── Next-runs prediction (for preview footer) ──────────────────── */

/** Compute next N fire times for a FrequencyState. Uses LOCAL tz of the
 *  browser for display. Engine actually fires using the schedule's tz field,
 *  but for preview we approximate with local — close enough for the 3 next
 *  fires user sees. */
export function computeNextRuns(
  state: FrequencyState,
  count = 3,
  now = new Date(),
): Date[] {
  const out: Date[] = [];

  if (state.kind === "once") {
    const d = new Date(state.onceDateTime);
    if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) {
      out.push(d);
    }
    return out;
  }

  if (state.kind === "interval") {
    const ms =
      state.intervalUnit === "days"
        ? state.intervalN * 86_400_000
        : state.intervalUnit === "hours"
          ? state.intervalN * 3_600_000
          : state.intervalN * 60_000;
    if (ms <= 0) return out;
    let next = now.getTime() + ms;
    for (let i = 0; i < count; i++) {
      out.push(new Date(next));
      next += ms;
    }
    return out;
  }

  if (state.kind === "custom") {
    // Best-effort: only handle "m h * * *" / "m h * * dow" simple cases.
    const parts = state.customExpr.trim().split(/\s+/);
    if (parts.length !== 5) return out;
    const [minStr, hourStr, dom, mon, dow] = parts;
    if (
      !/^\d+$/.test(minStr) ||
      !/^\d+$/.test(hourStr) ||
      mon !== "*"
    ) {
      return out;
    }
    // Fall through to handle as daily/weekday based on dow
    const stub: FrequencyState = {
      ...state,
      hour: Number(hourStr),
      minute: Number(minStr),
      kind:
        dow === "*" && dom === "*"
          ? "daily"
          : dow === "1-5"
            ? "weekdays"
            : dow === "0,6" || dow === "6,0"
              ? "weekends"
              : /^[0-6](,[0-6])*$/.test(dow) && dom === "*"
                ? "weekly"
                : /^\d+$/.test(dom) && dow === "*"
                  ? "monthly"
                  : "custom",
    };
    if (stub.kind === "custom") return out;
    if (/^[0-6](,[0-6])*$/.test(dow)) {
      stub.weekdays = dow.split(",").map((d) => Number(d));
    }
    if (/^\d+$/.test(dom)) {
      stub.monthDay = Number(dom);
    }
    return computeNextRuns(stub, count, now);
  }

  // Time-of-day-based kinds (daily / weekdays / weekends / weekly / monthly)
  const h = state.hour;
  const m = state.minute;
  let allowedDays: Set<number> | null = null;
  switch (state.kind) {
    case "daily":
      allowedDays = null;
      break;
    case "weekdays":
      allowedDays = new Set([1, 2, 3, 4, 5]);
      break;
    case "weekends":
      allowedDays = new Set([0, 6]);
      break;
    case "weekly":
      allowedDays = new Set(state.weekdays);
      if (allowedDays.size === 0) return out;
      break;
    case "monthly": {
      // Next occurrence of state.monthDay at h:m, walking forward by months.
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (now.getDate() < state.monthDay || (now.getDate() === state.monthDay && now < d)) {
        d.setDate(state.monthDay);
      } else {
        d.setMonth(d.getMonth() + 1);
        d.setDate(state.monthDay);
      }
      for (let i = 0; i < count; i++) {
        out.push(new Date(d));
        d.setMonth(d.getMonth() + 1);
      }
      return out;
    }
  }

  // daily / weekdays / weekends / weekly — walk forward day by day
  const cursor = new Date(now);
  cursor.setHours(h, m, 0, 0);
  if (cursor.getTime() <= now.getTime()) {
    cursor.setDate(cursor.getDate() + 1);
  }
  let safety = 0;
  while (out.length < count && safety++ < 800) {
    const dow = cursor.getDay();
    if (!allowedDays || allowedDays.has(dow)) {
      out.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/* ── Friendly natural-language summary ──────────────────────────── */

const DOW_NAMES = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const DOW_NAMES_FULL = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
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

export function describeFrequency(state: FrequencyState): string {
  const time = `${pad2(state.hour)}:${pad2(state.minute)}`;
  switch (state.kind) {
    case "daily":
      return `Tiap hari jam ${time}`;
    case "weekdays":
      return `Tiap hari kerja (Sen–Jum) jam ${time}`;
    case "weekends":
      return `Tiap akhir pekan (Sab+Min) jam ${time}`;
    case "weekly": {
      if (state.weekdays.length === 0) return `Tiap minggu jam ${time}`;
      const days = [...state.weekdays]
        .sort((a, b) => a - b)
        .map((d) => DOW_NAMES_FULL[d] ?? `?${d}`)
        .join(", ");
      return `Tiap ${days} jam ${time}`;
    }
    case "monthly":
      return `Tiap tanggal ${state.monthDay} jam ${time}`;
    case "interval": {
      const unit =
        state.intervalUnit === "days"
          ? "hari"
          : state.intervalUnit === "hours"
            ? "jam"
            : "menit";
      return `Setiap ${state.intervalN} ${unit}`;
    }
    case "once": {
      const d = new Date(state.onceDateTime);
      if (Number.isNaN(d.getTime())) return "Tanggal tidak valid";
      return `Sekali aja di ${formatBahasaDateTime(d)}`;
    }
    case "custom":
      return `Custom: ${state.customExpr}`;
  }
}

export function formatBahasaDateTime(d: Date): string {
  const day = d.getDate();
  const month = MONTH_NAMES[d.getMonth()] ?? `?${d.getMonth() + 1}`;
  const year = d.getFullYear();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${DOW_NAMES_FULL[d.getDay()]} ${day} ${month} ${year}, ${time}`;
}

export function formatBahasaRelativeRun(d: Date, now = new Date()): string {
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.round(
    (d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (diffMs < 0) return "Sudah lewat";
  if (diffDays === 0) return `Hari ini ${time}`;
  if (diffDays === 1) return `Besok ${time}`;
  if (diffDays === 2) return `Lusa ${time}`;
  if (diffDays > 0 && diffDays < 7)
    return `${DOW_NAMES_FULL[d.getDay()]} ${time}`;
  return formatBahasaDateTime(d);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
