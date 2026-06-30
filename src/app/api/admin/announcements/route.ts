import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const AUDIENCES = new Set(["all", "onboarded", "trial", "subscribed"]);
const TABS = new Set(["chat", "billing", "skills", "channels", "system"]);
const CHUNK = 1000;

// Admin announcement broadcast (D9 CMS-app). Read = admin/support; send = admin.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const rows = await db
      .select({
        id: schema.announcements.id,
        message: schema.announcements.message,
        tab: schema.announcements.tab,
        audience: schema.announcements.audience,
        highPriority: schema.announcements.highPriority,
        recipientCount: schema.announcements.recipientCount,
        createdAt: schema.announcements.createdAt,
      })
      .from(schema.announcements)
      .orderBy(desc(schema.announcements.createdAt))
      .limit(50);
    return Response.json({ rows });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

async function resolveAudience(audience: string): Promise<string[]> {
  if (audience === "onboarded") {
    return (
      await db
        .select({ id: schema.userProfiles.userId })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.onboarded, true))
    ).map((r) => r.id);
  }
  if (audience === "trial") {
    return (
      await db
        .select({ id: schema.userTrials.userId })
        .from(schema.userTrials)
        .where(eq(schema.userTrials.status, "active"))
    ).map((r) => r.id);
  }
  if (audience === "subscribed") {
    return (
      await db
        .select({ id: schema.subscriptions.userId })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.status, "active"))
    ).map((r) => r.id);
  }
  return (await db.select({ id: schema.users.id }).from(schema.users)).map(
    (r) => r.id,
  );
}

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  // Broadcast fans out one notification row per user — rate-limit so a stuck
  // double-click or a script can't spam every user's inbox.
  const rl = take(keyFromRequest("admin.announce", req, actor.id), 10, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body.message ?? "").trim().slice(0, 500);
    if (!message) return Response.json({ error: "INVALID_MESSAGE" }, { status: 400 });
    const tab = TABS.has(String(body.tab)) ? String(body.tab) : "chat";
    const audience = AUDIENCES.has(String(body.audience))
      ? String(body.audience)
      : "all";
    const highPriority = Boolean(body.highPriority);
    const actionLabel = body.actionLabel
      ? String(body.actionLabel).slice(0, 60)
      : null;
    const actionHref = body.actionHref
      ? String(body.actionHref).slice(0, 300)
      : null;

    const userIds = Array.from(new Set(await resolveAudience(audience)));

    // Fan-out into per-user notification rows (chunked to stay within param
    // limits) — the app already renders these, so the broadcast is immediately
    // visible in-app.
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const slice = userIds.slice(i, i + CHUNK);
      await db.insert(schema.notifications).values(
        slice.map((uid) => ({
          userId: uid,
          tab,
          text: message,
          highPriority,
          actionLabel,
          actionHref,
        })),
      );
    }

    const [ann] = await db
      .insert(schema.announcements)
      .values({
        message,
        tab,
        audience,
        highPriority,
        actionLabel,
        actionHref,
        recipientCount: userIds.length,
        createdBy: actor.id,
      })
      .returning({ id: schema.announcements.id });

    auditLog({
      event: "admin.announcement.send",
      outcome: "ok",
      actor: actor.id,
      target: ann.id,
      details: { audience, recipients: userIds.length },
    });
    return Response.json({ ok: true, recipients: userIds.length });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
