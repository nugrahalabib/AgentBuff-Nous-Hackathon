import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

// Admin support reply/status (D16). Mutation — admin only (support role is
// read-only). Replying drops a notification row for the ticket owner so they
// know to check /bantuan. Replying with no explicit status auto-sets 'answered'.
const PatchInput = z.object({
  reply: z.string().trim().max(4000).optional(),
  status: z.enum(["open", "in_progress", "answered", "closed"]).optional(),
});

export async function PATCH(
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
    const body = await req.json().catch(() => ({}));
    const parsed = PatchInput.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    }
    const reply = parsed.data.reply?.trim();
    const hasReply = !!reply && reply.length > 0;
    const newStatus = parsed.data.status ?? (hasReply ? "answered" : undefined);
    if (!hasReply && !newStatus) {
      return Response.json({ error: "NOTHING_TO_UPDATE" }, { status: 400 });
    }

    const [ticket] = await db
      .select({
        userId: schema.supportTickets.userId,
        ref: schema.supportTickets.ref,
        subject: schema.supportTickets.subject,
      })
      .from(schema.supportTickets)
      .where(eq(schema.supportTickets.id, id))
      .limit(1);
    if (!ticket) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    const now = new Date();
    const set: Partial<typeof schema.supportTickets.$inferInsert> = {
      updatedAt: now,
    };
    if (hasReply) {
      set.reply = reply;
      set.repliedBy = actor.id;
      set.repliedAt = now;
    }
    if (newStatus) set.status = newStatus;
    await db
      .update(schema.supportTickets)
      .set(set)
      .where(eq(schema.supportTickets.id, id));

    if (hasReply) {
      // Notify the owner — the existing NotificationBell renders this.
      await db.insert(schema.notifications).values({
        userId: ticket.userId,
        tab: "system",
        // The NotificationBell renders icon as raw text, so use an emoji (not a
        // lucide kebab name like "life-buoy", which would show as literal text).
        icon: "🛟",
        text: `Tim dukungan membalas tiket ${ticket.ref}: ${ticket.subject}`,
        actionLabel: "Lihat",
        actionHref: "/bantuan",
      });
    }

    auditLog({
      event: "admin.support.reply",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: { hasReply, status: newStatus ?? null },
    });
    return Response.json({ ok: true, status: newStatus ?? null });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
