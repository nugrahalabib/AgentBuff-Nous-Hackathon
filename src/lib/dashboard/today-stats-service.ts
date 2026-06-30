/**
 * Today Stats Service — single source of truth untuk angka "hari ini vs kemarin"
 * yang ditampilkan di dashboard Ringkasan.
 *
 * Production rationale:
 * 1. Aggregasi multi-source (health + sessions.usage) dilakukan di server,
 *    bukan client. Client tinggal render — UI logic terpisah dari business logic.
 * 2. Cache server-side via TanStack Query (client) + HTTP Cache-Control header
 *    (server). Subscription state, channel state, dan usage semua jarang
 *    berubah dalam window 60 detik.
 * 3. Trend % dihitung di server: `(today - yesterday) / max(1, yesterday) * 100`.
 *    Edge case yesterday=0 → kembalikan null (UI tampilkan "Baru mulai").
 * 4. Energy unit: convert dari raw token count ke energy via tokens-per-energy
 *    ratio (default 2000) dari config — kalau ratio berubah, satu tempat update.
 * 5. Container offline → return shape lengkap dengan zeros + flag, jangan throw.
 *    Dashboard tetap render dengan placeholder "—" daripada blank section.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import {
  getSessionsUsage,
  withGateway,
  type GatewayClient,
  type SessionsUsageDailyEntry,
  type SessionsUsageResult,
} from "@/lib/hermes/gateway-client";
import { computeChannelsDashboard } from "@/lib/dashboard/channels-service";

export type TodayMetric = {
  /** Nilai hari ini. */
  today: number;
  /** Nilai kemarin. null kalau gak applicable (e.g. channel snapshot real-time). */
  yesterday: number | null;
  /**
   * Trend percentage delta. null kalau yesterday null/0 (avoid Infinity).
   * Positif = naik, negatif = turun.
   */
  trendPct: number | null;
  /**
   * Indicator untuk new user yang yesterday=0. UI tampilkan "Baru mulai"
   * label daripada -% atau ↑∞%.
   */
  isFreshStart: boolean;
};

export type ChannelSummary = {
  /** Total channel yang ter-config (linked + configured + offline). */
  totalConfigured: number;
  /** Channel yang status linked. */
  active: number;
  /** Daftar id channel yang aktif (untuk badge / chip). */
  activeIds: string[];
};

export type AgentSummary = {
  total: number;
  standby: number;
};

export type TodayStatsPayload = {
  taskCarry: TodayMetric;
  /**
   * Total task (user messages) selama 7 hari terakhir inklusif (hari ini + 6
   * hari sebelumnya). Memberi konteks momentum yang taskCarry "hari ini" tidak
   * punya. Di-sum dari aggregates.daily yang sama (bukan extra RPC).
   */
  weekCarry: number;
  energyUsed: TodayMetric;
  channels: ChannelSummary;
  agents: AgentSummary;
  /** Apakah container running + gateway responsive. */
  engineLive: boolean;
  /** Timestamp server saat aggregate. ISO string. */
  generatedAt: string;
};

const SHORT_DATE_FORMAT = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dateBoundaries(): {
  today: string;
  yesterday: string;
  weekStart: string;
} {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const yest = new Date(now.getTime() - DAY_MS);
  // 6 hari sebelum hari ini → window 7 hari kalender inklusif.
  const wk = new Date(now.getTime() - 6 * DAY_MS);
  return {
    today: SHORT_DATE_FORMAT(now),
    yesterday: SHORT_DATE_FORMAT(yest),
    weekStart: SHORT_DATE_FORMAT(wk),
  };
}

function computeTrend(today: number, yesterday: number | null): TodayMetric {
  if (yesterday == null) {
    return { today, yesterday: null, trendPct: null, isFreshStart: true };
  }
  if (yesterday === 0) {
    return {
      today,
      yesterday: 0,
      trendPct: today > 0 ? null : 0,
      isFreshStart: today > 0,
    };
  }
  const pct = ((today - yesterday) / yesterday) * 100;
  // Clamp extreme values (kalau today=1, yesterday=10000 → -99.99%) ke 1 desimal.
  return {
    today,
    yesterday,
    trendPct: Math.round(pct * 10) / 10,
    isFreshStart: false,
  };
}

function findDayEntry(
  daily: SessionsUsageDailyEntry[] | undefined,
  date: string,
): SessionsUsageDailyEntry | null {
  if (!daily) return null;
  return daily.find((d) => d.date === date) ?? null;
}

/**
 * Sum user task count (messages.user, fallback total) across the inclusive
 * [weekStart, today] window. Dates are "YYYY-MM-DD" → lexicographic compare is
 * safe for range checks.
 */
function sumWeekCarry(
  daily: SessionsUsageDailyEntry[] | undefined,
  weekStart: string,
  today: string,
): number {
  if (!daily) return 0;
  let sum = 0;
  for (const d of daily) {
    if (d.date >= weekStart && d.date <= today) {
      sum += d.messages?.user ?? d.messages?.total ?? 0;
    }
  }
  return sum;
}

function tokensToEnergy(tokens: number, perEnergy: number): number {
  if (tokens <= 0) return 0;
  return Math.ceil(tokens / perEnergy);
}

/**
 * Agents come from the bridge `agents.list` RPC (the same source the Agents tab
 * uses). Hermes agents have no OpenClaw-style heartbeat — every declared agent
 * is always ready to receive delegation, so standby == total.
 */
