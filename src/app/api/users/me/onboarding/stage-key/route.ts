import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { encrypt, maskKey } from "@/lib/crypto";
import { validateProviderKey } from "@/lib/onboarding/provider-validate";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";

// Stage the user's BYOK provider API key DURING onboarding, before their
// container exists. The key is AES-256-GCM encrypted at rest (same crypto as
// the providers tab) and parked with status='staged'. At onboarding completion
// the provision flow reads it, pushes it into the container via
// providers.setEnv (key=providerId, the env-var name), then flips status ->
// 'connected'. A restart (DELETE /onboarding) wipes it.
//
// NOTE: this stages + format-checks only. Live validation (a portal-side call
// to the provider's /models before provisioning, to kill dead-on-arrival
// agents) slots in here once the provider endpoint catalog is wired.

// providerId carries the engine env-var name the key maps to (e.g.
// GEMINI_API_KEY) — the same key the providers tab + provider-tutorials.ts use.
// At completion apply-to-container.ts pushes it verbatim via providers.setEnv.
// CONSTRAINED to the provider-key form `*_API_KEY` so a user can't inject an
// arbitrary engine env var (HERMES_*, PATH, HOME, ...) into their container .env
// — every real provider key ends in _API_KEY, engine internals don't.
const stageSchema = z.object({
  providerId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, "invalid provider key"),
  key: z.string().min(8).max(400),
});

// Cap distinct staged keys so the complete-route re-validation fan-out is bounded.
const MAX_STAGED_KEYS = 5;

const LIMIT = 20;
const WINDOW_MS = 10 * 60_000;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  const ip = clientIpFromRequest(request);

  const rl = take(keyFromRequest("onboarding-stage-key", request), LIMIT, WINDOW_MS);
  if (!rl.ok) {
    auditLog({
      event: "rate_limit.exceeded",
      outcome: "reject",
      ip,
      details: { ns: "onboarding-stage-key" },
    });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "BAD_JSON" }, { status: 400 });
  }
  const parsed = stageSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "VALIDATION_ERROR", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { providerId } = parsed.data;
  const key = parsed.data.key.trim();
  if (key.length < 8) {
    return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  }

  // Liveness check BEFORE we store anything — a typo'd/revoked key is rejected
  // here so it never reaches the staging table or (later) a provisioned
  // container. Definitive-reject-only: ambiguous/unverifiable keys pass through.
  const validation = await validateProviderKey(providerId, key);
  if (!validation.ok) {
    auditLog({
      event: "onboarding.key_staged",
      outcome: "reject",
      ip,
      actor: userId,
      details: { providerId, reason: validation.reason },
    });
    return Response.json(
      { error: "INVALID_KEY", reason: validation.reason },
      { status: 422 },
    );
  }

  // Bound distinct staged providers (re-staging the same provider is fine).
  const stagedNow = await db
    .select({ providerId: apiKeys.providerId })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.status, "staged")));
  const distinctOthers = new Set(
    stagedNow.map((r) => r.providerId).filter((p) => p !== providerId),
  ).size;
  if (distinctOthers >= MAX_STAGED_KEYS) {
    return Response.json({ error: "TOO_MANY_KEYS" }, { status: 429 });
  }

  const keyEncrypted = encrypt(key);
  const keyMasked = maskKey(key);

  // Replace any prior STAGED key for this provider (idempotent re-staging).
  // Leaves already-'connected' keys untouched.
  await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.providerId, providerId),
        eq(apiKeys.status, "staged"),
      ),
    );
  await db.insert(apiKeys).values({
    userId,
    providerId,
    keyEncrypted,
    keyMasked,
    status: "staged",
  });

  auditLog({
    event: "onboarding.key_staged",
    outcome: "ok",
    ip,
    actor: userId,
    details: { providerId },
  });

  return Response.json({
    ok: true,
    masked: keyMasked,
    verified: validation.verified,
    modelCount: validation.modelCount,
  });
}
