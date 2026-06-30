// D1 — grace-delete cleanup worker. Hard-deletes accounts whose
// users.deletion_scheduled_at has passed: destroys the container + volume, then
// deletes the user row (cascade). Recovery is possible any time before the date
// (admin cancel-delete clears the column). The trial_grants anti-farm ledger is
// NOT FK'd, so it survives — a deleted+re-registered email still can't re-trial.
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordHeartbeat } from "@/lib/admin/worker-health";
import { destroyContainer } from "@/lib/hermes/docker";
import { auditLog } from "@/lib/security/audit-log";

const INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AGENTBUFF_DELETE_WORKER_INTERVAL_MS ?? "",
    10,
  );
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000; // hourly
})();

export type AccountDeletionWorkerHandle = { stop: () => Promise<void> };

async function sweepDeletions(): Promise<void> {
  const now = new Date();
  const due = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        isNotNull(schema.users.deletionScheduledAt),
        lte(schema.users.deletionScheduledAt, now),
      ),
    );
  for (const u of due) {
    try {
      await destroyContainer(u.id);
    } catch (e) {
      // Proceed with the row delete anyway — better than a dangling account.
      console.error("[delete-worker] destroyContainer failed for", u.id, e);
    }
    await db.delete(schema.users).where(eq(schema.users.id, u.id));
    auditLog({
      event: "admin.user.action",
      outcome: "ok",
      actor: "system",
      target: u.id,
      details: { action: "grace_delete_executed" },
    });
  }
}

export function startAccountDeletionWorker(): AccountDeletionWorkerHandle {
  let running = true;
  let inFlight: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (!running || inFlight) return;
    inFlight = (async () => {
      let ok = true;
      try {
        await sweepDeletions();
      } catch (e) {
        ok = false;
        console.error("[delete-worker] sweep failed:", e);
      } finally {
        recordHeartbeat("account-deletion-worker", ok, { intervalMs: INTERVAL_MS });
        inFlight = null;
      }
    })();
  }, INTERVAL_MS);

  console.log(`[delete-worker] started — interval=${INTERVAL_MS}ms`);

  return {
    stop: async () => {
      running = false;
      clearInterval(interval);
      if (inFlight) await inFlight;
    },
  };
}
