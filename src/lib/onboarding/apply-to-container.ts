import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, userAgents } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import {
  withHermesBridge,
  GatewayTransportError,
} from "@/lib/hermes/gateway-client";
import { auditLog } from "@/lib/security/audit-log";
import { pickModelForProvider } from "@/lib/models/pick-default-model";

// Apply the user's onboarding choices INTO their freshly provisioned container:
//   1. push staged BYOK keys into the container .env (providers.setEnv)
//   2. set the engine default model (config.patch)
//   3. dress the default agent ("Buff") as the forged archetype — name, emoji,
//      and SOUL persona (agents.update + agents.files.set)
//
// Design notes
// ------------
// - We configure the DEFAULT agent rather than create a new one. The default
//   agent is what /app chats with and what channels route to; the bridge's
//   _seed_default_agent_name + _maybe_seed_soul both RESPECT customization
//   (they only reseed an empty/engine-default name/SOUL), so our custom name +
//   persona survive every container reboot. One personal Buff, no orphan.
// - This is the resilient counterpart to billing/skill-installer's
//   reinstallSkillsForUser: it runs fire-and-forget AFTER provision and is the
//   single re-hydration primitive — on a container rebuild the same call
//   re-applies the persisted user_agent spec, so the user never loses their Buff.
// - The bridge goes health-GREEN before its RPC layer can serve calls (engine
//   boot scans skills). So every attempt is retry-tolerant: transport errors
//   back off and retry; the agent spec is already persisted in Postgres, so a
//   failure here is recoverable by a later re-hydrate.

const DEFAULT_AGENT_ID = "default";

// Fallback engine model per BYOK env key, used ONLY when the onboarding UI
// didn't capture an explicit model choice (user_agent.modelPrimary). Gemini is
// the recommended/known-good path; the rest are best-effort and overridable in
// the providers/settings tab. A wrong slug is non-fatal — it surfaces on first
// chat and the user can switch models.
export const ENV_KEY_DEFAULT_MODEL: Record<string, string> = {
  GEMINI_API_KEY: "google/gemini-2.5-flash",
  GOOGLE_API_KEY: "google/gemini-2.5-flash",
  OPENAI_API_KEY: "openai/gpt-5.1",
  ANTHROPIC_API_KEY: "anthropic/claude-haiku-4-5",
  OPENROUTER_API_KEY: "openrouter/auto",
  DEEPSEEK_API_KEY: "deepseek/deepseek-chat",
  XAI_API_KEY: "xai/grok-4-fast",
  GROQ_API_KEY: "groq/llama-3.3-70b-versatile",
  MISTRAL_API_KEY: "mistral/mistral-large-latest",
  CEREBRAS_API_KEY: "cerebras/llama-3.3-70b",
  // HACKATHON managed brain — NVIDIA NIM / Nemotron.
  NVIDIA_API_KEY: "nvidia/nemotron-3-super-120b-a12b",
};

// Retry schedule for the post-provision boot race. Total budget ~46s, well
// inside the time a user spends on the "Aktivasi" climax screen.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 12_000, 20_000] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ApplyConn {
  port: number;
  bridgeToken: string;
}

interface AgentSpec {
  name: string;
  emoji: string | null;
  description: string | null;
  soulContent: string | null;
  modelPrimary: string | null;
  modelProvider: string | null;
}

export type ApplyOutcome =
  | { kind: "applied"; userId: string; keysApplied: number }
  | { kind: "no-spec"; userId: string }
  | { kind: "failed"; userId: string; error: string };

/**
 * Fire-and-forget from the complete-onboarding route. Resolves when the
 * container has been dressed (or after exhausting retries). Never throws — the
 * caller does not await success; recovery is owned by a future re-hydrate.
 */
