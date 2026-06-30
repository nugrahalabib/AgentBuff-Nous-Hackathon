// Commission resolution (C3 Phase B). The platform cut % for a marketplace
// sale, plus the gross→commission/net split. Precedence (per schema.ts comment):
//   first_party seller -> 0
//   seller.commissionPct (explicit override)
//   commission_rule scope='seller'   scopeId=seller.id
//   commission_rule scope='category' scopeId=listing.category
//   commission_rule scope='global'   scopeId=''
//   default 20%
//
// NO `import "server-only"`: called from settle.ts which runs in the plain-Node
// worker chain (reconcile-worker). Accepts an executor so it can read inside the
// settlement db.transaction (consistent snapshot).
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const DEFAULT_COMMISSION_PCT = 20;

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COMMISSION_PCT;
  return Math.min(100, Math.max(0, Math.trunc(n)));
}

export async function resolveCommissionPct(
  seller: { id: string; type: string; commissionPct: number | null },
  listing: { category: string | null },
  exec: Executor = db,
): Promise<number> {
  // First-party listings are platform-owned — no commission taken.
  if (seller.type === "first_party") return 0;
  // Explicit per-seller override wins.
  if (seller.commissionPct != null) return clampPct(seller.commissionPct);

  const rules = await exec
    .select({
      scope: schema.commissionRules.scope,
      scopeId: schema.commissionRules.scopeId,
      pct: schema.commissionRules.pct,
    })
    .from(schema.commissionRules);

  const find = (scope: string, scopeId: string): number | undefined =>
    rules.find((r) => r.scope === scope && r.scopeId === scopeId)?.pct;

  const resolved =
    find("seller", seller.id) ??
    (listing.category ? find("category", listing.category) : undefined) ??
    find("global", "") ??
    DEFAULT_COMMISSION_PCT;
  return clampPct(resolved);
}

/** Split a gross amount into platform commission + seller net. Commission floors
 *  (platform rounds down), so the seller never loses a rupiah to rounding. */
export function computeSplit(
  grossRp: number,
  pct: number,
): { commissionRp: number; netRp: number } {
  const p = clampPct(pct);
  const commissionRp = Math.floor((grossRp * p) / 100);
  return { commissionRp, netRp: grossRp - commissionRp };
}

/** ISO-week bucket "YYYY-Www" for grouping payouts into periods. */
export function isoWeekPeriod(d: Date): string {
  // Copy; shift to nearest Thursday (ISO week is defined by its Thursday).
  // ALL-UTC: use UTC getters here too (not local) so the period bucket is
  // deterministic regardless of the server's OS timezone — a row settled near a
  // week boundary must land in the same ISO week on a UTC or UTC+7 host.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
