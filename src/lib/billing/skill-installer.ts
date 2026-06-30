import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { installSkill, withGateway, GatewayRpcError } from "@/lib/hermes/gateway-client";
import { auditLog } from "@/lib/security/audit-log";
import { getSkill } from "./skill-catalog";

// Backoff schedule for retryable install failures. Indexed by attemptCount
// BEFORE incrementing (so first retry waits 30s, second 2min, ...). After
// max attempts we stop retrying and leave the transaction in "install_failed"
// for manual / support intervention.
const RETRY_DELAYS_MS = [
  30_000,       // 30s
  2 * 60_000,   // 2min
  10 * 60_000,  // 10min
  60 * 60_000,  // 1h
  6 * 60 * 60_000, // 6h
] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 6 total tries (1 initial + 5 retries).

export type InstallOutcome =
  | { kind: "installed"; transactionId: string; skillKey: string }
  | { kind: "container-not-running"; transactionId: string; reason: string }
  | { kind: "gave-up"; transactionId: string; error: string }
  | { kind: "will-retry"; transactionId: string; error: string; nextRetryAt: Date }
  | { kind: "skip"; transactionId: string; reason: string };

type TxRow = typeof schema.transactions.$inferSelect;
type ContainerRow = typeof schema.userContainers.$inferSelect;

function nextRetryDelay(attemptsAfterFailure: number): number {
  const idx = Math.min(attemptsAfterFailure - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[Math.max(0, idx)];
}

async function recordFailure(txId: string, errMsg: string, attemptsAfterFailure: number): Promise<InstallOutcome> {
  if (attemptsAfterFailure >= MAX_ATTEMPTS) {
    await db
      .update(schema.transactions)
      .set({
        status: "install_failed",
        lastInstallError: errMsg.slice(0, 500),
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.transactions.id, txId));
    return { kind: "gave-up", transactionId: txId, error: errMsg };
  }
  const delay = nextRetryDelay(attemptsAfterFailure);
  const nextRetryAt = new Date(Date.now() + delay);
  await db
    .update(schema.transactions)
    .set({
      lastInstallError: errMsg.slice(0, 500),
      nextRetryAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.transactions.id, txId));
  return { kind: "will-retry", transactionId: txId, error: errMsg, nextRetryAt };
}

async function upsertContainerSkill(
  userId: string,
  skillKey: string,
  source: string,
  version: string | null,
  transactionId: string,
  marketplaceItemId: string | null,
): Promise<void> {
  await db
    .insert(schema.containerSkills)
    .values({
      userId,
      skillKey,
      source,
      marketplaceItemId,
      enabled: true,
      version: version ?? null,
      transactionId,
    })
    .onConflictDoUpdate({
      target: [schema.containerSkills.userId, schema.containerSkills.skillKey],
      set: {
        enabled: true,
        source,
        marketplaceItemId,
        version: version ?? null,
        transactionId,
        updatedAt: new Date(),
      },
    });
}

// Unified install target — resolved from EITHER the static catalog (getSkill)
// or, for marketplace purchases (metadata.source==='marketplace'), the DB
// listing's installSpec. Carries everything the gateway call + bookkeeping need.
type InstallParams =
  | { source: "clawhub"; slug: string; version?: string; force: true }
  | { source: "direct"; name: string; installId: string; version?: string; force: true };
type InstallTarget = {
  skillKey: string;
  title: string;
  source: "clawhub" | "direct";
  version: string | null;
  marketplaceItemId: string | null;
  params: InstallParams;
};

// listing.installSpec is untrusted jsonb (admin-authored) — validate before it
// ever reaches the gateway. Only the skills.install-compatible shapes are
// accepted; mcp_app/bundle installs are a separate path (not this RPC) and are
// rejected here so a purchased item can never silently mis-install.
const INSTALL_SPEC = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("clawhub"),
    slug: z.string().min(1).max(200),
    version: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal("direct"),
    name: z.string().min(1).max(200),
    installId: z.string().max(200).optional(),
    version: z.string().max(64).optional(),
  }),
]);

