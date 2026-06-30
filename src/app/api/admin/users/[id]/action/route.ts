import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const ROLES = new Set(["user", "support", "admin"]);

// Admin user actions (D1 finisher). Mutation — admin only.
//   set-role: change users.role (guards against self-demotion lockout).
//   extend-trial: push userTrials.endsAt out + reactivate + restart a container
//     that was docker-stopped at trial expiry, so access is fully restored.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      role?: string;
      days?: number;
      reason?: string;
    };
    const action = body.action ?? "";

    if (action === "set-role") {
      const role = body.role ?? "";
      if (!ROLES.has(role)) {
        return Response.json({ error: "INVALID_ROLE" }, { status: 400 });
      }
      if (id === actor.id && role !== "admin") {
        return Response.json({ error: "CANNOT_SELF_DEMOTE" }, { status: 400 });
      }
      const res = await db
        .update(schema.users)
        .set({ role, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (res.length === 0) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action, role },
      });
      return Response.json({ ok: true });
    }

    if (action === "extend-trial") {
      const days = Math.max(
        1,
        Math.min(90, Math.trunc(Number(body.days ?? 0)) || 0),
      );
      const [trial] = await db
        .select({
          endsAt: schema.userTrials.endsAt,
          status: schema.userTrials.status,
        })
        .from(schema.userTrials)
        .where(eq(schema.userTrials.userId, id))
        .limit(1);
      if (!trial) {
        return Response.json({ error: "NO_TRIAL" }, { status: 400 });
      }
      const now = new Date();
      // Stack on remaining time if still active; resume from today if expired.
      const base = trial.endsAt > now ? trial.endsAt : now;
      const newEnds = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      await db
        .update(schema.userTrials)
        .set({ endsAt: newEnds, status: "active", lastRemindedDaysLeft: null })
        .where(eq(schema.userTrials.userId, id));

      // Restart the container if the lifecycle worker docker-stopped it at expiry.
      const [cont] = await db
        .select({ status: schema.userContainers.status })
        .from(schema.userContainers)
        .where(eq(schema.userContainers.userId, id))
        .limit(1);
      if (cont?.status === "stopped") {
        const { startContainer } = await import("@/lib/hermes/docker");
        void startContainer(id).catch((e) =>
          console.error("[admin] extend-trial container start failed:", e),
        );
      }

      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action, days },
      });
      return Response.json({ ok: true, endsAt: newEnds });
    }

    if (action === "suspend") {
      // Block self-suspend: an admin must not lock themselves out of the panel.
      if (id === actor.id) {
        return Response.json({ error: "CANNOT_SELF_SUSPEND" }, { status: 400 });
      }
      const reason = (body.reason ?? "").trim().slice(0, 300) || null;
      const res = await db
        .update(schema.users)
        .set({ suspended: true, suspendedReason: reason, suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (res.length === 0) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      // Cut off live access now: docker-stop the running container. Fire-and-forget
      // so a slow Docker call doesn't block the admin response; the /app gate
      // already blocks the suspended user on next load regardless.
      const { stopContainer } = await import("@/lib/hermes/docker");
      void stopContainer(id).catch((e) =>
        console.error("[admin] suspend container stop failed:", e),
      );
      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action, reason },
      });
      return Response.json({ ok: true });
    }

    if (action === "unsuspend") {
      const res = await db
        .update(schema.users)
        .set({ suspended: false, suspendedReason: null, suspendedAt: null, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (res.length === 0) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      // Restore access: restart the container only if suspension docker-stopped it.
      const [cont] = await db
        .select({ status: schema.userContainers.status })
        .from(schema.userContainers)
        .where(eq(schema.userContainers.userId, id))
        .limit(1);
      if (cont?.status === "stopped") {
        const { startContainer } = await import("@/lib/hermes/docker");
        void startContainer(id).catch((e) =>
          console.error("[admin] unsuspend container start failed:", e),
        );
      }
      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action },
      });
      return Response.json({ ok: true });
    }

    if (action === "schedule-delete") {
      // Grace-delete (D1): mark for hard deletion after a grace window, stop the
      // container now (access blocked during grace), recoverable until the
      // cleanup worker runs. Block self-delete.
      if (id === actor.id) {
        return Response.json({ error: "CANNOT_SELF_DELETE" }, { status: 400 });
      }
      const reason = (body.reason ?? "").trim().slice(0, 300) || null;
      const graceDays = Math.max(
        1,
        Math.min(30, Math.trunc(Number(body.days ?? 7)) || 7),
      );
      const scheduledAt = new Date(
        Date.now() + graceDays * 24 * 60 * 60 * 1000,
      );
      const res = await db
        .update(schema.users)
        .set({
          deletionScheduledAt: scheduledAt,
          deletionReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (res.length === 0) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      const { stopContainer } = await import("@/lib/hermes/docker");
      void stopContainer(id).catch((e) =>
        console.error("[admin] schedule-delete container stop failed:", e),
      );
      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action, graceDays, reason },
      });
      return Response.json({ ok: true, scheduledAt });
    }

    if (action === "cancel-delete") {
      const res = await db
        .update(schema.users)
        .set({
          deletionScheduledAt: null,
          deletionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (res.length === 0) {
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
      // Restore access: restart the container if the schedule docker-stopped it.
      const [cont] = await db
        .select({ status: schema.userContainers.status })
        .from(schema.userContainers)
        .where(eq(schema.userContainers.userId, id))
        .limit(1);
      if (cont?.status === "stopped") {
        const { startContainer } = await import("@/lib/hermes/docker");
        void startContainer(id).catch((e) =>
          console.error("[admin] cancel-delete container start failed:", e),
        );
      }
      auditLog({
        event: "admin.user.action",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { action },
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
