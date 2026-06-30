/**
 * Cron helpers — wire types (full engine parity) + humanization for
 * mass-market Bahasa display.
 *
 * Engine source of truth verified against:
 *   - Reff/openclaw/src/gateway/protocol/schema/cron.ts
 *   - Reff/openclaw/src/gateway/server-methods/cron.ts
 *   - Reff/openclaw/src/cron/types-shared.ts
 *
 * Don't shorten field names — engine validates strict shape.
 */

/* ── Schedule kinds ──────────────────────────────────────────────────── */

export type CronScheduleAt = { kind: "at"; at: string };
export type CronScheduleEvery = {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
};
export type CronScheduleCron = {
  kind: "cron";
  expr: string;
  tz?: string;
  staggerMs?: number;
};
export type CronSchedule =
  | CronScheduleAt
  | CronScheduleEvery
  | CronScheduleCron;

/* ── Payload kinds ───────────────────────────────────────────────────── */

export type CronPayloadSystemEvent = { kind: "systemEvent"; text: string };
export type CronPayloadAgentTurn = {
  kind: "agentTurn";
  message: string;
  model?: string;
  fallbacks?: string[];
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean;
  lightContext?: boolean;
};
export type CronPayload = CronPayloadSystemEvent | CronPayloadAgentTurn;

/* ── Delivery modes ──────────────────────────────────────────────────── */

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronFailureDestination = {
  channel?: string;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
};

export type CronFailureAlert =
  | false
  | {
      after?: number;
      channel?: string;
      to?: string;
      cooldownMs?: number;
      mode?: "announce" | "webhook";
      accountId?: string;
    };

/* ── Session target + wake ──────────────────────────────────────────── */

export type CronSessionTargetBase = "main" | "isolated" | "current";
/** "session:<key>" — custom session routing. */
export type CronSessionTarget = CronSessionTargetBase | string;

export type CronWakeMode = "now" | "next-heartbeat";

/* ── Job ─────────────────────────────────────────────────────────────── */

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronDeliveryStatus =
  | "delivered"
  | "not-delivered"
  | "unknown"
  | "not-requested";

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastError?: string;
  lastErrorReason?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureAlertAtMs?: number;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  agentId?: string | null;
  sessionKey?: string | null;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert;
  /** Advanced (engine-honored) per-job overrides. */
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
  /** Only these skills are loaded before the run (focus + token saving). */
  skills?: string[];
  /** Restrict the agent to these toolsets. */
  enabledToolsets?: string[];
  /** Run N times then auto-stop. undefined/0 = forever. */
  repeat?: number;
  /** Prepend the latest output of these job id(s) as context. */
  contextFrom?: string | string[];
  state: CronJobState;
};

export type CronJobCreate = Omit<
  CronJob,
  "id" | "createdAtMs" | "updatedAtMs" | "state"
>;

export type CronJobPatch = Partial<CronJobCreate> & {
  state?: Partial<CronJobState>;
};

/* ── List + status results ──────────────────────────────────────────── */

export type CronListResult = {
  jobs: CronJob[];
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};

export type CronStatusResult = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  jobName?: string;
  action?: string;
  status?: CronRunStatus;
  durationMs?: number;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
};

export type CronRunsResult = {
  entries: CronRunLogEntry[];
  total?: number;
  hasMore?: boolean;
  nextOffset?: number;
};

export type CronBroadcast = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  status?: CronRunStatus;
  error?: string;
};

/* ── Filters ──────────────────────────────────────────────────────────── */

export type CronListEnabledFilter = "all" | "enabled" | "disabled";
export type CronListScheduleFilter = "all" | "at" | "every" | "cron";
export type CronListLastStatusFilter = "all" | CronRunStatus;
export type CronListSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
export type CronListSortDir = "asc" | "desc";

export type CronListUiFilters = {
  query: string;
  enabled: CronListEnabledFilter;
  scheduleKind: CronListScheduleFilter;
  lastStatus: CronListLastStatusFilter;
  sortBy: CronListSortBy;
  sortDir: CronListSortDir;
};

export const DEFAULT_LIST_FILTERS: CronListUiFilters = {
  query: "",
  enabled: "all",
  scheduleKind: "all",
  lastStatus: "all",
  sortBy: "nextRunAtMs",
  sortDir: "asc",
};

