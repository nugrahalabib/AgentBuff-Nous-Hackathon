/**
 * src/lib/hermes/ports.ts
 *
 * Race-safe port allocation from the shared `container_port_slot` table.
 *
 * Identical pattern to `src/lib/openclaw/ports.ts` — same Postgres table,
 * same `FOR UPDATE SKIP LOCKED` claim. Pool is shared because:
 *   - Both engine types run loopback-published containers on the host
 *   - Mixing OpenClaw and Hermes containers in the same host is supported
 *     during the migration window
 *   - One port-claim row per user (UNIQUE userId) prevents engine-mixing
 *     for the same user (can't have both an OpenClaw and Hermes container
 *     simultaneously)
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { containerPortSlots } from "@/lib/db/schema";

export class PortPoolExhaustedError extends Error {
  constructor(message = "container port pool is exhausted") {
    super(message);
    this.name = "PortPoolExhaustedError";
  }
}

/**
 * Atomically claim a port slot for `userId`, or return the one already
 * claimed if any.
 *
 * - Idempotent: callable multiple times by the same user.
 * - Race-safe across concurrent provisioners (FOR UPDATE SKIP LOCKED).
 *
 * Throws `PortPoolExhaustedError` when no free slot is available.
 */
export async function claimPort(userId: string): Promise<number> {
  // Fast path: existing claim
  const [existing] = await db
    .select({ port: containerPortSlots.port })
    .from(containerPortSlots)
    .where(eq(containerPortSlots.userId, userId))
    .limit(1);
  if (existing) {
    return existing.port;
  }

  // Atomic claim via UPDATE ... WHERE port=(SELECT ... FOR UPDATE SKIP LOCKED).
  // The drizzle postgres-js driver returns rows as an array-like Result, not
  // { rows: [...] }. Treat the return value as the row array directly (matches
  // src/lib/openclaw/ports.ts which has been working in production).
  const claimed = await db.execute<{ port: number }>(sql`
    UPDATE container_port_slot
       SET user_id = ${userId}, claimed_at = NOW()
     WHERE port = (
       SELECT port FROM container_port_slot
        WHERE user_id IS NULL
        ORDER BY port
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING port
  `);

  if (claimed.length === 0) {
    throw new PortPoolExhaustedError();
  }
  return claimed[0].port;
}

/**
 * Release a previously claimed port slot. Safe to call when no claim exists.
 */
export async function releasePort(userId: string): Promise<void> {
  await db
    .update(containerPortSlots)
    .set({ userId: null, claimedAt: null })
    .where(eq(containerPortSlots.userId, userId));
}
