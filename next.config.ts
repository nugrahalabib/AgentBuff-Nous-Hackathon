import type { NextConfig } from "next";

// Security headers applied to every route. Notes:
//
// - CSP: we run our own script (no third-party script hosts), pull QRIS
//   images and avatars from known origins, and connect to ourselves. Inline
//   scripts/styles are allowed because Next 16 injects a hydration shim; a
//   strict nonce-based policy is a separate future project.
// - `frame-ancestors 'none'` — nothing may iframe the portal. Billing uses
//   a popup window, so iframing isn't needed.
// - HSTS only in production — local dev runs on http://localhost:617.
const isProd = process.env.NODE_ENV === "production";

const CSP = [
  "default-src 'self'",
  // `'unsafe-eval'` is dev-only — Turbopack's fast-refresh needs it, but a
  // production build never does, so we drop it in prod to remove an XSS
  // escalation path. `'unsafe-inline'` still required by Next's hydration
  // shim; the nonce-based replacement is the Phase-9 pre-deploy task.
  // Midtrans Snap (snap.js) loads from app.*.midtrans.com — the only external
  // script host we permit. It powers the all-methods embedded checkout.
  `script-src 'self' 'unsafe-inline' https://app.sandbox.midtrans.com https://app.midtrans.com${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  // data:/blob: for inline QR fallbacks and Next image optimization.
  // Midtrans returns QRIS PNGs from api.*.midtrans.com + api.sandbox.midtrans.com.
  // Google OAuth avatars served from lh3.googleusercontent.com.
  // `http://127.0.0.1:*` lets the browser fetch user-uploaded VN/image
  // thumbnails + bot-generated MEDIA: files from the bridge container's
  // published media-serve port (loopback only — bridge publishes on
  // `${args.port + bridgeHealthPortOffset}` per
  // `src/lib/hermes/docker.ts::runContainer`). Without it the
  // PORTAL_ATTACHMENT_URLS sentinel URLs would be CSP-blocked.
  "img-src 'self' data: blob: http://127.0.0.1:* https://*.midtrans.com https://lh3.googleusercontent.com",
  // `blob:` allows MediaRecorder voice-note playback (composer 🎵 button)
  // and any future audio/video preview from local Blobs. `data:` covers
  // future data-URL inline audio. WITHOUT this directive, browsers fall
  // back to default-src and reject blob: with the Chromium error message
  // "Media load rejected by URL safety check" (observed 2026-05-23 when
  // chief tested VN recording — root cause of MediaError SRC_NOT_SUPPORTED).
  // `http://127.0.0.1:*` covers the bridge media-serve port (same as
  // img-src above) — needed for `<audio>` + `<video>` + `<a download>`
  // off the token URL after page refresh.
  "media-src 'self' data: blob: http://127.0.0.1:*",
  "font-src 'self' data:",
  // API fetches + WebSocket proxy to the portal origin itself. The loopback
  // media-serve origin is allowed too (same as img-src/media-src) so a future
  // liveness probe / blob download of a /media URL isn't CSP-blocked.
  // Plain `ws:` is dev-only (localhost:617 over http); production speaks
  // `wss:` exclusively, so we don't advertise an insecure WS scheme there.
  `connect-src 'self' ${isProd ? "wss:" : "ws: wss:"} http://127.0.0.1:* https://*.midtrans.com`,
  // Midtrans Snap redirect falls through frame-src when merchants use it.
  "frame-src 'self' https://*.midtrans.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // Midtrans notification-url callbacks POST to our /api/billing/webhook.
  // form-action covers <form action=...> submits; we don't use those, but
  // keep 'self' so future legal forms don't break.
  "form-action 'self'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // DENY rather than SAMEORIGIN — we never iframe ourselves.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // `=(self)` grants the AgentBuff origin permission to use the API
    // (still requires user consent via the browser's lock-icon prompt).
    // `=()` means NOBODY can use it — including the site itself, which
    // breaks Web Speech API SpeechRecognition (composer mic button) and
    // any future getUserMedia flows even AFTER the user clicks Allow in
    // the address bar. Trade-off: `=(self)` is slightly more permissive
    // than `=()`, but since we ASK for these features in the composer,
    // the empty allowlist was a hard-blocking misconfiguration.
    //
    // `interest-cohort=()` stays empty — we never want FLoC tracking.
    // `geolocation=()` stays empty until we ship a location feature.
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Next 16 blocks cross-origin dev-asset requests by default (see
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/
  // 01-next-config-js/allowedDevOrigins.md). `server.ts` passes
  // `hostname: "localhost"` to `next({...})`, so visiting the app via
  // `127.0.0.1:617` is cross-origin for Turbopack → HMR disconnects →
  // hydration never lands → render looks glitchy / flickers.
  // Whitelisting 127.0.0.1 here lets both `localhost:617` and
  // `127.0.0.1:617` share the dev server cleanly. No production effect
  // (this setting only applies in `next dev`).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    return [
      {
        // Apply to everything; per-route overrides can be added later if a
        // specific page needs a looser policy (unlikely for billing).
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
