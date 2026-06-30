// Curated provider list for the onboarding BYOK step (step 5).
//
// A small, friendly subset of the full provider universe, ordered by how good a
// FIRST choice it is for a mass-market layperson (cheapest + easiest first). Each
// entry's `envKey` is the engine env-var name, used end-to-end:
//   - the live container writes it via providers.setEnv (and stage-key, legacy)
//   - provider-validate.ts verifies the key
//   - apply-to-container.ts maps it to the default model
// `defaultModel` becomes the forged agent's model (answers.modelDefault).
//
// Logos live at /images/providers/<logoSlug>.webp (96px webp, same assets the
// live /app/providers tab uses). Step-by-step "how to get a key" copy is pulled
// from tutorialForKey(envKey) in provider-tutorials.ts.
//
// IMPORTANT (2026-06-14): Gemini is NO LONGER a free/recommended path — its free
// tier is rate-capped and needs a billing account for real use. Recommendation
// now goes to the genuinely free + easiest options (Groq, Cerebras, OpenRouter).
// Keep `envKey` in lock-step with PROVIDER_ENDPOINTS (provider-validate) and
// ENV_KEY_DEFAULT_MODEL (apply-to-container).

export type ByokTier = "free" | "cheap" | "paid";

export interface ByokProvider {
  /** Stable UI id. */
  id: string;
  /** Engine env-var name — the canonical key used by setEnv/validate/apply. */
  envKey: string;
  /** Display name. */
  label: string;
  /** Short tagline (Bahasa) shown on the card. */
  tagline: string;
  /** Engine model slug the forged agent will default to. */
  defaultModel: string;
  /** Logo asset slug → /images/providers/<slug>.webp */
  logoSlug: string;
  /** Pricing tier — drives the badge + grouping. */
  tier: ByokTier;
  /** Highlight as THE recommended starting point. */
  recommended?: boolean;
  /** OAuth login available for this provider (drives the live OAuth flow). */
  oauth?: { id: string; label: string };
}

export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  {
    id: "groq",
    envKey: "GROQ_API_KEY",
    label: "Groq",
    tagline: "Tercepat & gratis — paling gampang buat mulai.",
    defaultModel: "groq/llama-3.3-70b-versatile",
    logoSlug: "groq",
    tier: "free",
    recommended: true,
  },
  {
    id: "cerebras",
    envKey: "CEREBRAS_API_KEY",
    label: "Cerebras",
    tagline: "Inference super ngebut, ada tier gratis.",
    defaultModel: "cerebras/llama-3.3-70b",
    logoSlug: "cerebras",
    tier: "free",
  },
  {
    id: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    tagline: "Satu kunci, ratusan model — ada yang gratis.",
    defaultModel: "openrouter/auto",
    logoSlug: "openrouter",
    tier: "free",
  },
  {
    id: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    tagline: "Murah banget, jago coding & reasoning.",
    defaultModel: "deepseek/deepseek-chat",
    logoSlug: "deepseek",
    tier: "cheap",
  },
  {
    id: "mistral",
    envKey: "MISTRAL_API_KEY",
    label: "Mistral",
    tagline: "Model Eropa, efisien & terjangkau.",
    defaultModel: "mistral/mistral-large-latest",
    logoSlug: "mistral",
    tier: "cheap",
  },
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    label: "Google Gemini",
    tagline: "Model Google — perlu akun billing, tapi Flash-nya terjangkau.",
    defaultModel: "google/gemini-2.5-flash",
    logoSlug: "gemini",
    tier: "paid",
  },
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    label: "OpenAI",
    tagline: "GPT — serbaguna & populer (berbayar).",
    defaultModel: "openai/gpt-5.1",
    logoSlug: "openai",
    tier: "paid",
  },
  {
    id: "xai",
    envKey: "XAI_API_KEY",
    label: "xAI Grok",
    tagline: "Model dari xAI, update terus (berbayar).",
    defaultModel: "xai/grok-4-fast",
    logoSlug: "xai",
    tier: "paid",
    oauth: { id: "xai-oauth", label: "Login lewat X" },
  },
  {
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    label: "Anthropic Claude",
    tagline: "Jago nulis panjang & analisa rapi (premium).",
    defaultModel: "anthropic/claude-haiku-4-5",
    logoSlug: "anthropic",
    tier: "paid",
    oauth: { id: "claude-code", label: "Login Claude Pro/Max" },
  },
] as const;

const BY_ENV_KEY = new Map<string, ByokProvider>(
  BYOK_PROVIDERS.map((p) => [p.envKey, p]),
);

export function getByokProvider(envKey: string): ByokProvider | null {
  return BY_ENV_KEY.get(envKey) ?? null;
}

// Tier groups for the card UI — laypeople-friendly ordering (free → cheap → paid).
export const BYOK_TIERS: readonly { id: ByokTier; providers: readonly ByokProvider[] }[] = [
  { id: "free", providers: BYOK_PROVIDERS.filter((p) => p.tier === "free") },
  { id: "cheap", providers: BYOK_PROVIDERS.filter((p) => p.tier === "cheap") },
  { id: "paid", providers: BYOK_PROVIDERS.filter((p) => p.tier === "paid") },
];
