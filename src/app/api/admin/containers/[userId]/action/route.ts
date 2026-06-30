import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import {
  stopContainer,
  startContainer,
  destroyContainer,
  getContainerStatus,
  fireAndForgetProvision,
} from "@/lib/hermes/docker";
import { backupVolume, restoreVolume } from "@/lib/hermes/backup";
import { auditLog } from "@/lib/security/audit-log";

const ACTIONS = new Set([
  "stop",
  "start",
  "destroy",
  "reprovision",
  "refresh",
  "backup",
  "restore",
]);

// Admin container actions (D5). Mutation — only `admin` (support is read-only).
// start/reprovision are long (docker start + health wait) so they run
// fire-and-forget; the fleet UI re-polls for the resulting status.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { userId } = await params;
    // Charset allowlist (NextAuth ids are uuid/cuid). This is a HARD gate before
    // userId can reach volumeName() -> a docker `-v` arg in backup/restore:
    // shellEscape double-quotes args but does NOT neutralise $()/backtick command
    // substitution, so an unconstrained id is a (admin-gated) injection sink.
    if (!userId || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      backupFile?: string;
    };
    const action = body.action ?? "";
    if (!ACTIONS.has(action)) {
      return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
    }

    // Backup/restore (D5) are long, host-side tar ops with their own payloads —
    // handle + return here before the generic lifecycle block below.
    if (action === "backup") {
      const { filename } = await backupVolume(userId, Date.now());
      auditLog({
        event: "admin.container.backup",
        outcome: "ok",
        actor: actor.id,
        target: userId,
        details: { filename },
      });
      return Response.json({ ok: true, filename });
    }
    if (action === "restore") {
      const backupFile = (body.backupFile ?? "").trim();
      if (!backupFile) {
        return Response.json({ error: "MISSING_BACKUP_FILE" }, { status: 400 });
      }
      const r = await restoreVolume(userId, backupFile);
      auditLog({
        event: "admin.container.restore",
        outcome: r.ok ? "ok" : "error",
        actor: actor.id,
        target: userId,
        details: { backupFile, restarted: r.restarted },
      });
      if (!r.ok) {
        return Response.json({ error: "RESTORE_FAILED", message: r.message }, { status: 400 });
      }
      return Response.json({ ok: true, message: r.message, restarted: r.restarted });
    }

    let asyncJob = false;
    if (action === "stop") {
      await stopContainer(userId);
    } else if (action === "destroy") {
      await destroyContainer(userId);
    } else if (action === "start") {
      void startContainer(userId).catch((e) =>
        console.error("[admin] container start failed:", e),
      );
      asyncJob = true;
    } else if (action === "reprovision") {
      fireAndForgetProvision(userId);
      asyncJob = true;
    }
    // "refresh" falls through — just re-reads status below.

    auditLog({
      event: "admin.container.action",
      outcome: "ok",
      actor: actor.id,
      target: userId,
      details: { action },
    });
    // container_event is emitted by docker.ts itself for stop/start/destroy/
    // reprovision with the REAL outcome (ok/fail) — emitting here too would
    // double-count and (for the fire-and-forget start/reprovision) write a
    // premature ok:true before the async job resolves. Only "refresh" — which
    // is a manual status poll, not a lifecycle transition docker.ts emits for —
    // is recorded here.
    if (action === "refresh") {
      await db
        .insert(schema.containerEvents)
        .values({ userId, event: "health", ok: true })
        .catch(() => {
          /* container_event is best-effort */
        });
    }

    const status = await getContainerStatus(userId);
    return Response.json({
      ok: true,
      async: asyncJob,
      status: status?.status ?? null,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
