// Unit-test the schedule-codec compile/decompile cycle.
// Runs in Node, no engine needed.
//   pnpm tsx scripts/test-cron-schedule-codec.ts
import {
  type FrequencyState,
  compileSchedule,
  decompileSchedule,
  describeFrequency,
} from "@/components/app/cron/schedule-codec";
import type { CronSchedule } from "@/components/app/cron/helpers";

function eqSchedule(a: CronSchedule, b: CronSchedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let pass = 0;
let fail = 0;
function expect(label: string, cond: boolean, extra?: string) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "[OK]" : "[FAIL]"} ${label}${extra ? "  " + extra : ""}`);
}

const TZ = "Asia/Jakarta";

// ── Compile: each FrequencyKind → expected CronSchedule ────────────
console.log("[..] Compile: FrequencyState → CronSchedule\n");

const baseState: Omit<FrequencyState, "kind"> = {
  hour: 8,
  minute: 0,
  weekdays: [1, 3, 5],
  monthDay: 15,
  intervalN: 30,
  intervalUnit: "minutes",
  onceDateTime: "2026-12-31T15:30",
  customExpr: "*/5 9-17 * * 1-5",
  deleteAfterRun: false,
  tz: TZ,
};

// daily
const dailyCompiled = compileSchedule({ ...baseState, kind: "daily" });
expect(
  "daily compile",
  eqSchedule(dailyCompiled, { kind: "cron", expr: "0 8 * * *", tz: TZ }),
  JSON.stringify(dailyCompiled),
);

// weekdays
const weekdaysCompiled = compileSchedule({ ...baseState, kind: "weekdays" });
expect(
  "weekdays compile",
  eqSchedule(weekdaysCompiled, { kind: "cron", expr: "0 8 * * 1-5", tz: TZ }),
  JSON.stringify(weekdaysCompiled),
);

// weekends
const weekendsCompiled = compileSchedule({ ...baseState, kind: "weekends" });
expect(
  "weekends compile",
  eqSchedule(weekendsCompiled, { kind: "cron", expr: "0 8 * * 0,6", tz: TZ }),
  JSON.stringify(weekendsCompiled),
);

// weekly (Mon, Wed, Fri)
const weeklyCompiled = compileSchedule({ ...baseState, kind: "weekly" });
expect(
  "weekly compile (Mon+Wed+Fri)",
  eqSchedule(weeklyCompiled, { kind: "cron", expr: "0 8 * * 1,3,5", tz: TZ }),
  JSON.stringify(weeklyCompiled),
);

// monthly (15th)
const monthlyCompiled = compileSchedule({ ...baseState, kind: "monthly" });
expect(
  "monthly compile (15th)",
  eqSchedule(monthlyCompiled, { kind: "cron", expr: "0 8 15 * *", tz: TZ }),
  JSON.stringify(monthlyCompiled),
);

// interval — 30 minutes
const intervalCompiled = compileSchedule({ ...baseState, kind: "interval" });
expect(
  "interval compile (30 min)",
  eqSchedule(intervalCompiled, { kind: "every", everyMs: 30 * 60_000 }),
  JSON.stringify(intervalCompiled),
);

// interval — 3 hours
const interval3hrs = compileSchedule({
  ...baseState,
  kind: "interval",
  intervalN: 3,
  intervalUnit: "hours",
});
expect(
  "interval compile (3 hours)",
  eqSchedule(interval3hrs, { kind: "every", everyMs: 3 * 3600_000 }),
);

// interval — 7 days
const interval7d = compileSchedule({
  ...baseState,
  kind: "interval",
  intervalN: 7,
  intervalUnit: "days",
});
expect(
  "interval compile (7 days)",
  eqSchedule(interval7d, { kind: "every", everyMs: 7 * 86400_000 }),
);

// once
const onceCompiled = compileSchedule({ ...baseState, kind: "once" });
expect(
  "once compile",
  eqSchedule(onceCompiled, { kind: "at", at: "2026-12-31T15:30" }),
);

// custom
const customCompiled = compileSchedule({ ...baseState, kind: "custom" });
expect(
  "custom compile",
  eqSchedule(customCompiled, {
    kind: "cron",
    expr: "*/5 9-17 * * 1-5",
    tz: TZ,
  }),
);

// ── Decompile: each CronSchedule → expected FrequencyKind ────────────
console.log("\n[..] Decompile: CronSchedule → FrequencyState\n");

const decoded_daily = decompileSchedule(
  { kind: "cron", expr: "0 8 * * *", tz: TZ },
  TZ,
);
expect("decompile daily", decoded_daily.kind === "daily");
expect("decompile daily hour", decoded_daily.hour === 8);
expect("decompile daily minute", decoded_daily.minute === 0);
expect("decompile daily tz", decoded_daily.tz === TZ);

const decoded_weekdays = decompileSchedule(
  { kind: "cron", expr: "0 9 * * 1-5", tz: TZ },
  TZ,
);
expect("decompile weekdays", decoded_weekdays.kind === "weekdays");
expect("decompile weekdays hour", decoded_weekdays.hour === 9);

const decoded_weekends = decompileSchedule(
  { kind: "cron", expr: "0 10 * * 0,6", tz: TZ },
  TZ,
);
expect("decompile weekends", decoded_weekends.kind === "weekends");

const decoded_weekly = decompileSchedule(
  { kind: "cron", expr: "30 14 * * 1,3,5", tz: TZ },
  TZ,
);
expect("decompile weekly", decoded_weekly.kind === "weekly");
expect(
  "decompile weekly days",
  JSON.stringify(decoded_weekly.weekdays) === "[1,3,5]",
);

const decoded_monthly = decompileSchedule(
  { kind: "cron", expr: "0 8 15 * *", tz: TZ },
  TZ,
);
expect("decompile monthly", decoded_monthly.kind === "monthly");
expect("decompile monthly day", decoded_monthly.monthDay === 15);

const decoded_interval = decompileSchedule(
  { kind: "every", everyMs: 30 * 60_000 },
  TZ,
);
expect("decompile interval (30 min)", decoded_interval.kind === "interval");
expect("decompile interval N", decoded_interval.intervalN === 30);
expect("decompile interval unit", decoded_interval.intervalUnit === "minutes");

const decoded_interval3h = decompileSchedule(
  { kind: "every", everyMs: 3 * 3600_000 },
  TZ,
);
expect("decompile interval (3hr)", decoded_interval3h.intervalUnit === "hours");
expect("decompile interval (3hr) N", decoded_interval3h.intervalN === 3);

const decoded_once = decompileSchedule(
  { kind: "at", at: "2026-12-31T15:30" },
  TZ,
);
expect("decompile once", decoded_once.kind === "once");
expect(
  "decompile once datetime",
  decoded_once.onceDateTime === "2026-12-31T15:30",
);

const decoded_custom = decompileSchedule(
  { kind: "cron", expr: "*/15 * * * *", tz: TZ },
  TZ,
);
expect("decompile custom (every 15 min)", decoded_custom.kind === "custom");
expect("decompile custom expr", decoded_custom.customExpr === "*/15 * * * *");

// ── Round-trip: compile(decompile(x)) === x for each ────────────────
console.log("\n[..] Round-trip: compile(decompile(x)) preserves schedule\n");

const rtTests: CronSchedule[] = [
  { kind: "cron", expr: "0 8 * * *", tz: TZ },
  { kind: "cron", expr: "30 9 * * 1-5", tz: TZ },
  { kind: "cron", expr: "0 17 * * 0,6", tz: TZ },
  { kind: "cron", expr: "45 14 * * 1,3,5", tz: TZ },
  { kind: "cron", expr: "0 6 1 * *", tz: TZ },
  { kind: "every", everyMs: 30 * 60_000 },
  { kind: "every", everyMs: 4 * 3600_000 },
  { kind: "at", at: "2026-12-31T15:30" },
];

for (const orig of rtTests) {
  const decoded = decompileSchedule(orig, TZ);
  const recompiled = compileSchedule(decoded);
  const ok = eqSchedule(orig, recompiled);
  expect(`round-trip ${JSON.stringify(orig)}`, ok, JSON.stringify(recompiled));
}

// ── describeFrequency: human-readable strings ───────────────────
console.log("\n[..] describeFrequency: human-readable Bahasa\n");

expect(
  "describe daily",
  describeFrequency({ ...baseState, kind: "daily" }) === "Tiap hari jam 08:00",
);
expect(
  "describe weekdays",
  describeFrequency({ ...baseState, kind: "weekdays" }) ===
    "Tiap hari kerja (Sen–Jum) jam 08:00",
);
expect(
  "describe weekends",
  describeFrequency({ ...baseState, kind: "weekends" }) ===
    "Tiap akhir pekan (Sab+Min) jam 08:00",
);
expect(
  "describe weekly",
  describeFrequency({ ...baseState, kind: "weekly" }) ===
    "Tiap Senin, Rabu, Jumat jam 08:00",
);
expect(
  "describe monthly",
  describeFrequency({ ...baseState, kind: "monthly" }) ===
    "Tiap tanggal 15 jam 08:00",
);
expect(
  "describe interval",
  describeFrequency({ ...baseState, kind: "interval" }) === "Setiap 30 menit",
);

// ── Summary ──────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`SCHEDULE CODEC SUMMARY: ${pass} passed, ${fail} failed`);
console.log("=".repeat(60));
process.exit(fail > 0 ? 1 : 0);
