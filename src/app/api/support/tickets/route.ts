import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";

// User support tickets (D16). Owner-scoped + rate-limited. Lives at /api/support
// (NOT under /api/app or anything container-gated) so a user whose container is
// down can still file a ticket. Content is stored verbatim and rendered as TEXT
// (never dangerouslySetInnerHTML) in both the user list and the admin view.
const SUBMIT_LIMIT = 5;
const SUBMIT_WINDOW_MS = 10 * 60_000;

const TicketInput = z.object({
  category: z.enum(["keluhan", "pengembangan", "pertanyaan"]),
  subject: z.string().trim().min(5).max(200),
  message: z.string().trim().min(10).max(4000),
});

function genRef(): string {
  return "AB-" + randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const tickets = await db
      .select({
        id: schema.supportTickets.id,
        ref: schema.supportTickets.ref,
        category: schema.supportTickets.category,
        subject: schema.supportTickets.subject,
        message: schema.supportTickets.message,
        status: schema.supportTickets.status,
        reply: schema.supportTickets.reply,
        repliedAt: schema.supportTickets.repliedAt,
        createdAt: schema.supportTickets.createdAt,
      })
      .from(schema.supportTickets)
      .where(eq(schema.supportTickets.userId, session.user.id))
      .orderBy(desc(schema.supportTickets.createdAt))
      .limit(50);
    return Response.json({ tickets });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  const ip = clientIpFromRequest(req);
  try {
    const rl = take(
      keyFromRequest("support.submit", req, userId),
      SUBMIT_LIMIT,
      SUBMIT_WINDOW_MS,
    );
    if (!rl.ok) {
      auditLog({
        event: "rate_limit.exceeded",
        outcome: "reject",
        actor: userId,
        ip,
        details: { ns: "support.submit" },
      });
      return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = TicketInput.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    }

    const [row] = await db
      .insert(schema.supportTickets)
      .values({
        ref: genRef(),
        userId,
        category: parsed.data.category,
        subject: parsed.data.subject,
        message: parsed.data.message,
      })
      .returning({
        id: schema.supportTickets.id,
        ref: schema.supportTickets.ref,
      });

    return Response.json({ ok: true, id: row.id, ref: row.ref });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
