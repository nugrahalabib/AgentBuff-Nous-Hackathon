import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { userProfiles, userAgents, userTrials, users, trialGrants } from "@/lib/db/schema";
import { hashEmail } from "@/lib/crypto";
import { provisionContainer } from "@/lib/hermes/docker";
import { getArchetype, deriveArchetype, buildSoul } from "@/lib/onboarding/archetypes";
import {
  applyOnboardingToContainer,
  ENV_KEY_DEFAULT_MODEL,
} from "@/lib/onboarding/apply-to-container";
import {
  withHermesBridge,
  GatewayTransportError,
} from "@/lib/hermes/gateway-client";
import { take, keyFromRequest } from "@/lib/security/rate-limit";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { trackEvent } from "@/lib/analytics/track";
import { resolveSetting } from "@/lib/admin/settings";

// Terminal onboarding action — the "Aktivasi" climax. Unlike PATCH /onboarding
// (which only saves draft progress), THIS is the gated, side-effectful step:
//   1. server-side re-verify the required fields (never trust the client step)
//   2. provision the user's container (idempotent; awaits health)
//   3. start the 14-day trial + persist the forged agent spec + flip onboarded
//      (one DB transaction — all-or-nothing)
//   4. fire-and-forget apply BYOK keys + dress the default agent into the
//      container (resilient to the post-provision boot race)
//
// Provision must SUCCEED before we mark onboarded — a failed container leaves
// the user on Aktivasi to retry, never half-onboarded.

// Fallback trial length; the operator can override per-deploy via admin_setting
// (key limit.trial.durationDays). Resolved per-request inside POST so a change
// applies to trials created after it; existing trial rows keep their endsAt.
const TRIAL_DAYS = 14;

// Defensive parse of the persisted onboardingAnswers jsonb — it's our own data,
// but we still validate the fields we depend on here.
const answersSchema = z.object({
  nickname: z.string().max(60).optional(),
  city: z.string().max(80).optional(),
  focus: z.string().max(40).optional(),
  interestIds: z.string().max(200).optional(), // CSV of goal ids
  industryIds: z.string().max(200).optional(), // CSV of industry ids
  role: z.string().max(40).optional(),
  jurusan: z.string().max(80).optional(),
  businessName: z.string().max(120).optional(),
  archetype: z.string().max(40).optional(), // auto-derived fallback below
  agentName: z.string().max(60).optional(),
  agentEmoji: z.string().max(16).optional(),
  tone: z.string().max(24).optional(),
  userTitles: z.string().max(120).optional(), // CSV of panggilan ids / custom
  personality: z.string().max(200).optional(), // CSV of trait ids
  language: z.string().max(8).optional(),
  emojiUsage: z.string().max(12).optional(),
  responseStyle: z.string().max(12).optional(),
  modelProvider: z.string().max(30).optional(),
  modelDefault: z.string().max(60).optional(),
});