async function summarizeAgents(client: GatewayClient): Promise<AgentSummary> {
  try {
    const res = await client.call<{ agents?: unknown[] }>("agents.list", {});
    const total = Array.isArray(res?.agents) ? res.agents.length : 0;
    return { total, standby: total };
  } catch {
    return { total: 0, standby: 0 };
  }
}

function emptyPayload(): TodayStatsPayload {
  const zero = { today: 0, yesterday: null, trendPct: null, isFreshStart: true };
  return {
    taskCarry: zero,
    weekCarry: 0,
    energyUsed: zero,
    channels: { totalConfigured: 0, active: 0, activeIds: [] },
    agents: { total: 0, standby: 0 },
    engineLive: false,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Compute today stats untuk satu user. Server-side; harus dipanggil dari
 * trusted context (REST endpoint setelah auth check). Tidak melempar untuk
 * container offline — return shape lengkap dengan engineLive=false.
 */
export async function computeTodayStats(userId: string): Promise<TodayStatsPayload> {
  const [container] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  if (!container || container.status !== "running") {
    return emptyPayload();
  }

  const url = `ws://${hermesConfig.publicHost}:${container.port}/`;

  // Channels reuse the canonical channels dashboard (channels.status incl.
  // synthetic multi-account platforms) so this number always matches the
  // Saluran tab. The legacy `health` RPC on the Hermes bridge returns no
  // channels — relying on it was why this card always read 0/0.
  const channels = await summarizeChannelsFromDashboard(userId);

  try {
    return await withGateway(
      {
        url,
        token: container.gatewayToken,
        clientId: "agentbuff-portal",
        instanceId: `dashboard-stats-${userId.slice(0, 8)}`,
        connectTimeoutMs: 6_000,
        defaultCallTimeoutMs: 12_000,
      },
      async (client) => {
        const { today, yesterday, weekStart } = dateBoundaries();
        // Parallel fetch: sessions.usage (token + message aggregates by day)
        // + agents.list (team size). withGateway closes connection after fn.
        // startDate=weekStart supaya aggregates.daily mencakup 7 hari penuh
        // (untuk weekCarry); today/yesterday tetap ke-cover di dalam range.
        const [usage, agents] = await Promise.all([
          getSessionsUsage(client, {
            startDate: weekStart,
            endDate: today,
            // Gateway enforce limit >= 1; kita cuma butuh aggregates.daily,
            // bukan sessions array. Ambil 1 minimal supaya schema valid.
            limit: 1,
          }),
          summarizeAgents(client),
        ]);

        return assemblePayload(
          { today, yesterday, weekStart },
          usage,
          channels,
          agents,
        );
      },
    );
  } catch (err) {
    // Gateway unreachable / WS fail → return empty + engineLive false.
    // Console.error untuk observability tapi jangan crash dashboard.
    console.error(
      `[today-stats] gateway call failed for user ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ...emptyPayload(), channels };
  }
}

/**
 * Derive the channel summary from the canonical channels dashboard. Active =
 * channels with at least one online account; totalConfigured = connected
 * channels count. Fail-soft to zeros (never throws).
 */
async function summarizeChannelsFromDashboard(
  userId: string,
): Promise<ChannelSummary> {
  try {
    const dash = await computeChannelsDashboard(userId);
    const connected = dash.connectedChannels ?? [];
    const activeIds = connected
      .filter((c) => c.summary.onlineAccounts > 0)
      .map((c) => c.channelId);
    return {
      totalConfigured: connected.length,
      active: activeIds.length,
      activeIds,
    };
  } catch {
    return { totalConfigured: 0, active: 0, activeIds: [] };
  }
}

function assemblePayload(
  bounds: { today: string; yesterday: string; weekStart: string },
  usage: SessionsUsageResult,
  channels: ChannelSummary,
  agents: AgentSummary,
): TodayStatsPayload {
  const tokensPerEnergy = hermesConfig.tokensPerEnergy ?? 2000;
  const daily = usage.aggregates?.daily;

  const todayEntry = findDayEntry(daily, bounds.today);
  const yesterdayEntry = findDayEntry(daily, bounds.yesterday);

  // Task count = total messages dikirim user (proxy untuk task carry).
  // Kalau messages.user gak ada, fallback ke messages.total. Konservatif.
  const todayTasks =
    todayEntry?.messages?.user ?? todayEntry?.messages?.total ?? 0;
  const yesterdayTasks =
    yesterdayEntry?.messages?.user ?? yesterdayEntry?.messages?.total ?? null;

  const todayTokens = todayEntry?.tokens?.total ?? 0;
  const yesterdayTokens = yesterdayEntry?.tokens?.total ?? null;

  const todayEnergy = tokensToEnergy(todayTokens, tokensPerEnergy);
  const yesterdayEnergy =
    yesterdayTokens != null ? tokensToEnergy(yesterdayTokens, tokensPerEnergy) : null;

  return {
    taskCarry: computeTrend(todayTasks, yesterdayTasks),
    weekCarry: sumWeekCarry(daily, bounds.weekStart, bounds.today),
    energyUsed: computeTrend(todayEnergy, yesterdayEnergy),
    channels,
    agents,
    engineLive: true,
    generatedAt: new Date().toISOString(),
  };
}