/* ── Humanization helpers ────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Schedule → friendly Bahasa string. */
export function humanizeSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") {
    return `Sekali di ${formatLocalDateTime(schedule.at)}`;
  }
  if (schedule.kind === "every") {
    return humanizeEvery(schedule.everyMs);
  }
  if (schedule.kind === "cron") {
    const pretty = humanizeCronExpr(schedule.expr);
    return schedule.tz ? `${pretty} (${schedule.tz})` : pretty;
  }
  return "Jadwal tidak dikenal";
}

function humanizeEvery(everyMs: number): string {
  if (everyMs <= 0) return "Tiap saat";
  if (everyMs % DAY_MS === 0) {
    const days = everyMs / DAY_MS;
    return days === 1 ? "Tiap hari" : `Tiap ${days} hari`;
  }
  if (everyMs % HOUR_MS === 0) {
    const hr = everyMs / HOUR_MS;
    return hr === 1 ? "Tiap jam" : `Tiap ${hr} jam`;
  }
  if (everyMs % MIN_MS === 0) {
    const min = everyMs / MIN_MS;
    return min === 1 ? "Tiap menit" : `Tiap ${min} menit`;
  }
  const sec = Math.round(everyMs / 1000);
  return `Tiap ${sec} detik`;
}

/** Lightweight 5-field cron → Bahasa. Tidak semua pattern di-cover; fallback
 *  ke raw expr biar advanced user tetep paham. */
export function humanizeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  // Specific minute + hour, every day
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Tiap hari jam ${pad2(hour)}:${pad2(min)}`;
  }
  // Specific time + weekdays (1-5 Mon-Fri)
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    mon === "*" &&
    dow === "1-5"
  ) {
    return `Hari kerja jam ${pad2(hour)}:${pad2(min)}`;
  }
  // Specific time + one weekday
  if (
    /^\d+$/.test(min) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    mon === "*" &&
    /^\d$/.test(dow)
  ) {
    return `Tiap ${dayOfWeekName(Number(dow))} jam ${pad2(hour)}:${pad2(min)}`;
  }
  // Hourly (minute 0)
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Tiap jam (menit 0)";
  }
  // Every N minutes via */N pattern
  if (
    /^\*\/\d+$/.test(min) &&
    hour === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    const step = Number(min.split("/")[1]);
    return `Tiap ${step} menit`;
  }
  return `cron: ${expr}`;
}

function pad2(s: string | number): string {
  return String(s).padStart(2, "0");
}

function dayOfWeekName(d: number): string {
  // Engine cron uses 0-6 (Sun-Sat). Bahasa Indonesia:
  const names = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  return names[d % 7] ?? `hari-${d}`;
}

/** Payload → ringkasan friendly. */
export function humanizePayload(payload: CronPayload): {
  kindLabel: string;
  summary: string;
} {
  if (payload.kind === "systemEvent") {
    return {
      kindLabel: "Pengingat",
      summary: snippet(payload.text, 80),
    };
  }
  return {
    kindLabel: "Tugas AI",
    summary: snippet(payload.message, 80),
  };
}

/** Delivery → friendly Bahasa. */
export function humanizeDelivery(delivery?: CronDelivery): string {
  if (!delivery || delivery.mode === "none") return "Diam (tidak diumumkan)";
  if (delivery.mode === "webhook") {
    return `Webhook${delivery.to ? ` → ${truncateUrl(delivery.to)}` : ""}`;
  }
  const channel = delivery.channel ?? "last";
  const channelLabel =
    channel === "last" ? "channel terakhir" : channel;
  return delivery.to
    ? `Umumin ke ${channelLabel} → ${delivery.to}`
    : `Umumin ke ${channelLabel}`;
}

function truncateUrl(url: string): string {
  if (url.length <= 40) return url;
  return `${url.slice(0, 30)}…${url.slice(-7)}`;
}

/** sessionTarget label friendly. */
export function humanizeSessionTarget(t: CronSessionTarget): string {
  if (t === "main") return "Sesi utama (lanjut history)";
  if (t === "isolated") return "Sesi sendiri (fresh tiap lari)";
  if (t === "current") return "Sesi aktif sekarang";
  if (typeof t === "string" && t.startsWith("session:")) {
    return `Sesi khusus (${t.slice(8)})`;
  }
  return String(t);
}

export function humanizeWakeMode(m: CronWakeMode): string {
  return m === "now" ? "Mulai langsung" : "Tunggu giliran (next heartbeat)";
}

/* ── Date / next-run formatting ────────────────────────────────────── */

export function formatNextRun(ms?: number, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const diff = ms - now;
  if (diff < -60_000) return `${formatRelativePast(now - ms)} lalu (lewat)`;
  if (diff < 0) return "Lewat";
  if (diff < 60_000) return "Beberapa detik lagi";
  if (diff < HOUR_MS) return `${Math.round(diff / MIN_MS)} menit lagi`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} jam lagi`;
  if (diff < 7 * DAY_MS) return `${Math.round(diff / DAY_MS)} hari lagi`;
  return formatLocalDateTime(new Date(ms).toISOString());
}