export async function resolveInstallTarget(
  tx: TxRow,
): Promise<{ ok: true; target: InstallTarget } | { ok: false; error: string }> {
  const meta = (tx.metadata ?? {}) as Record<string, unknown>;

  if (meta.source === "marketplace") {
    const listingId = typeof meta.listingId === "string" ? meta.listingId : null;
    if (!listingId) return { ok: false, error: "marketplace tx missing listingId" };
    const [listing] = await db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId))
      .limit(1);
    if (!listing) return { ok: false, error: `listing not found: ${listingId}` };

    const parsed = INSTALL_SPEC.safeParse(listing.installSpec);
    if (!parsed.success)
      return {
        ok: false,
        error: `unsupported/invalid installSpec for listing ${listingId} (kind=${listing.kind})`,
      };
    const spec = parsed.data;
    const version = spec.version ?? listing.version ?? null;
    if (spec.type === "clawhub") {
      return {
        ok: true,
        target: {
          skillKey: spec.slug,
          title: listing.title,
          source: "clawhub",
          version,
          marketplaceItemId: listing.id,
          params: { source: "clawhub", slug: spec.slug, version: version ?? undefined, force: true },
        },
      };
    }
    return {
      ok: true,
      target: {
        skillKey: spec.name,
        title: listing.title,
        source: "direct",
        version,
        marketplaceItemId: listing.id,
        params: {
          source: "direct",
          name: spec.name,
          installId: spec.installId ?? tx.id,
          version: version ?? undefined,
          force: true,
        },
      },
    };
  }

  // Catalog path (existing behavior).
  if (!tx.sku) return { ok: false, error: "transaction missing sku" };
  const skill = await getSkill(tx.sku);
  if (!skill) return { ok: false, error: `unknown skill ${tx.sku}` };
  return {
    ok: true,
    target: {
      skillKey: skill.key,
      title: skill.title,
      source: skill.source,
      version: skill.version ?? null,
      marketplaceItemId: null,
      params:
        skill.source === "clawhub"
          ? { source: "clawhub", slug: skill.key, version: skill.version, force: true }
          : { source: "direct", name: skill.key, installId: tx.id, version: skill.version, force: true },
    },
  };
}