export async function applyOnboardingToContainer(
  userId: string,
  conn: ApplyConn,
): Promise<ApplyOutcome> {
  // The agent spec is the authoritative source (persisted by the complete
  // route). Without it there's nothing to dress.
  // Read the spec keyed exactly as the complete route WRITES it
  // (userId + engineAgentId="default"). user_agent has no unique(userId) and
  // the multi-agent roadmap adds more rows, so the filter + recency tiebreak
  // stop us dressing the engine default with the wrong agent's persona.
  const [spec] = await db
    .select({
      name: userAgents.name,
      emoji: userAgents.emoji,
      description: userAgents.description,
      soulContent: userAgents.soulContent,
      modelPrimary: userAgents.modelPrimary,
      modelProvider: userAgents.modelProvider,
    })
    .from(userAgents)
    .where(
      and(eq(userAgents.userId, userId), eq(userAgents.engineAgentId, "default")),
    )
    .orderBy(desc(userAgents.updatedAt))
    .limit(1);

  if (!spec) {
    return { kind: "no-spec", userId };
  }

  // BYOK keys to push. providerId column holds the engine env-var name
  // (e.g. GEMINI_API_KEY). We read both 'staged' (first onboarding) AND
  // 'connected' (rebuild/rehydrate — keys were already promoted once) so this
  // doubles as the re-hydration primitive. Decrypt in-memory only; never log.
  const keysToApply = await db
    .select({
      id: apiKeys.id,
      providerId: apiKeys.providerId,
      keyEncrypted: apiKeys.keyEncrypted,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        inArray(apiKeys.status, ["staged", "connected"]),
      ),
    );

  const resolvedModel = resolveModel(
    spec,
    keysToApply.map((k) => k.providerId),
  );

  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await withHermesBridge(
        {
          port: conn.port,
          bridgeToken: conn.bridgeToken,
          callerTag: "agentbuff-onboarding-apply",
          connectTimeoutMs: 10_000,
          defaultCallTimeoutMs: 20_000,
        },
        async (client) => {
          // Order matters: every DISK write first, the one restart-causing call
          // (providers.setEnv) LAST. config.patch (no restart flag), agents.update
          // (sidecar) and agents.files.set (SOUL.md) only touch files; setEnv
          // triggers an engine restart that then re-reads config.yaml + sidecar +
          // SOUL.md + .env in a single pass. Doing it first would restart the
          // engine mid-sequence and make the dressing calls race a booting RPC.

          // 1. Engine default model. Prefer the user's explicit/BYOK choice;
          //    otherwise DERIVE it from the provider(s) actually registered in
          //    THIS container. models.list returns models ONLY for usable
          //    providers (a NOUS login surfaces its claude/gpt/gemini), so the
          //    default can never be a model the user's provider doesn't serve.
          //    Prefer a fast/cheap tier so the first chat is snappy; fall back
          //    to the first available; if nothing is available yet (engine
          //    warm-up) leave the engine's own seeded default untouched.
          // The model NAME and its PROVIDER must be set TOGETHER, as the BARE
          // engine names models.list uses. The container seeds
          // model.provider="gemini" (operator default), so a missing/partial
          // provider patch leaves a non-gemini model mis-routed to gemini (no key)
          // → chat 404s. We resolve the provider from models.list (authoritative:
          // ONLY the user's CONNECTED provider has models there) for ANY provider —
          // gemini-key, deepseek, codex-OAuth, NOUS, etc. The persisted onboarding
          // hint + a warm-up retry are backstops so we NEVER leave the gemini seed.
          const bareName = (s: string): string =>
            s.includes("/") ? s.split("/").slice(1).join("/") : s;
          // Provider the onboarding UI captured ("gemini" / "deepseek" /
          // "oauth:openai-codex" → "openai-codex"). Last-resort fallback only.
          const providerHint =
            spec.modelProvider?.replace(/^oauth:/, "").trim() || null;
          // resolveModel / ENV_KEY_DEFAULT_MODEL return slash-prefixed slugs
          // ("openai/gpt-5.1"); the engine + models.list use bare names.
          let effectiveModel: string | null = resolvedModel ? bareName(resolvedModel) : null;
          let effectiveProvider: string | null = null;
          let modelsUsable = false;
          try {
            const ml = (await client.call("models.list", {})) as {
              providers?: Array<{ slug?: string; models?: string[] }>;
            };
            // Only providers that actually serve models = the user's connected one(s).
            const provs = (ml.providers ?? []).filter((p) => (p.models ?? []).length > 0);
            modelsUsable = provs.length > 0;
            // The `nous` portal is the user's actual gateway — prefer it.
            const ordered = [
              ...provs.filter((p) => p.slug === "nous"),
              ...provs.filter((p) => p.slug !== "nous"),
            ];
            if (effectiveModel) {
              // Explicit / env-default model — find which CONNECTED provider serves
              // it (BARE match). If it's NOT in that provider's CURRENT model list
              // (a stale hardcoded slug, e.g. our old "deepseek-chat" vs the
              // engine's "deepseek-v4-flash"), DROP it and derive a valid current
              // model below — never push a slug the engine can't serve (→ 404).
              const want = effectiveModel;
              const owner = ordered.find((p) => (p.models ?? []).some((m) => m === want));
              if (owner) {
                effectiveProvider = owner.slug ?? null;
              } else {
                effectiveModel = null;
              }
            }
            if (!effectiveModel) {
              // Derive a default from the connected provider(s). The per-provider
              // rule (NOUS free-tier ":free" preference; fast/cheap otherwise)
              // lives in ONE shared place — @/lib/models/pick-default-model — so
              // the agent-create wizard and this onboarding path can never
              // disagree again (Chief 2026-06-16).
              for (const p of ordered) {
                const m = pickModelForProvider(p.slug ?? "", p.models ?? []);
                if (m) {
                  effectiveModel = m;
                  effectiveProvider = p.slug ?? null;
                  break;
                }
              }
            }
          } catch {
            // models.list unavailable (warm-up) — handled by the retry guard below.
          }
          // Never leave the provider unset (= keep the seed's gemini) when the
          // onboarding answers captured one.
          if (effectiveModel && !effectiveProvider && providerHint) {
            effectiveProvider = providerHint;
          }
          // Warm-up race: a provider WAS connected (onboarding verified it) but
          // models.list is still empty AND we couldn't resolve a model. Throw so
          // the outer retry loop (~46s) re-attempts once models are discoverable,
          // instead of silently leaving the gemini seed for an OAuth user.
          if (!effectiveModel && !modelsUsable) {
            throw new GatewayTransportError(
              "models.list empty during engine warm-up — retry to set model+provider",
            );
          }
          if (effectiveModel) {
            const modelPatch: Record<string, unknown> = { default: effectiveModel };
            // Pin the provider to the one that actually serves the model so chat
            // never routes to the seed's gemini default (which has no key).
            if (effectiveProvider) modelPatch.provider = effectiveProvider;
            const patch: Record<string, unknown> = { model: modelPatch };
            // TTS follows the connected provider too — NEVER a hard gemini default
            // (Chief: "jangan apa apa semua gemini"). Only pin a provider the engine
            // can synthesize with (gemini / openai); anything else falls back to the
            // engine default rather than erroring on gemini-with-no-key.
            const prov = (effectiveProvider ?? "").toLowerCase();
            const ttsProvider = /gemini|google/.test(prov)
              ? "gemini"
              : /openai/.test(prov)
                ? "openai"
                : null;
            if (ttsProvider) patch.tts = { provider: ttsProvider };
            await client.call("config.patch", { patch });
          }

          // 2. Dress the default agent: name + emoji + description ("Peran &
          //    Deskripsi"). The bridge sidecar stores `description` only when
          //    it is present in the patch (agents_handler _extract_sidecar_payload),
          //    so without this the Agent tab reads back an empty/fallback role.
          //    description_auto=false marks it as an explicit (non-generated)
          //    value, matching the manual-edit semantics the UI uses.
          const identity: Record<string, unknown> = { name: spec.name };
          if (spec.emoji) identity.emoji = spec.emoji;
          identity.theme = "cyan";
          const agentPatch: Record<string, unknown> = {
            name: spec.name,
            identity,
          };
          if (spec.description && spec.description.trim()) {
            agentPatch.description = spec.description.trim();
            agentPatch.description_auto = false;
          }
          await client.call("agents.update", {
            agentId: DEFAULT_AGENT_ID,
            patch: agentPatch,
          });

          // 3. Write the forged persona as the default agent's SOUL.
          if (spec.soulContent && spec.soulContent.trim()) {
            await client.call("agents.files.set", {
              agentId: DEFAULT_AGENT_ID,
              filename: "SOUL.md",
              content: spec.soulContent,
            });
          }

          // 4. BYOK keys → container .env (restart-causing — done last).
          let applied = 0;
          for (const k of keysToApply) {
            const plaintext = decrypt(k.keyEncrypted);
            await client.call("providers.setEnv", {
              key: k.providerId,
              value: plaintext,
            });
            applied++;
          }

          // 5. Read back the env catalog to CONFIRM the keys actually landed —
          //    providers.setEnv can return ok without the .env write persisting
          //    (restart race). We only promote keys the engine confirms isSet, so
          //    a silent failure leaves the key 'staged' and the /app recovery
          //    re-fires it instead of recording a false success.
          let confirmed: string[] = keysToApply.map((k) => k.providerId);
          try {
            const catalog = await client.call<{
              vars?: Array<{ key?: string; isSet?: boolean }>;
            }>("providers.envCatalog");
            const setKeys = new Set(
              (catalog?.vars ?? []).filter((v) => v.isSet).map((v) => v.key),
            );
            confirmed = keysToApply
              .map((k) => k.providerId)
              .filter((p) => setKeys.has(p));
          } catch {
            // Catalog read failed — stay optimistic (don't strand the user); the
            // rehydrate-on-rebuild path re-pushes anyway.
          }

          return { applied, confirmed };
        },
      );

      // Promote ONLY confirmed keys staged → connected. Unconfirmed keys stay
      // 'staged' so app/layout's recovery re-runs apply for them.
      const confirmedSet = new Set(result.confirmed);
      const promoteIds = keysToApply
        .filter((k) => confirmedSet.has(k.providerId))
        .map((k) => k.id);
      if (promoteIds.length > 0) {
        await db
          .update(apiKeys)
          .set({ status: "connected", updatedAt: new Date() })
          .where(and(eq(apiKeys.userId, userId), inArray(apiKeys.id, promoteIds)));
      }

      auditLog({
        event: "onboarding.completed",
        outcome: "ok",
        actor: userId,
        details: {
          phase: "apply",
          keysApplied: result.applied,
          keysConfirmed: result.confirmed.length,
          attempt,
        },
      });

      return { kind: "applied", userId, keysApplied: result.applied };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const transient =
        err instanceof GatewayTransportError ||
        /timed out|not open|closed|ECONNREFUSED|connect/i.test(lastError);
      const hasMoreAttempts = attempt < RETRY_DELAYS_MS.length;
      if (transient && hasMoreAttempts) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }

  auditLog({
    event: "onboarding.completed",
    outcome: "error",
    actor: userId,
    details: { phase: "apply", errorKind: "rpc" },
  });
  return { kind: "failed", userId, error: lastError };
}

function resolveModel(
  spec: AgentSpec,
  stagedEnvKeys: readonly string[],
): string | null {
  const explicit = spec.modelPrimary?.trim();
  if (explicit) return explicit;
  for (const envKey of stagedEnvKeys) {
    const fallback = ENV_KEY_DEFAULT_MODEL[envKey];
    if (fallback) return fallback;
  }
  return null;
}