export function formatLastRun(state?: CronJobState, now = Date.now()): string {
  if (!state?.lastRunAtMs) return "Belum pernah lari";
  return `${formatRelativePast(now - state.lastRunAtMs)} lalu`;
}

export function formatRelativePast(diffMs: number): string {
  if (diffMs < MIN_MS) return "baru aja";
  if (diffMs < HOUR_MS) return `${Math.round(diffMs / MIN_MS)} menit`;
  if (diffMs < DAY_MS) return `${Math.round(diffMs / HOUR_MS)} jam`;
  if (diffMs < 7 * DAY_MS) return `${Math.round(diffMs / DAY_MS)} hari`;
  return `${Math.round(diffMs / (7 * DAY_MS))} minggu`;
}

export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function snippet(text: string, max = 80): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/* ── Quick-create presets (mirror engine cron-quick-create.ts) ────── */

export type QuickPresetId =
  | "morning"
  | "evening"
  | "hourly"
  | "weekdays"
  | "weekly"
  | "once";

export type QuickPreset = {
  id: QuickPresetId;
  emoji: string;
  title: string;
  description: string;
  schedule: CronSchedule;
  /** Hanya berlaku untuk preset "once". */
  deleteAfterRun?: boolean;
};

export const QUICK_PRESETS: QuickPreset[] = [
  {
    id: "morning",
    emoji: "🌅",
    title: "Tiap pagi",
    description: "Jam 8 pagi setiap hari",
    schedule: { kind: "cron", expr: "0 8 * * *" },
  },
  {
    id: "evening",
    emoji: "🌙",
    title: "Tiap sore",
    description: "Jam 6 sore setiap hari",
    schedule: { kind: "cron", expr: "0 18 * * *" },
  },
  {
    id: "hourly",
    emoji: "🔄",
    title: "Tiap jam",
    description: "Setiap 1 jam (menit 0)",
    schedule: { kind: "every", everyMs: HOUR_MS },
  },
  {
    id: "weekdays",
    emoji: "📅",
    title: "Hari kerja",
    description: "Jam 9 pagi, Senin-Jumat",
    schedule: { kind: "cron", expr: "0 9 * * 1-5" },
  },
  {
    id: "weekly",
    emoji: "📆",
    title: "Mingguan",
    description: "Jam 9 pagi tiap Senin",
    schedule: { kind: "cron", expr: "0 9 * * 1" },
  },
  {
    id: "once",
    emoji: "⚡",
    title: "Sekali aja",
    description: "1 jam dari sekarang, lalu otomatis hapus",
    schedule: { kind: "at", at: nextHourIso() },
    deleteAfterRun: true,
  },
];

/**
 * First line + ~120-char cap. Engine error strings can carry Python
 * tracebacks / container file paths / model API errors / the "Hermes" brand —
 * none of which should reach the mass-market UI verbatim. (Audit MED.)
 */
export function cleanEngineError(msg?: string | null): string {
  if (!msg) return "";
  const firstLine = String(msg).split("\n")[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
}

function nextHourIso(): string {
  const d = new Date(Date.now() + HOUR_MS);
  d.setMinutes(0, 0, 0);
  // LOCAL wall-clock in datetime-local's YYYY-MM-DDTHH:MM format. The old
  // toISOString() returned UTC → a WIB (+7) user saw a time 7h off in the
  // "Sekali aja" datetime-local input. (Audit HIGH.)
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── Status display helpers ───────────────────────────────────────── */

export function statusTone(status?: CronRunStatus): "emerald" | "red" | "amber" {
  if (status === "ok") return "emerald";
  if (status === "error") return "red";
  return "amber"; // skipped
}

export function statusLabel(status?: CronRunStatus): string {
  if (status === "ok") return "Sukses";
  if (status === "error") return "Gagal";
  if (status === "skipped") return "Dilewat";
  return "—";
}

export function deliveryStatusLabel(s?: CronDeliveryStatus): string {
  if (s === "delivered") return "Terkirim";
  if (s === "not-delivered") return "Gagal kirim";
  if (s === "not-requested") return "Tidak dikirim";
  return "—";
}
