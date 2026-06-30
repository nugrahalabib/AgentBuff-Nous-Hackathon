// Shared origin allowlist for the billing popup → parent postMessage bridge.
//
// The popup is opened by its OPENER, which passes its own origin as a
// `?parent=<url>` query param; the popup validates that origin before using
// it as the postMessage targetOrigin. This prevents a malicious page from
// tricking the popup into posting payment info to an arbitrary origin.
//
// Two legitimate openers:
//   1. The PORTAL (/app — trial overlay, Item Shop, topbar pill, quick-actions)
//      at the deployed domain (NEXT_PUBLIC_APP_ORIGIN, e.g. https://agentbuff.id)
//      or the dev server on :617. THIS is the common path now.
//   2. LEGACY: the raw Hermes dashboard inside the user's container at
//      http://127.0.0.1:<loopback-port> (operator path via /loby) — kept for
//      back-compat.
//
// Matching stays EXACT-origin (scheme+host+port, no path/query) — no wildcard.

// Mirrors HERMES_PORT_MIN..HERMES_PORT_MAX (defaults 18800..19299) — the billing
// page is client-side and can't import server config.
const PORT_MIN = 18_800;
const PORT_MAX = 19_299;

// The portal origins /app opens the popup from. NEXT_PUBLIC_* is inlined into
// the client bundle at build time. The :617 fallbacks cover local dev (the
// custom Node server, CLAUDE.md). In prod, set NEXT_PUBLIC_APP_ORIGIN.
function portalOrigins(): Set<string> {
  const set = new Set<string>(["http://localhost:617", "http://127.0.0.1:617"]);
  const env = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (env) {
    try {
      set.add(new URL(env).origin);
    } catch {
      /* malformed env — ignore */
    }
  }
  return set;
}

export function validateParentOrigin(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // 1. Portal origin (exact match) — the primary path.
  if (portalOrigins().has(url.origin)) return url.origin;

  // 2. Legacy loopback container dashboard (http, 127.0.0.1/localhost, in pool).
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port) || port < PORT_MIN || port > PORT_MAX) return null;
  return url.origin;
}
