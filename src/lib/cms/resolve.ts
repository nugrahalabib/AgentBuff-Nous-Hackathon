// Server-side CMS overlay resolver (D8). Reads published cms_content `value`
// per locale into a flat { "dot.path": value } map that I18nProvider merges over
// the hardcoded i18n dictionary. An absent key = fallback to the dict.
//
// NO `import "server-only"`: same constraint as admin/settings.ts — this module
// is server-side by construction (imports the postgres-backed db) and the
// server-only shim only resolves under Next's bundler.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { Locale } from "@/lib/i18n/context";

const cache = new Map<string, { value: Record<string, unknown>; exp: number }>();
const TTL_MS = 30_000;

/**
 * Published CMS overrides for one locale: { "hero.titleLine1": "...", ... }.
 * preview=true returns draft ?? value (caller must admin-gate it) and is never
 * cached, so an admin sees their unpublished edit immediately.
 */
export async function resolveCmsOverrides(
  locale: Locale,
  preview = false,
): Promise<Record<string, unknown>> {
  const ck = `cms|${locale}`;
  if (!preview) {
    const hit = cache.get(ck);
    if (hit && hit.exp > Date.now()) return hit.value;
  }

  const rows = await db
    .select({
      key: schema.cmsContent.key,
      value: schema.cmsContent.value,
      draft: schema.cmsContent.draft,
    })
    .from(schema.cmsContent)
    .where(eq(schema.cmsContent.locale, locale));

  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const v = preview ? (r.draft ?? r.value) : r.value;
    if (v != null) out[r.key] = v;
  }

  if (!preview) cache.set(ck, { value: out, exp: Date.now() + TTL_MS });
  return out;
}

/** Drop the in-memory cache (call after an admin publish/edit). Process-local;
 *  acceptable on single-VPS — worst case a 30s stale window on other ticks. */
export function invalidateCmsCache(): void {
  cache.clear();
}
