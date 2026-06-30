/**
 * src/lib/hermes/usage-poller.ts
 *
 * Background billing meter for Hermes containers.
 *
 * Mirrors `src/lib/openclaw/usage-poller.ts` mechanics:
 *   - Pull-poll `sessions.usage` RPC against each running Hermes container
 *   - Compute delta vs `lastUsageCursor`, debit `ceil(delta / tokensPerEnergy)`
 *     energy from `user_energy.balance`
 *   - On balance ≤ 0: warn (toast + notification), then after grace period
 *     run `docker stop <container>` to halt LLM usage
 *   - On top-up (balance > 0): clear throttle flag (container restart is
 *     handled by /loby retry or admin script — same pattern as OpenClaw)
 *
 * Differences from OpenClaw poller:
 *   - Filters `engineType="hermes"` instead of "openclaw"
 *   - Uses `withHermesBridge()` (different connect handshake / client.id)
 *   - Uses `bridgeToken` (with `gatewayToken` fallback since provisioner
 *     mirrors both fields)
 *   - Uses `hermesConfig.tokensPerEnergy` / `balanceGraceMs` which fall back
 *     to OPENCLAW_* env vars for transition compatibility
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { auditLog } from "@/lib/security/audit-log";
import { hermesConfig } from "./config";
import { stopContainer } from "./docker";
import {
  GatewayRpcError,
  GatewayTransportError,
  getHermesSessionsUsage,
  withHermesBridge,
} from "./gateway-client";

export type HermesPollOutcome =
  | { kind: "ok"; userId: string; delta: number; debit: number; balance: number }
  | { kind: "reset"; userId: string; priorCursor: number; newCursor: number }
  | { kind: "throttled"; userId: string; balance: number }
  | { kind: "skip"; userId: string; reason: string }
  | { kind: "error"; userId: string; error: string };

const POLL_LOG = process.env.HERMES_USAGE_POLL_LOG === "1";

function shortUid(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8);
}

function log(message: string, extra?: Record<string, unknown>) {
  if (!POLL_LOG) return;
  const prefix = `[hermes-usage-poller ${new Date().toISOString()}]`;
  if (extra) {
    console.log(prefix, message, extra);
  } else {
    console.log(prefix, message);
  }
}

async function debitEnergy(userId: string, delta: number): Promise<number | null> {
  const [row] = await db
    .update(schema.userEnergy)
    .set({ balance: sql`${schema.userEnergy.balance} - ${delta}` })
    .where(eq(schema.userEnergy.userId, userId))
    .returning({ balance: schema.userEnergy.balance });
  return row ? row.balance : null;
}

async function updateCursor(userId: string, newCursor: number): Promise<void> {
  await db
    .update(schema.userContainers)
    .set({
      lastUsageCursor: newCursor,
      lastUsagePolledAt: new Date(),
    })
    .where(eq(schema.userContainers.userId, userId));
}

async function markWarned(userId: string): Promise<void> {
  await db
    .update(schema.userContainers)
    .set({ stopWarnedAt: new Date() })
    .where(eq(schema.userContainers.userId, userId));
}

async function markThrottled(userId: string): Promise<void> {
  await db
    .update(schema.userContainers)
    .set({
      balanceThrottledAt: new Date(),
      stopWarnedAt: null,
      status: "stopped",
    })
    .where(eq(schema.userContainers.userId, userId));
}

async function clearThrottleFlags(userId: string): Promise<void> {
  await db
    .update(schema.userContainers)
    .set({ balanceThrottledAt: null, stopWarnedAt: null })
    .where(eq(schema.userContainers.userId, userId));
}

async function enqueueLowEnergyNotification(userId: string): Promise<void> {
  await db.insert(schema.notifications).values({
    userId,
    tab: "system",
    icon: "zap",
    text: "Energy kamu hampir habis. Top up biar agent nggak berhenti di tengah quest.",
    highPriority: true,
  });
}

export type HermesPollTarget = {
  userId: string;
  port: number;
  bridgeToken: string;
  lastUsageCursor: number;
  stopWarnedAt: Date | null;
  balance: number;
};

async function selectPollTargets(): Promise<HermesPollTarget[]> {
  const rows = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      lastUsageCursor: schema.userContainers.lastUsageCursor,
      stopWarnedAt: schema.userContainers.stopWarnedAt,
      balance: schema.userEnergy.balance,
    })
    .from(schema.userContainers)
    .innerJoin(schema.userEnergy, eq(schema.userEnergy.userId, schema.userContainers.userId))
    .where(eq(schema.userContainers.status, "running"));
  return rows
    .map((r) => ({
      userId: r.userId,
      port: r.port,
      bridgeToken: r.gatewayToken,
      lastUsageCursor: Number(r.lastUsageCursor ?? 0),
      stopWarnedAt: r.stopWarnedAt ?? null,
      balance: r.balance ?? 0,
    }))
    .filter((t): t is HermesPollTarget => Boolean(t.bridgeToken));
}

async function pollOne(target: HermesPollTarget): Promise<HermesPollOutcome> {
  const userId = target.userId;
  try {
    const usage = await withHermesBridge(
      {
        port: target.port,
        bridgeToken: target.bridgeToken,
        callerTag: "agentbuff-hermes-usage-poller",
        connectTimeoutMs: 8_000,
        defaultCallTimeoutMs: 12_000,
      },
      async (client) => getHermesSessionsUsage(client),
    );

    const currentTotal = Number(usage?.totals?.tokens?.total ?? 0);
    if (!Number.isFinite(currentTotal) || currentTotal < 0) {
      return { kind: "skip", userId, reason: "non-finite total" };
    }

    // Restart detection: total < cursor means engine restarted / volume wiped.
    // Reset cursor without debiting — we don't bill what we can't account for.
    if (currentTotal < target.lastUsageCursor) {
      const prior = target.lastUsageCursor;
      await updateCursor(userId, currentTotal);
      log(`reset cursor user=${shortUid(userId)}`, {
        priorCursor: prior,
        newCursor: currentTotal,
      });
      return { kind: "reset", userId, priorCursor: prior, newCursor: currentTotal };
    }

    const delta = currentTotal - target.lastUsageCursor;

    if (delta === 0) {
      await updateCursor(userId, currentTotal);
      return { kind: "skip", userId, reason: "no new tokens" };
    }

    // Floor-1 rule (G10): even a tiny reply debits 1 energy.
    const debit = Math.max(1, Math.ceil(delta / hermesConfig.tokensPerEnergy));
    const newBalance = await debitEnergy(userId, debit);
    await updateCursor(userId, currentTotal);

    if (newBalance === null) {
      return { kind: "skip", userId, reason: "no user_energy row" };
    }

    log(`debited user=${shortUid(userId)} delta=${delta} debit=${debit} balance=${newBalance}`);

    // Throttle policy: warn then stop after grace period
    if (newBalance <= 0) {
      const now = Date.now();
      const warnedMs = target.stopWarnedAt?.getTime() ?? 0;
      const sinceWarned = warnedMs ? now - warnedMs : Infinity;

      if (!warnedMs) {
        // First time we see balance ≤ 0 — warn user + start grace window
        await markWarned(userId);
        await enqueueLowEnergyNotification(userId);
        log(`warned user=${shortUid(userId)} balance=${newBalance}`);
        return { kind: "throttled", userId, balance: newBalance };
      }

      if (sinceWarned >= hermesConfig.balanceGraceMs) {
        // Grace expired — hard stop the container
        try {
          await stopContainer(userId);
          await markThrottled(userId);
          await auditLog({
            event: "billing.throttle.applied",
            outcome: "ok",
            actor: userId,
            details: { engine: "hermes", balance: newBalance },
          });
        } catch (err) {
          await auditLog({
            event: "billing.throttle.applied",
            outcome: "error",
            actor: userId,
            details: {
              engine: "hermes",
              balance: newBalance,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return { kind: "throttled", userId, balance: newBalance };
      }

      return { kind: "throttled", userId, balance: newBalance };
    }

    // Balance > 0 — make sure throttle flags are clear (covers recovery
    // after a top-up where balance crossed back above zero between polls).
    if (target.stopWarnedAt) {
      await clearThrottleFlags(userId);
    }

    return { kind: "ok", userId, delta, debit, balance: newBalance };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GatewayRpcError || err instanceof GatewayTransportError) {
      log(`rpc/transport error user=${shortUid(userId)}: ${msg}`);
    } else {
      log(`unexpected error user=${shortUid(userId)}: ${msg}`);
    }
    return { kind: "error", userId, error: msg };
  }
}

/** Run one sweep — public for admin scripts. */
export async function pollAllOnce(): Promise<HermesPollOutcome[]> {
  const targets = await selectPollTargets();
  if (targets.length === 0) return [];

  const concurrency = Math.max(1, hermesConfig.usagePollConcurrency);
  const outcomes: HermesPollOutcome[] = [];

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const batchOutcomes = await Promise.all(batch.map(pollOne));
    outcomes.push(...batchOutcomes);
  }

  return outcomes;
}

