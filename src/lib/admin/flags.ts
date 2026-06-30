// Feature/dev flag resolver (admin-panel D13). Mirrors admin/settings.ts: DB
// precedence user > tier > global, 30s cache, invalidate after a write. An
// absent row = flag OFF (safe default) so a flag is inert until switched on.
//
// NO `import "server-only"`: same constraint as settings.ts — reachable from the
// plain-Node tsx worker chain; server-only only resolves under Next's bundler.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

type Scope = { tier?: string | null; userId?: string | null };
export type FlagResult = { enabled: boolean; value: unknown };

const OFF: FlagResult = { enabled: false, value: null };

const cache = new Map<string, { value: FlagResult; exp: number }>();
const TTL_MS = 30_000;

/** Resolve a flag's effective state (enabled + optional value). */
export async function resolveFlag(
  key: string,
  scope: Scope = {},
): Promise<FlagResult> {
  const ck = `${key}|${scope.userId ?? ""}|${scope.tier ?? ""}`;
  const hit = cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.value;

  const rows = await db
    .select({
      scope: schema.featureFlags.scope,
      scopeId: schema.featureFlags.scopeId,
      enabled: schema.featureFlags.enabled,
      value: schema.featureFlags.value,
    })
    .from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, key));

  const pick = (s: string, id: string) =>
    rows.find((r) => r.scope === s && r.scopeId === id);

  let row: (typeof rows)[number] | undefined;
  if (scope.userId != null) row = pick("user", scope.userId);
  if (!row && scope.tier != null) row = pick("tier", scope.tier);
  if (!row) row = pick("global", "");

  const result: FlagResult = row
    ? { enabled: row.enabled, value: row.value }
    : OFF;
  cache.set(ck, { value: result, exp: Date.now() + TTL_MS });
  return result;
}

/** Convenience: just the boolean (most callers only need on/off). */
export async function isFlagEnabled(
  key: string,
  scope: Scope = {},
): Promise<boolean> {
  return (await resolveFlag(key, scope)).enabled;
}

/** Drop the in-memory cache (call after an admin writes a flag). */
export function invalidateFlagCache(): void {
  cache.clear();
}

// ── Catalog of known flags (drives the admin editor + the write allowlist) ──
export interface FlagDef {
  key: string;
  label: string;
  description: string;
  /** This flag carries an optional jsonb value (e.g. a custom message). */
  hasValue?: boolean;
  valueLabel?: string;
}

export const FLAG_CATALOG: FlagDef[] = [
  {
    key: "maintenance.enabled",
    label: "Mode Maintenance",
    description:
      "Saat aktif, user non-staff lihat layar maintenance di /app. Admin & support tetap bisa masuk untuk perbaikan.",
    hasValue: true,
    valueLabel: "Pesan maintenance (opsional)",
  },
  {
    key: "signups.disabled",
    label: "Tutup pendaftaran",
    description:
      "Saat aktif, akun BARU tidak bisa dibuat (login Google user baru ditolak, diarahkan ke /login?error=SignupsClosed). User lama tetap bisa masuk. Dikonsumsi di auth signIn callback.",
  },
];

const FLAG_KEYS = new Set(FLAG_CATALOG.map((f) => f.key));
export function isKnownFlag(key: string): boolean {
  return FLAG_KEYS.has(key);
}
