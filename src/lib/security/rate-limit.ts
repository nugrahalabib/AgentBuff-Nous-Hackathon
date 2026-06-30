// Lightweight in-memory rate limiter. Single-process MVP — good enough while
// the portal runs on one Node server. Swap to Redis / Upstash if we ever scale
// horizontally.
//
// Design:
//   - Keyed by caller identity (IP, userId, or composite like "webhook:<ip>").
//   - Sliding window: windowMs holds the most recent hit timestamps; anything
//     older is evicted on access. Not fixed-window, so no cliff at the boundary.
//   - Auto-cleanup via a single interval; no per-request sweep that would leak
//     work into hot paths.
//
// `take()` returns `{ ok, remaining, resetAt }`. `ok=false` means the caller
// blew past the budget — respond 429.

type Bucket = {
  hits: number[];
};

const buckets = new Map<string, Bucket>();

// One janitor for all limiters. Runs every minute, drops any bucket that has
// no hits inside its window. `unref()` keeps it from pinning the event loop.
const JANITOR_INTERVAL_MS = 60_000;
const MAX_BUCKET_AGE_MS = 15 * 60_000;

const janitor = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    const latest = bucket.hits[bucket.hits.length - 1];
    if (latest === undefined || now - latest > MAX_BUCKET_AGE_MS) {
      buckets.delete(key);
    }
  }
}, JANITOR_INTERVAL_MS);
if (typeof janitor.unref === "function") janitor.unref();

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

export function take(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const windowStart = now - windowMs;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  // Evict hits outside the window. Hits are append-only so we can find the
  // cutoff via a single scan from the head.
  let evict = 0;
  while (evict < bucket.hits.length && bucket.hits[evict] <= windowStart) evict++;
  if (evict > 0) bucket.hits.splice(0, evict);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return {
      ok: false,
      remaining: 0,
      resetAt: oldest + windowMs,
    };
  }

  bucket.hits.push(now);
  return {
    ok: true,
    remaining: Math.max(0, limit - bucket.hits.length),
    resetAt: now + windowMs,
  };
}

// Convenience helper for API routes: composes the bucket key with a namespace.
// IP comes from `x-real-ip`, which server.ts stamps from the real TCP socket
// (or a trusted reverse proxy sets when TRUST_PROXY=true) — NOT client
// spoofable. We deliberately do NOT read the client-controlled
// x-forwarded-for, which would let an attacker rotate fake IPs to defeat the
// limit. Authenticated callers should pass userId for a spoof-proof key.
export function keyFromRequest(ns: string, req: Request, userId?: string | null): string {
  const ip = req.headers.get("x-real-ip")?.trim() || "unknown";
  return userId ? `${ns}:u:${userId}` : `${ns}:ip:${ip}`;
}