/** Split a persisted CSV jsonb field into a trimmed id list. */
function csv(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const LIMIT = 10;
const WINDOW_MS = 10 * 60_000;

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  const ip = clientIpFromRequest(request);

  const rl = take(keyFromRequest("onboarding-complete", request), LIMIT, WINDOW_MS);
  if (!rl.ok) {
    auditLog({ event: "rate_limit.exceeded", outcome: "reject", ip, details: { ns: "onboarding-complete" } });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  // 1. Load profile + re-verify required fields server-side.
  const [profile] = await db
    .select({
      onboarded: userProfiles.onboarded,
      answers: userProfiles.onboardingAnswers,
      nickname: userProfiles.nickname,
      role: userProfiles.role,
      city: userProfiles.city,
      businessName: userProfiles.businessName,
      focus: userProfiles.focus,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  // Idempotency: already onboarded → no-op success.
  if (profile?.onboarded) {
    return Response.json({ ok: true, redirect: "/app", alreadyOnboarded: true });
  }

  const parsedAnswers = answersSchema.safeParse(profile?.answers ?? {});
  const a = parsedAnswers.success ? parsedAnswers.data : {};

  const nickname = firstNonEmpty(profile?.nickname, a.nickname);
  // Specialization is auto-derived from goals + role (Step 4 no longer asks the
  // user to pick). Honor a persisted explicit archetype if present; otherwise
  // derive. Always resolves to a valid archetype, so it never gates completion.
  const goals = csv(a.interestIds);
  const archetype =
    getArchetype(a.archetype) ??
    deriveArchetype({ goals, role: firstNonEmpty(a.role, profile?.role) });

  const missing: string[] = [];
  if (!nickname) missing.push("nickname");
  if (missing.length > 0) {
    return Response.json({ error: "INCOMPLETE", missing }, { status: 400 });
  }
  // archetype is always resolved (derived above); only nickname needs narrowing.
  const safeArchetype = archetype;
  const safeNickname = nickname!;

  // 2. Provision the container (idempotent — it was already started in the
  //    background during step 4, so this returns fast). On failure we leave
  //    onboarded=false so the user can retry Aktivasi.
  let conn;
  try {
    conn = await provisionContainer(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    auditLog({
      event: "onboarding.completed",
      outcome: "error",
      actor: userId,
      ip,
      details: { phase: "provision" },
    });
    return Response.json(
      { error: "PROVISION_FAILED", message: message.slice(0, 200) },
      { status: 503 },
    );
  }

  // 2b. BYOK gate — in the live flow the user connected their provider DIRECTLY
  //     into this container during step 5 (no Postgres staging — the key never
  //     touches the portal DB). Authoritatively verify the container actually
  //     has a provider key or OAuth login before flipping onboarded; never trust
  //     the client. The bridge call is loopback-only to the user's OWN container
  //     (resolved from their session), so no other user/attacker can reach it. A
  //     transient bridge error during engine warm-up degrades to "retry".
  let providerCheck: { ok: boolean; envKey: string | null } = {
    ok: false,
    envKey: null,
  };
  try {
    providerCheck = await withHermesBridge(
      {
        port: conn.port,
        bridgeToken: conn.bridgeToken,
        callerTag: "agentbuff-onboarding-verify",
        connectTimeoutMs: 10_000,
        defaultCallTimeoutMs: 15_000,
      },
      async (client) => {
        // Retry-tolerant: the user's last setEnv restarts the engine, so a fresh
        // envCatalog can transiently report isSet:false during warm-up. Poll a
        // few times before concluding "no provider" (mirrors apply-to-container's
        // read-back), so a real key is never false-rejected.
        for (let attempt = 0; attempt < 5; attempt++) {
          const env = (await client.call("providers.envCatalog", {})) as {
            vars?: { key?: string; canonical?: string; isSet?: boolean }[];
          };
          // Authoritatively confirm a set key actually WORKS (probe the provider
          // via testKey), not merely that it's present. Definitive-reject-only:
          // a transient warm-up "error" still passes; only a confirmed "invalid"
          // is skipped — so a real key is never false-rejected.
          for (const v of (env.vars ?? []).filter((x) => x.isSet)) {
            if (!v.key) continue;
            const t = (await client
              .call("providers.testKey", { key: v.key })
              .catch(() => ({ status: "error" }))) as { status?: string };
            if (t.status !== "invalid") {
              return { ok: true, envKey: v.canonical ?? v.key ?? null };
            }
          }
          const oauth = (await client
            .call("providers.oauthList", {})
            .catch(() => ({ providers: [] }))) as {
            providers?: { status?: { loggedIn?: boolean } }[];
          };
          if ((oauth.providers ?? []).some((p) => p.status?.loggedIn)) {
            return { ok: true, envKey: null };
          }
          if (attempt < 4) await new Promise((r) => setTimeout(r, 1500));
        }
        return { ok: false, envKey: null };
      },
    );
  } catch (err) {
    auditLog({
      event: "onboarding.completed",
      outcome: "error",
      actor: userId,
      ip,
      details: { phase: "verify-provider" },
    });
    const message =
      err instanceof GatewayTransportError ? "bridge_warming_up" : "verify_failed";
    return Response.json({ error: "PROVISION_FAILED", message }, { status: 503 });
  }
  // BYOK is skippable: if the user connected NO provider, we still complete
  // onboarding (onboarded=true) and apply no model override (providerCheck.envKey
  // stays null). In production BYOK the container boots without a usable brain, so
  // the /app needsBrain gate disables chat until the user adds one. (In dev a
  // seeded default GEMINI key means chat works after skip — the gate is honest
  // about "can it chat right now", not "did the user connect this session".)

  // 3. Build the forged agent spec.
  const tone = a.tone ?? "santai";
  // Reject the two reserved names: the bridge's _seed_default_agent_name only
  // leaves a default-agent name alone when it is NOT empty/"default"/"Buff", and
  // reseeds "Buff" otherwise. So a user who names their Buff exactly "default" or
  // "Buff" would have it silently clobbered on the next container reboot. Coerce
  // those to the archetype's default name so the customization survives.
  const rawAgentName = firstNonEmpty(a.agentName);
  const agentName =
    rawAgentName && !/^(default|buff)$/i.test(rawAgentName)
      ? rawAgentName
      : safeArchetype.defaultName;
  const agentEmoji = firstNonEmpty(a.agentEmoji) ?? safeArchetype.emoji;
  const role = firstNonEmpty(a.role, profile?.role);
  const businessName = firstNonEmpty(a.businessName, profile?.businessName);
  const city = firstNonEmpty(a.city, profile?.city);
  const focus = firstNonEmpty(a.focus, profile?.focus);
  // Model: prefer the client's choice; otherwise map the live-connected env key
  // to its default model (the live flow has no Postgres apiKeys row for
  // apply-to-container to resolve from, so derive it here).
  const modelPrimary =
    firstNonEmpty(a.modelDefault) ??
    (providerCheck.envKey
      ? ENV_KEY_DEFAULT_MODEL[providerCheck.envKey] ?? null
      : null);
  const modelProvider = firstNonEmpty(a.modelProvider);

  const soulContent = buildSoul(safeArchetype.id, {
    agentName,
    nickname: safeNickname,
    userTitles: csv(a.userTitles),
    tone,
    personality: csv(a.personality),
    language: a.language ?? "id",
    emojiUsage: a.emojiUsage ?? "some",
    responseStyle: a.responseStyle ?? "balanced",
    role,
    jurusan: firstNonEmpty(a.jurusan),
    businessName,
    city,
    industryIds: csv(a.industryIds),
    goals: goals.length > 0 ? goals : focus ? [focus] : [],
  });

  const now = new Date();
  const trialDays = await resolveSetting(
    "limit.trial.durationDays",
    TRIAL_DAYS,
    {},
  );
  const trialEnds = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

  // Email (hashed) keys the one-time-trial ledger. Hashing survives account
  // deletion and never stores the address in plaintext.
  const [acct] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const emailHash = acct?.email ? hashEmail(acct.email) : null;

  // 4. Atomic DB commit: trial + agent spec + onboarded flip.
  // Hoisted out of the txn so the funnel emit below can gate on whether the
  // trial actually activated (a re-registrant gets an EXPIRED grant → no
  // trial_active activation event).
  let trialGranted = false;
  await db.transaction(async (tx) => {
    // One-time trial per EMAIL (anti-farming). The trial_grants ledger survives
    // account deletion, so a deleted-then-re-registered email gets an EXPIRED
    // trial (→ paywall immediately), never a fresh 14 days. A SAME-user
    // re-complete keeps an active trial (its row still exists), so idempotent
    // retries by a legit first-timer are unaffected.
    const [existingTrial] = await tx
      .select({ status: userTrials.status })
      .from(userTrials)
      .where(eq(userTrials.userId, userId))
      .limit(1);
    const [priorGrant] = emailHash
      ? await tx
          .select({ emailHash: trialGrants.emailHash })
          .from(trialGrants)
          .where(eq(trialGrants.emailHash, emailHash))
          .limit(1)
      : [undefined];
    // Re-registrant = this email already consumed a trial (ledger has it) AND
    // this account does NOT currently hold an ACTIVE trial of its own. A legit
    // first-timer re-completing keeps their active trial (existingTrial.status
    // === "active"); a deleted+re-registered email (no trial row, or only an
    // already-expired one) gets an EXPIRED trial → paywall immediately.
    const trialUsedBefore =
      Boolean(priorGrant) && existingTrial?.status !== "active";
    const grantStatus = trialUsedBefore ? "expired" : "active";
    trialGranted = grantStatus === "active";
    const grantEndsAt = trialUsedBefore ? now : trialEnds;

    await tx
      .insert(userTrials)
      .values({ userId, startedAt: now, endsAt: grantEndsAt, status: grantStatus })
      .onConflictDoUpdate({
        target: userTrials.userId,
        set: { startedAt: now, endsAt: grantEndsAt, status: grantStatus },
      });

    // Record the one-time grant the FIRST time this email ever gets a trial.
    // onConflictDoNothing makes concurrent completes race-safe.
    if (emailHash && !priorGrant) {
      await tx.insert(trialGrants).values({ emailHash }).onConflictDoNothing();
    }

    // Agent spec — keyed by engineAgentId="default" (the configured default
    // agent). user_agent has no unique(userId), so select-then-write.
    const [existingAgent] = await tx
      .select({ id: userAgents.id })
      .from(userAgents)
      .where(
        and(eq(userAgents.userId, userId), eq(userAgents.engineAgentId, "default")),
      )
      .limit(1);

    const agentValues = {
      name: agentName,
      role: role ?? undefined,
      icon: agentEmoji,
      archetype: safeArchetype.id,
      emoji: agentEmoji,
      tone,
      // "Peran & Deskripsi" describes what the AGENT is — its goal-derived
      // specialization — NOT who the USER is. The archetype is derived from the
      // user's step-3 goals (+ role) via deriveArchetype, so its `specialization`
      // ("asisten produktivitas & manajemen pribadi", "spesialis konten &
      // pertumbuhan media sosial", …) is exactly the short role phrase this field
      // wants. The old code dumped the raw `role` enum slug (e.g. "pemilik_usaha")
      // here, which is both a leaked id AND the wrong subject. apply-to-container
      // pushes this to the engine sidecar so it actually renders + drives routing.
      description:
        safeArchetype.specialization.charAt(0).toUpperCase() +
        safeArchetype.specialization.slice(1),
      soulContent,
      engineAgentId: "default",
      modelPrimary: modelPrimary ?? undefined,
      modelProvider: modelProvider ?? undefined,
      status: "active" as const,
      source: "official" as const,
      updatedAt: now,
    };

    if (existingAgent) {
      await tx
        .update(userAgents)
        .set(agentValues)
        .where(eq(userAgents.id, existingAgent.id));
    } else {
      await tx.insert(userAgents).values({ userId, ...agentValues });
    }

    // Flip onboarded — the terminal cursor.
    await tx
      .update(userProfiles)
      .set({ onboarded: true, onboardingStep: 6, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  });

  auditLog({
    event: "onboarding.completed",
    outcome: "ok",
    actor: userId,
    ip,
    details: { phase: "commit", archetype: safeArchetype.id, trialDays },
  });
  // Funnel analytics (F2, self-host) — fire-and-forget, fail-safe.
  trackEvent("onboard_complete", {
    userId,
    props: { archetype: safeArchetype.id },
  });
  // trial_active = the activation event the BYOK funnel depends on. Only fires
  // when a fresh trial actually activated (re-registrants get an EXPIRED grant
  // and are NOT counted as activated).
  if (trialGranted) {
    trackEvent("trial_active", { userId, props: { trialDays } });
  }

  // 5. Dress the container (BYOK keys + agent persona) BEFORE handing the user
  //    to /app, so they never land on an un-dressed default agent ("Buff" /
  //    empty SOUL). apply is retry-tolerant of the post-provision boot race +
  //    idempotent; we AWAIT it (the Aktivasi "waking up" state covers the wait)
  //    but never FAIL onboarding on a dressing error — the spec is persisted, so
  //    a re-hydrate / re-provision is the backstop for the rare total failure.
  try {
    await applyOnboardingToContainer(userId, {
      port: conn.port,
      bridgeToken: conn.bridgeToken,
    });
  } catch (e) {
    console.error(`[onboarding] apply failed for user=${userId}:`, e);
  }

  return Response.json({ ok: true, redirect: "/app" });
}
