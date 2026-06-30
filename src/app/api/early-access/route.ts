import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { z } from "zod/v4";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// Public early-access waitlist intake (landing pricing form). Writes a lead
// row that the Admin page (phase 5) reads. No auth gate — anyone can register
// interest — so it is rate-limited + validated like the register endpoint.
// UTM attribution (D10): only the 5 standard keys, each a short string. Anything
// else is dropped so the column can't be stuffed with arbitrary data.
const utmSchema = z
  .object({
    source: z.string().max(120).optional(),
    medium: z.string().max(120).optional(),
    campaign: z.string().max(120).optional(),
    term: z.string().max(120).optional(),
    content: z.string().max(120).optional(),
  })
  .optional();

const earlyAccessSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  whatsapp: z.string().max(40).optional(),
  note: z.string().max(1000).optional(),
  tier: z.string().max(30).optional(),
  utm: utmSchema,
});

// 5 submissions per 10 min per source IP. Generous for a real person; chokes
// a bot trying to flood the lead table.
const LIMIT = 5;
const WINDOW_MS = 10 * 60_000;

export async function POST(request: Request) {
  const ip = clientIpFromRequest(request);
  const rl = take(keyFromRequest("early-access", request), LIMIT, WINDOW_MS);
  if (!rl.ok) {
    auditLog({
      event: "rate_limit.exceeded",
      outcome: "reject",
      ip,
      details: { ns: "early-access" },
    });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const parsed = earlyAccessSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "VALIDATION_ERROR", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { name, email, whatsapp, note, tier, utm } = parsed.data;
    const resolvedTier = tier?.trim() || "full-managed";
    // Keep only non-empty UTM keys; null the column when nothing was captured.
    const utmClean = utm
      ? Object.fromEntries(
          Object.entries(utm).filter(([, v]) => v && v.trim()),
        )
      : {};
    const utmValue = Object.keys(utmClean).length > 0 ? utmClean : null;

    const [lead] = await db
      .insert(schema.earlyAccessLeads)
      .values({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        whatsapp: whatsapp?.trim() || null,
        note: note?.trim() || null,
        tier: resolvedTier,
        utm: utmValue,
      })
      .returning({ id: schema.earlyAccessLeads.id });

    auditLog({
      event: "early_access.lead",
      outcome: "ok",
      ip,
      details: { leadId: lead.id, tier: resolvedTier },
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("[early-access] error:", error);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