// The core installer. Safe to call:
//   - from webhook (synchronous path after payment settles)
//   - from retry worker (periodic sweep of pending installs)
//   - from provisioner self-heal (re-running against a fresh volume)
//
// Contract: caller has already verified the payment is settled. This function
// only orchestrates the gateway install + DB bookkeeping.
export async function installSkillForTransaction(transactionId: string): Promise<InstallOutcome> {
  // 1. Atomically claim the transaction so concurrent callers don't race.
  //    We bump attemptCount here so failures propagate the counter.
  const [claimed] = await db
    .update(schema.transactions)
    .set({
      attemptCount: sql`${schema.transactions.attemptCount} + 1`,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.transactions.id, transactionId),
        isNull(schema.transactions.installedAt),
      ),
    )
    .returning();

  if (!claimed) {
    return { kind: "skip", transactionId, reason: "already installed or not claimable" };
  }

  const tx: TxRow = claimed;
  const attemptCount = tx.attemptCount ?? 1;

  if (tx.type !== "skill-install") {
    return { kind: "skip", transactionId, reason: `unexpected type ${tx.type}` };
  }
  if (tx.status !== "completed") {
    return { kind: "skip", transactionId, reason: `not paid (status=${tx.status})` };
  }

  // Resolve WHAT to install — catalog skill (sku) or marketplace listing
  // (validated installSpec). Bad/unknown target -> recordFailure (never crash).
  const resolved = await resolveInstallTarget(tx);
  if (!resolved.ok) {
    return recordFailure(transactionId, resolved.error, attemptCount);
  }
  const target = resolved.target;

  // 2. Look up the user's container. Install is only possible against a
  //    running container — otherwise we park the transaction and retry later.
  const [container] = await db
    .select()
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, tx.userId))
    .limit(1);

  if (!container) {
    const nextRetry = new Date(Date.now() + 60_000);
    await db
      .update(schema.transactions)
      .set({ nextRetryAt: nextRetry, lastInstallError: "no container for user", updatedAt: new Date() })
      .where(eq(schema.transactions.id, transactionId));
    return { kind: "container-not-running", transactionId, reason: "no container row" };
  }
  const c: ContainerRow = container;

  if (c.status !== "running") {
    // Container might be mid-provisioning, docker-stopped (balance throttle),
    // or failed. All three cases: try again shortly.
    const nextRetry = new Date(Date.now() + 90_000);
    await db
      .update(schema.transactions)
      .set({
        nextRetryAt: nextRetry,
        lastInstallError: `container status=${c.status}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.transactions.id, transactionId));
    return { kind: "container-not-running", transactionId, reason: c.status };
  }

  // 3. Call skills.install over WS JSON-RPC. force:true → idempotent at the
  //    gateway: if the skill is already present at the same version, it's a
  //    no-op success. Makes retries safe.
  try {
    const result = await withGateway(
      {
        url: `ws://${hermesConfig.bindHost}:${c.port}/`,
        token: c.gatewayToken,
        clientId: "agentbuff-skill-installer",
        role: "operator",
        userAgent: "agentbuff-portal/skill-installer",
        connectTimeoutMs: 10_000,
        defaultCallTimeoutMs: 120_000,
      },
      async (client) => installSkill(client, target.params, { timeoutMs: 120_000 }),
    );

    // 4. Persist the install in Postgres. Upsert so retries don't dup-row.
    await upsertContainerSkill(
      tx.userId,
      target.skillKey,
      target.source,
      result.version ?? target.version ?? null,
      transactionId,
      target.marketplaceItemId,
    );

    await db
      .update(schema.transactions)
      .set({
        status: "installed",
        installedAt: new Date(),
        lastInstallError: null,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.transactions.id, transactionId));

    await db.insert(schema.notifications).values({
      userId: tx.userId,
      tab: "store",
      icon: "sparkles",
      text: `Skill "${target.title}" berhasil dipasang. Selamat level up!`,
      highPriority: false,
    });

    auditLog({
      event: "billing.skill.install_completed",
      outcome: "ok",
      actor: tx.userId,
      target: transactionId,
      details: { skillKey: target.skillKey, attempts: attemptCount },
    });

    return { kind: "installed", transactionId, skillKey: target.skillKey };
  } catch (e) {
    const msg =
      e instanceof GatewayRpcError
        ? `rpc ${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    auditLog({
      event: "billing.skill.install_failed",
      outcome: "error",
      actor: tx.userId,
      target: transactionId,
      details: { skillKey: target.skillKey, attempts: attemptCount, errorKind: e instanceof GatewayRpcError ? "rpc" : "other" },
    });
    return recordFailure(transactionId, msg, attemptCount);
  }
}

// Self-healing: rehydrate a user's paid skills against a fresh container.
// Called from provisionContainer's success path after a destroy → reprovision,
// where the old volume is gone and the new one has no skills installed yet.
//
// We reset installedAt=NULL on every paid skill transaction so the standard
// installer re-runs. Because installSkillForTransaction uses force:true at
// the gateway, re-invoking it on a fresh volume is the correct primitive.
//
// Fire-and-forget: returns the count of re-queued transactions and lets the
// retry worker take it from here. Caller should not await installs inside
// the provisioning path (would blow out health-check latency).
export async function reinstallSkillsForUser(userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.type, "skill-install"),
      ),
    );

  if (rows.length === 0) return 0;

  // Filter to ones that are paid (completed/installed) — don't touch
  // pending/failed payments. "installed" means we had a successful install
  // once; reset it so the retry loop picks the skill back up against the
  // fresh volume.
  const eligibleIds: string[] = [];
  for (const r of rows) {
    const [tx] = await db
      .select({
        status: schema.transactions.status,
        adminUninstalledAt: schema.transactions.adminUninstalledAt,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, r.id))
      .limit(1);
    if (!tx) continue;
    // An admin force-uninstall pulled this skill — never resurrect it on
    // reprovision, even though it's a paid/installed row.
    if (tx.adminUninstalledAt) continue;
    if (tx.status === "installed" || tx.status === "completed") {
      eligibleIds.push(r.id);
    }
  }

  if (eligibleIds.length === 0) return 0;

  await db
    .update(schema.transactions)
    .set({
      status: "completed",
      installedAt: null,
      nextRetryAt: null,
      attemptCount: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.type, "skill-install"),
        // ONLY the rows we vetted as paid-and-installed above. Without this an
        // unpaid 'pending' / 'install_failed' row would be flipped to 'completed'
        // + queued, installing a skill the user never paid for (money-path bug).
        inArray(schema.transactions.id, eligibleIds),
      ),
    );

  // Kick them off in the background. Retry worker picks up anything that
  // trips against a still-warming gateway.
  for (const id of eligibleIds) {
    void installSkillForTransaction(id).catch((e) => {
      console.error(`[skill-installer] reinstall dispatch failed for tx=${id}:`, e);
    });
  }
  return eligibleIds.length;
}
