import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const DEFAULTS = {
  enabled: true,
  reminderOffsetsDays: [3, 2, 1] as number[],
  senderName: null as string | null,
  replyTo: null as string | null,
};

// Admin email/reminder settings (D15). Read = admin/support; write = admin only.
// The trial + renewal workers read this row (src/lib/email/settings.ts, ~60s
// cache), so edits take effect within a minute — no restart needed.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const [row] = await db
      .select()
      .from(schema.emailSettings)
      .where(eq(schema.emailSettings.id, "default"))
      .limit(1);
    if (!row) return Response.json(DEFAULTS);
    return Response.json({
      enabled: row.enabled,
      reminderOffsetsDays: row.reminderOffsetsDays,
      senderName: row.senderName,
      replyTo: row.replyTo,
      updatedAt: row.updatedAt,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

function sanitizeOffsets(v: unknown): number[] {
  if (!Array.isArray(v)) return DEFAULTS.reminderOffsetsDays;
  const cleaned = Array.from(
    new Set(
      v
        .map((x) => Math.trunc(Number(x)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 90),
    ),
  )
    .sort((a, b) => b - a)
    .slice(0, 6);
  return cleaned.length ? cleaned : DEFAULTS.reminderOffsetsDays;
}
function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const enabled = Boolean(body.enabled);
    const reminderOffsetsDays = sanitizeOffsets(body.reminderOffsetsDays);
    const senderName = clip(body.senderName, 80);
    const replyTo = clip(body.replyTo, 120);
    const now = new Date();

    await db
      .insert(schema.emailSettings)
      .values({
        id: "default",
        enabled,
        reminderOffsetsDays,
        senderName,
        replyTo,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.emailSettings.id,
        set: { enabled, reminderOffsetsDays, senderName, replyTo, updatedAt: now },
      });

    auditLog({
      event: "admin.settings.update",
      outcome: "ok",
      actor: actor.id,
      details: { area: "email", enabled },
    });

    return Response.json({
      ok: true,
      enabled,
      reminderOffsetsDays,
      senderName,
      replyTo,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
