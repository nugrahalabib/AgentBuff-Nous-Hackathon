// NOTE: no `import "server-only"`. resolveSetting is consumed by docker.ts
// (provisionContainer reads per-tier caps), which is loaded by the plain-Node
// tsx custom-server worker chain (server.ts -> billing workers -> docker.ts).
// The server-only shim only resolves under Next's bundler, so importing it here
// would crash that chain at boot (same constraint as track.ts / rollup-worker).
// This module is server-side by construction — it imports the postgres-backed db.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

type Scope = { tier?: string | null; userId?: string | null };

const cache = new Map<string, { value: unknown; exp: number }>();
const TTL_MS = 30_000;

/**
 * Resolve a runtime setting (admin-panel foundation F5). DB precedence:
 * admin_setting(user) > (tier) > (global) > `fallback`. ENV-pinned keys are
 * resolved by the caller (ENV wins, then this) — this owns the DB layers only.
 * Cached 30s; call invalidateSettingCache() after an admin write.
 */
export async function resolveSetting<T>(
  key: string,
  fallback: T,
  scope: Scope = {},
): Promise<T> {
  const ck = `${key}|${scope.userId ?? ""}|${scope.tier ?? ""}`;
  const hit = cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.value as T;

  const rows = await db
    .select({
      scope: schema.adminSettings.scope,
      scopeId: schema.adminSettings.scopeId,
      value: schema.adminSettings.value,
    })
    .from(schema.adminSettings)
    .where(eq(schema.adminSettings.key, key));

  const pick = (s: string, id: string): unknown =>
    rows.find((r) => r.scope === s && r.scopeId === id)?.value;

  let value: unknown;
  if (scope.userId != null) value = pick("user", scope.userId);
  if (value === undefined && scope.tier != null) value = pick("tier", scope.tier);
  if (value === undefined) value = pick("global", "");

  const resolved = value === undefined ? fallback : (value as T);
  cache.set(ck, { value: resolved, exp: Date.now() + TTL_MS });
  return resolved;
}

/** Drop the in-memory cache (call after an admin writes a setting). */
export function invalidateSettingCache(): void {
  cache.clear();
}
