// Portal-side BYOK key liveness check — runs BEFORE the container exists.
//
// Distinct from the engine's `providers.testKey` RPC (which needs a running
// container). At onboarding the key is entered + validated in step 5, before
// any container is provisioned, so we verify it ourselves with a direct, fixed,
// server-to-server call to the provider's model-list endpoint.
//
// This is the Chief-mandated #1 activation-cliff mitigation: a typo'd / revoked
// key fails fast while `onboarded` is still false, so the user never lands in
// /app with a dead agent and a burned trial day.
//
// SECURITY
// - URLs are a FIXED allowlist (no user-supplied host) → not SSRF-reachable.
// - The key only travels to the provider's own endpoint; it is NEVER logged.
// - Policy = DEFINITIVE-REJECT-ONLY: we only return ok:false on an unambiguous
//   auth rejection (401/403, or a 400 whose body marks the key invalid). Any
//   ambiguous outcome (timeout, network error, 404, 5xx, unknown provider) is
//   treated as "could not verify" → ok:true, verified:false. This guarantees we
//   never FALSE-BLOCK a legitimate key because of a transient error or a wrong
//   URL on our side; the worst case degrades to today's format-only behaviour.

type AuthStyle = "bearer" | "query" | "x-api-key";

interface ProviderEndpoint {
  url: string;
  auth: AuthStyle;
  extraHeaders?: Record<string, string>;
}

// Curated to the providers onboarding actually offers. Mostly OpenAI-compatible
// `/v1/models` with Bearer auth; per-provider overrides where they differ.
const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoint> = {
  GEMINI_API_KEY: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query" },
  GOOGLE_API_KEY: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query" },
  OPENAI_API_KEY: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  ANTHROPIC_API_KEY: {
    url: "https://api.anthropic.com/v1/models",
    auth: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  DEEPSEEK_API_KEY: { url: "https://api.deepseek.com/models", auth: "bearer" },
  XAI_API_KEY: { url: "https://api.x.ai/v1/models", auth: "bearer" },
  GROQ_API_KEY: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  MISTRAL_API_KEY: { url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  OPENROUTER_API_KEY: { url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
  CEREBRAS_API_KEY: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
};

// Substrings in a 400 body that mark the KEY itself as invalid (vs a malformed
// request, which we must NOT treat as a rejection — that would be our bug
// false-blocking the user).
const INVALID_KEY_MARKERS = [
  "api_key_invalid",
  "api key not valid",
  "invalid api key",
  "invalid_api_key",
  "incorrect api key",
  "invalid x-api-key",
  "authentication_error",
  "unauthorized",
];

const TIMEOUT_MS = 8_000;

export interface KeyValidation {
  /** false ONLY on a definitive auth rejection. Ambiguous → true. */
  ok: boolean;
  /** true only when we actually confirmed the key against the provider. */
  verified: boolean;
  /** Number of models the key can see, when the provider returns a list. */
  modelCount?: number;
  /** Machine reason: "valid" | "invalid_key" | "unsupported" | "unverifiable". */
  reason: string;
}

function buildRequest(
  ep: ProviderEndpoint,
  key: string,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(ep.extraHeaders ?? {}),
  };
  if (ep.auth === "bearer") {
    headers.authorization = `Bearer ${key}`;
    return { url: ep.url, headers };
  }
  if (ep.auth === "x-api-key") {
    headers["x-api-key"] = key;
    return { url: ep.url, headers };
  }
  // query: provider requires the key as a URL query param (Gemini contract).
  return { url: `${ep.url}?key=${encodeURIComponent(key)}`, headers };
}

function countModels(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data.length; // OpenAI-style
  if (Array.isArray(obj.models)) return obj.models.length; // Gemini-style
  return undefined;
}

/**
 * Verify a BYOK key against its provider. `envKey` is the engine env-var name
 * (e.g. GEMINI_API_KEY) — the same value stored as apiKeys.providerId.
 */
export async function validateProviderKey(
  envKey: string,
  key: string,
): Promise<KeyValidation> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, verified: false, reason: "invalid_key" };

  const ep = PROVIDER_ENDPOINTS[envKey];
  if (!ep) {
    // Provider we can't network-verify — accept (format-only), never block.
    return { ok: true, verified: false, reason: "unsupported" };
  }

  const { url, headers } = buildRequest(ep, trimmed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });

    if (res.ok) {
      let modelCount: number | undefined;
      try {
        modelCount = countModels(await res.json());
      } catch {
        modelCount = undefined;
      }
      return { ok: true, verified: true, modelCount, reason: "valid" };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, verified: true, reason: "invalid_key" };
    }

    if (res.status === 400) {
      // Disambiguate: invalid KEY (reject) vs malformed request (don't block).
      let bodyText = "";
      try {
        bodyText = (await res.text()).toLowerCase();
      } catch {
        bodyText = "";
      }
      const looksLikeBadKey = INVALID_KEY_MARKERS.some((m) => bodyText.includes(m));
      return looksLikeBadKey
        ? { ok: false, verified: true, reason: "invalid_key" }
        : { ok: true, verified: false, reason: "unverifiable" };
    }

    // 404 / 429 / 5xx / anything else — can't conclude. Don't block.
    return { ok: true, verified: false, reason: "unverifiable" };
  } catch {
    // Network error / timeout / abort — never block on our own failure.
    return { ok: true, verified: false, reason: "unverifiable" };
  } finally {
    clearTimeout(timer);
  }
}

/** True if onboarding offers a network-verifiable endpoint for this env key. */
export function isVerifiableProvider(envKey: string): boolean {
  return envKey in PROVIDER_ENDPOINTS;
}
