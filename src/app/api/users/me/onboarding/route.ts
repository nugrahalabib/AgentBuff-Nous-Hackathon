import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { userProfiles, apiKeys } from "@/lib/db/schema";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";

// Resumable onboarding progress.
//   GET    → { step, answers, onboarded }   (resume from last step)
//   PATCH  → save a step's answers + advance the cursor (non-terminal)
//   DELETE → restart from scratch (clear answers + cursor + any staged key)
//
// Completion (provision container + create agent + start trial + onboarded=true)
// is a SEPARATE gated action — it is NOT this endpoint. This route never sets
// `onboarded`; it only persists in-progress draft state so a user who drops off
// can resume, and writes the canonical profile columns as they go.

// Per-field length caps — stops oversized payloads + the silent varchar
// truncation the audit flagged. Unknown keys are stripped by zod (object
// default), so the jsonb answers blob can't be stuffed with junk.
const answersSchema = z.object({
  fullName: z.string().max(120).optional(),
  nickname: z.string().max(60).optional(),
  displayName: z.string().max(120).optional(),
  dob: z.string().max(10).optional(), // "YYYY-MM-DD"
  timezone: z.string().max(40).optional(), // IANA
  city: z.string().max(80).optional(),
  country: z.string().max(80).optional(),
  role: z.string().max(40).optional(),
  industryIds: z.string().max(200).optional(),
  interestIds: z.string().max(200).optional(),
  focus: z.string().max(40).optional(),
  businessName: z.string().max(120).optional(),
  jurusan: z.string().max(80).optional(),
  teamSize: z.string().max(20).optional(),
  referralSource: z.string().max(40).optional(),
  whatsapp: z.string().max(40).optional(),
  // ── Agent-spec answers (step 4 "Atur Buff" + step 5 BYOK). These have NO
  // canonical profile column — they live only in the onboardingAnswers jsonb
  // and are consumed at completion to forge the agent + build the SOUL.md. ──
  archetype: z.string().max(40).optional(), // auto-derived, but persisted
  agentName: z.string().max(60).optional(),
  agentEmoji: z.string().max(16).optional(),
  tone: z.string().max(24).optional(), // persona-options TONES id
  userTitles: z.string().max(120).optional(), // CSV of panggilan ids / custom
  personality: z.string().max(200).optional(), // CSV of trait ids
  language: z.string().max(8).optional(),
  emojiUsage: z.string().max(12).optional(),
  responseStyle: z.string().max(12).optional(),
  modelProvider: z.string().max(30).optional(),
  modelDefault: z.string().max(60).optional(),
});

const patchSchema = z.object({
  step: z.number().int().min(0).max(6),
  answers: answersSchema.default({}),
});

// Generous for a real person stepping through a wizard (saves per step + edits);
// chokes a script hammering the profile-write path.
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 5 * 60_000;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const [row] = await db
    .select({
      step: userProfiles.onboardingStep,
      answers: userProfiles.onboardingAnswers,
      onboarded: userProfiles.onboarded,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, session.user.id))
    .limit(1);

  return Response.json({
    step: row?.step ?? 0,
    answers: row?.answers ?? {},
    onboarded: row?.onboarded ?? false,
  });
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  const ip = clientIpFromRequest(request);

  const rl = take(keyFromRequest("onboarding", request), WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!rl.ok) {
    auditLog({ event: "rate_limit.exceeded", outcome: "reject", ip, details: { ns: "onboarding" } });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "BAD_JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "VALIDATION_ERROR", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { step, answers: a } = parsed.data;

  // Merge into the existing draft so prior steps' answers survive.
  const [existing] = await db
    .select({ answers: userProfiles.onboardingAnswers })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const mergedAnswers = { ...(existing?.answers ?? {}), ...a };

  // Mirror the known answer fields into their canonical profile columns.
  const mapped = {
    ...(a.nickname !== undefined
      ? { nickname: a.nickname, displayName: a.displayName ?? a.nickname }
      : a.displayName !== undefined
        ? { displayName: a.displayName }
        : {}),
    ...(a.dob !== undefined ? { dob: a.dob } : {}),
    ...(a.timezone !== undefined ? { timezone: a.timezone } : {}),
    ...(a.city !== undefined ? { city: a.city } : {}),
    ...(a.country !== undefined ? { country: a.country } : {}),
    ...(a.role !== undefined ? { role: a.role } : {}),
    ...(a.industryIds !== undefined ? { industryIds: a.industryIds } : {}),
    ...(a.interestIds !== undefined ? { interestIds: a.interestIds } : {}),
    ...(a.focus !== undefined ? { focus: a.focus } : {}),
    ...(a.businessName !== undefined ? { businessName: a.businessName } : {}),
    ...(a.jurusan !== undefined ? { jurusan: a.jurusan } : {}),
    ...(a.teamSize !== undefined ? { teamSize: a.teamSize } : {}),
    ...(a.referralSource !== undefined ? { referralSource: a.referralSource } : {}),
    ...(a.whatsapp !== undefined ? { whatsapp: a.whatsapp } : {}),
  };

  const set = {
    onboardingStep: step,
    onboardingAnswers: mergedAnswers,
    updatedAt: new Date(),
    ...mapped,
  };

  await db
    .insert(userProfiles)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: userProfiles.userId, set });

  return Response.json({ ok: true, step, answers: mergedAnswers });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  const ip = clientIpFromRequest(request);

  const rl = take(keyFromRequest("onboarding", request), WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!rl.ok) {
    auditLog({ event: "rate_limit.exceeded", outcome: "reject", ip, details: { ns: "onboarding" } });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  // Reset the draft cursor + answers. Canonical columns are left as-is (they
  // get overwritten as the user re-enters), but the staged BYOK key is wiped —
  // a stale encrypted credential must not linger after a restart.
  await db
    .update(userProfiles)
    .set({ onboardingStep: 0, onboardingAnswers: null, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));

  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.status, "staged")));

  auditLog({ event: "onboarding.restart", outcome: "ok", ip, actor: userId });

  return Response.json({ ok: true, step: 0 });
}
