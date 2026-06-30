// Single source of truth for "which model should an agent default to", given
// the providers a container actually has keys for. Used by BOTH the onboarding
// apply-to-container path AND the in-app agent-create wizard so the two can
// never disagree again — Chief got bitten twice by divergent defaults (NOUS
// auto-picking a PAID model: nvidia/* in onboarding, anthropic/claude in the
// wizard, instead of the free tier).

const FAST = /flash|haiku|lite|fast|nano|mini(?![a-z])/i;

export interface ProviderModels {
  slug: string;
  models: string[];
}

/**
 * Per-provider default-model rule.
 * - NOUS resells many vendors, but a free subscription only runs the FREE tier:
 *   models carrying a ":free" suffix (e.g. "stepfun/step-3.7-flash:free"). The
 *   non-free slugs ("anthropic/claude-opus-4.8", "nvidia/nemotron-3-super-120b-a12b")
 *   are tier-gated and 404 on first chat ("kalau yang lain ga bisa"). So prefer
 *   ":free": the Chief's known-good "step-3.7-flash:free" first, then any fast
 *   ":free", then any ":free" at all.
 * - Everyone else gets a fast/cheap tier model (snappy first chat), else the
 *   provider's first model.
 */
export function pickModelForProvider(
  slug: string,
  models: string[],
): string | null {
  const list = models ?? [];
  if (slug === "nous") {
    const free = list.filter((m) => /:free$/i.test(m));
    const pick =
      free.find((m) => /step-3\.7-flash:free$/i.test(m)) ??
      free.find((m) => FAST.test(m)) ??
      free[0];
    if (pick) return pick;
  }
  return list.find((m) => FAST.test(m)) ?? list[0] ?? null;
}

/**
 * Pick the best default { slug, model } across the user's connected providers.
 * The NOUS portal is the user's gateway when present, so it's preferred first.
 * Returns null when no provider has any usable model yet (engine warm-up).
 */
export function pickDefaultModel(
  providers: ProviderModels[],
): { slug: string; model: string } | null {
  const usable = (providers ?? []).filter((p) => (p.models ?? []).length > 0);
  const ordered = [
    ...usable.filter((p) => p.slug === "nous"),
    ...usable.filter((p) => p.slug !== "nous"),
  ];
  for (const p of ordered) {
    const m = pickModelForProvider(p.slug, p.models ?? []);
    if (m) return { slug: p.slug, model: m };
  }
  return null;
}