export interface HermesUsagePollerHandle {
  stop: () => Promise<void>;
}

/**
 * Spawn the Hermes usage poller background loop.
 * Returns a handle with `stop()` for graceful shutdown.
 *
 * Designed to coexist with OpenClaw usage poller — each handles its own
 * engineType subset. Both can be started simultaneously from server.ts.
 *
 * Disable via env: HERMES_USAGE_POLLER_DISABLED=1
 */
export function startHermesUsagePoller(): HermesUsagePollerHandle {
  if (!hermesConfig.usagePollerEnabled) {
    console.log("[hermes-usage-poller] disabled via env");
    return { stop: async () => {} };
  }

  const interval = hermesConfig.usagePollIntervalMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> = Promise.resolve();

  console.log(
    `[hermes-usage-poller] starting (interval=${interval}ms, concurrency=${hermesConfig.usagePollConcurrency})`,
  );

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      activeRun = (async () => {
        try {
          const outcomes = await pollAllOnce();
          if (outcomes.length > 0) {
            const summary = outcomes.reduce<Record<string, number>>(
              (acc, o) => {
                acc[o.kind] = (acc[o.kind] ?? 0) + 1;
                return acc;
              },
              {},
            );
            log("sweep complete", summary);
          }
        } catch (err) {
          console.error("[hermes-usage-poller] sweep crashed:", err);
        }
        scheduleNext();
      })();
    }, interval);
  };

  scheduleNext();

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await activeRun;
      console.log("[hermes-usage-poller] stopped");
    },
  };
}
