// Per-tier engine defaults (admin-panel D6). Resolves the model / timezone /
// lean-engine / auto-update an admin set for a subscription tier, layered over
// the env-backed hermesConfig defaults. Consumed by provisionContainer
// (docker.ts) to seed the container env — so an admin can change a tier's
// default engine without a redeploy, and an unset key behaves exactly as today.
//
// NO `import "server-only"`: this is reached from docker.ts in the plain-Node
// custom-server worker chain (same constraint as settings.ts).
//
// seedDefaultKey (the BYOK key-broadcast gate) is INTENTIONALLY NOT here — it is
// Chief's safety control, env-only, not an admin product knob.
import { resolveSetting } from "@/lib/admin/settings";
import { hermesConfig } from "@/lib/hermes/config";

export interface EngineDefaults {
  model: string;
  timezone: string;
  leanEngine: boolean;
  autoUpdate: boolean;
}

export const ENGINE_DEFAULT_KEYS = {
  model: "defaults.engine.model",
  timezone: "defaults.engine.timezone",
  leanEngine: "defaults.engine.leanEngine",
  autoUpdate: "defaults.engine.autoUpdate",
} as const;

/**
 * Resolve the engine defaults for a tier. timezone is GLOBAL only (a per-user
 * value from onboarding still overrides it in resolveUserTimezone); the rest are
 * per-tier with a global/env fallback. Never throws — a DB hiccup falls back to
 * the env-backed config so provisioning can't break.
 */
export async function resolveEngineDefaults(
  tier: string | null,
): Promise<EngineDefaults> {
  const fallback: EngineDefaults = {
    model: hermesConfig.defaultModel,
    timezone: hermesConfig.timezone,
    leanEngine: hermesConfig.leanEngine,
    autoUpdate: hermesConfig.autoUpdate,
  };
  try {
    const scope = { tier };
    const [model, timezone, leanEngine, autoUpdate] = await Promise.all([
      resolveSetting(ENGINE_DEFAULT_KEYS.model, fallback.model, scope),
      resolveSetting(ENGINE_DEFAULT_KEYS.timezone, fallback.timezone, {}),
      resolveSetting(ENGINE_DEFAULT_KEYS.leanEngine, fallback.leanEngine, scope),
      resolveSetting(ENGINE_DEFAULT_KEYS.autoUpdate, fallback.autoUpdate, scope),
    ]);
    return { model, timezone, leanEngine, autoUpdate };
  } catch (e) {
    console.error(
      "[engine-defaults] resolution failed; using config defaults:",
      e,
    );
    return fallback;
  }
}
