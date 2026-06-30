/**
 * Error classification for the /app surface.
 *
 * All store-side errors flow through `mapError()` in `store.ts`, which stringifies
 * `GatewayError` as `"CODE: message"` and `Error` as `.message`. This helper
 * parses that string back into a typed classification + user-facing copy +
 * action hints so the UI can render the right CTAs (Energy Vault, Retry,
 * Re-login) without duplicating error-string matching in every component.
 *
 * See also:
 *  - `Docs/rpc-subset-contract.md` §9 for the canonical error code catalog.
 *  - `src/lib/hermes/ws-proxy.ts` for proxy-side ENERGY_EXHAUSTED + FORBIDDEN.
 *  - `src/lib/hermes/browser-gateway.ts::GatewayError` for the source shape.
 *
 * Brand note: NO user-visible string in this file may mention "engine",
 * "Hermes", "OpenClaw", "Nous", or any internal-only identifier. Per chief's
 * mandate the brand surface is exclusively "Buff" / "AgentBuff".
 */

import { openBillingPopup } from "./billing-popup";

// Locale for error copy — synced from the i18n provider (same idiom as
// tool-display's setToolDisplayLocale), since this module can't call hooks.
let errorsLocale: "id" | "en" = "id";
export function setErrorsLocale(locale: "id" | "en"): void {
  errorsLocale = locale === "en" ? "en" : "id";
}

// Bilingual copy table keyed by the same id/en locale. Every user-facing
// title/body lives here so classifyErrorMessage() picks the active locale.
type ErrCopy = {
  uploadTooLargeTitle: string;
  uploadTooLargeBodySuffix: string;
  uploadTooLargeBodyGeneric: string;
  uploadInvalidTitle: string;
  uploadInvalidBody: string;
  energyTitle: string;
  energyBody: string;
  unauthorizedTitle: string;
  unauthorizedBody: string;
  forbiddenTitle: string;
  forbiddenBody: string;
  invalidRequestTitle: string;
  invalidRequestBody: string;
  notFoundTitle: string;
  notFoundBody: string;
  rateLimitedTitle: string;
  rateLimitedBody: string;
  timeoutTitle: string;
  timeoutBody: string;
  gatewayDownTitle: string;
  gatewayDownBody: string;
  limitExceededTitle: string;
  limitExceededBody: string;
  buffBugTitle: string;
  buffBugBody: string;
  genericTitle: string;
  gatewayOffTitle: string;
  gatewayOffBody: string;
  networkTitle: string;
  networkBody: string;
  genericRetry: string;
};

const ERR_COPY: Record<"id" | "en", ErrCopy> = {
  id: {
    uploadTooLargeTitle: "File terlalu besar",
    uploadTooLargeBodySuffix: ". Coba kompres dulu atau pilih file lain.",
    uploadTooLargeBodyGeneric:
      "Ukuran file melebihi batas paket kamu. Coba kompres dulu atau pilih file lain.",
    uploadInvalidTitle: "Format gambar tidak didukung",
    uploadInvalidBody:
      "Hanya JPG, PNG, WEBP, atau GIF yang didukung. Coba export ulang atau pilih file lain.",
    energyTitle: "Energy kamu habis",
    energyBody: "Top up dulu biar AgentBuff bisa lanjut carry task kamu.",
    unauthorizedTitle: "Sesi login expired",
    unauthorizedBody: "Login ulang buat lanjut chat.",
    forbiddenTitle: "Aksi ditolak",
    forbiddenBody:
      "Metode ini diblok oleh portal. Kalau sering muncul, laporkan bug.",
    invalidRequestTitle: "Permintaan tidak valid",
    invalidRequestBody: "Permintaan ditolak server. Coba ulangi pesan kamu.",
    notFoundTitle: "Sesi tidak ditemukan",
    notFoundBody:
      "Thread ini sudah tidak ada di server. Buka thread lain atau buat baru.",
    rateLimitedTitle: "Terlalu cepat",
    rateLimitedBody: "Tunggu sebentar, terus coba kirim lagi.",
    timeoutTitle: "Respon lambat",
    timeoutBody: "Buff lagi mikir kelamaan. Coba kirim ulang.",
    gatewayDownTitle: "Buff lagi tidur",
    gatewayDownBody:
      "Buff lagi off sebentar. Tunggu reconnect otomatis atau reload halaman.",
    limitExceededTitle: "Batas paket tercapai",
    limitExceededBody:
      "Kamu sudah mencapai batas paket ini. Upgrade untuk menambah lagi.",
    buffBugTitle: "Buff ngebug",
    buffBugBody: "Buff lagi error. Coba ulangi atau reload halaman.",
    genericTitle: "Terjadi error",
    gatewayOffTitle: "Buff lagi off",
    gatewayOffBody:
      "Lagi reconnect otomatis. Coba kirim ulang setelah status hijau.",
    networkTitle: "Network error",
    networkBody: "Cek koneksi internet kamu, lalu coba kirim ulang.",
    genericRetry: "Coba ulangi lagi.",
  },
  en: {
    uploadTooLargeTitle: "File too large",
    uploadTooLargeBodySuffix: ". Compress it first or pick another file.",
    uploadTooLargeBodyGeneric:
      "The file exceeds your plan limit. Compress it first or pick another file.",
    uploadInvalidTitle: "Image format not supported",
    uploadInvalidBody:
      "Only JPG, PNG, WEBP, or GIF are supported. Re-export or pick another file.",
    energyTitle: "You're out of Energy",
    energyBody: "Top up first so AgentBuff can keep carrying your tasks.",
    unauthorizedTitle: "Login session expired",
    unauthorizedBody: "Log in again to keep chatting.",
    forbiddenTitle: "Action blocked",
    forbiddenBody:
      "This method is blocked by the portal. If it keeps happening, report a bug.",
    invalidRequestTitle: "Invalid request",
    invalidRequestBody: "The server rejected the request. Try sending again.",
    notFoundTitle: "Session not found",
    notFoundBody:
      "This thread no longer exists on the server. Open another thread or create a new one.",
    rateLimitedTitle: "Too fast",
    rateLimitedBody: "Wait a moment, then try sending again.",
    timeoutTitle: "Slow response",
    timeoutBody: "Buff is taking too long to think. Try sending again.",
    gatewayDownTitle: "Buff is sleeping",
    gatewayDownBody:
      "Buff is off for a moment. Wait for auto-reconnect or reload the page.",
    limitExceededTitle: "Plan limit reached",
    limitExceededBody:
      "You've reached this plan's limit. Upgrade to add more.",
    buffBugTitle: "Buff hit a bug",
    buffBugBody: "Buff ran into an error. Try again or reload the page.",
    genericTitle: "An error occurred",
    gatewayOffTitle: "Buff is off",
    gatewayOffBody:
      "Auto-reconnecting. Try sending again once the status turns green.",
    networkTitle: "Network error",
    networkBody: "Check your internet connection, then try sending again.",
    genericRetry: "Try again.",
  },
};

export type ErrorKind =
  | "energy_exhausted"
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "network"
  | "timeout"
  | "gateway_closed"
  | "upload_too_large"
  | "upload_invalid"
  | "limit_exceeded"
  | "unknown";

export type ErrorAction =
  /** Open the Energy Vault billing popup. */
  | { kind: "topup" }
  /** Open the upgrade / Item Shop popup (per-tier limit reached). */
  | { kind: "upgrade" }
  /** Redirect to /login (auth expired). */
  | { kind: "login" }
  /** Reload the page (usually after a proxy/upstream crash). */
  | { kind: "reload" }
  /** Dismiss inline — non-actionable information. */
  | { kind: "dismiss" };

export type ClassifiedError = {
  kind: ErrorKind;
  /** Short user-visible title in Bahasa Indonesia. */
  title: string;
  /** One-line explanation + next step. */
  body: string;
  /** Suggested action buttons, in display order (primary first). */
  actions: ErrorAction[];
  /** Whether we keep the inline ErrorBubble visible until user dismisses. */
  persistent: boolean;
};

/** Parse the leading "CODE: " prefix that `mapError()` produces for
 *  `GatewayError`. Returns `{ code, rest }` or null if no code prefix. */
function splitGatewayCode(raw: string): { code: string; rest: string } | null {
  // Match upper-snake-case leading token (matches ENERGY_EXHAUSTED, FORBIDDEN,
  // INVALID_REQUEST, NOT_FOUND, UNAUTHORIZED, UNAVAILABLE, etc). We're strict
  // about the shape to avoid swallowing a sentence that happens to start with
  // a capital.
  const match = /^([A-Z][A-Z0-9_]{2,})\s*:\s*(.*)$/.exec(raw.trim());
  if (!match) return null;
  return { code: match[1], rest: match[2] };
}

export function classifyErrorMessage(raw: string | null | undefined): ClassifiedError {
  const message = (raw ?? "").trim();
  const C = ERR_COPY[errorsLocale];

  // Attachment errors may come as either a raw string from the gateway
  // (e.g. "attachment foo.png: exceeds size limit (...)") OR wrapped inside
  // an `INVALID_REQUEST` code. Either way, a substring match on the canonical
  // gateway phrase routes us to the right classification first.
  const lowerAll = message.toLowerCase();
  if (
    lowerAll.includes("exceeds size limit") ||
    lowerAll.includes("melebihi batas") ||
    lowerAll.includes("too large to pass inline")
  ) {
    return {
      kind: "upload_too_large",
      // The bridge message already carries the exact per-tier MB limit; surface
      // it verbatim when present, else a generic line.
      title: C.uploadTooLargeTitle,
      body: message.includes("MB")
        ? `${message}${C.uploadTooLargeBodySuffix}`
        : C.uploadTooLargeBodyGeneric,
      actions: [{ kind: "dismiss" }],
      persistent: true,
    };
  }
  if (
    lowerAll.includes("invalid base64 content") ||
    lowerAll.includes("unable to detect image mime type") ||
    lowerAll.includes("only image/* supported") ||
    lowerAll.includes("format tidak didukung")
  ) {
    return {
      kind: "upload_invalid",
      title: C.uploadInvalidTitle,
      body: C.uploadInvalidBody,
      actions: [{ kind: "dismiss" }],
      persistent: true,
    };
  }

  const gateway = splitGatewayCode(message);
  if (gateway) {
    switch (gateway.code) {
      case "ENERGY_EXHAUSTED":
        return {
          kind: "energy_exhausted",
          title: C.energyTitle,
          body: C.energyBody,
          actions: [{ kind: "topup" }, { kind: "dismiss" }],
          persistent: true,
        };
      case "UNAUTHORIZED":
        return {
          kind: "unauthorized",
          title: C.unauthorizedTitle,
          body: C.unauthorizedBody,
          actions: [{ kind: "login" }],
          persistent: true,
        };
      case "FORBIDDEN":
        return {
          kind: "forbidden",
          title: C.forbiddenTitle,
          body: gateway.rest || C.forbiddenBody,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
      case "INVALID_REQUEST":
        return {
          kind: "invalid_request",
          title: C.invalidRequestTitle,
          body: gateway.rest || C.invalidRequestBody,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
      case "NOT_FOUND":
        return {
          kind: "not_found",
          title: C.notFoundTitle,
          body: gateway.rest || C.notFoundBody,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
      case "RATE_LIMITED":
      case "RATE_LIMIT":
        return {
          kind: "rate_limited",
          title: C.rateLimitedTitle,
          body: gateway.rest || C.rateLimitedBody,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
      case "TIMEOUT":
      case "UPSTREAM_TIMEOUT":
        return {
          kind: "timeout",
          title: C.timeoutTitle,
          body: gateway.rest || C.timeoutBody,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
      case "UNAVAILABLE":
      case "UPSTREAM_CLOSED":
      // Bridge ENGINE_DOWN code — backend subprocess crashed; bridge
      // will auto-respawn within a few seconds. (Internal code name kept
      // as-is per protocol; user-facing copy is brand-clean.)
      case "ENGINE_DOWN":
        return {
          kind: "gateway_closed",
          title: C.gatewayDownTitle,
          body: gateway.rest || C.gatewayDownBody,
          actions: [{ kind: "reload" }, { kind: "dismiss" }],
          persistent: true,
        };
      // Per-tier entitlement caps (D7). The bridge / billing route sends a
      // ready-made message ("Batas agen untuk paket ini sudah tercapai …");
      // surface it + an Upgrade CTA.
      case "AGENT_LIMIT_EXCEEDED":
      case "CHANNEL_LIMIT_EXCEEDED":
      case "SKILL_LIMIT_EXCEEDED":
      case "SKILL_LIMIT_REACHED":
        return {
          kind: "limit_exceeded",
          title: C.limitExceededTitle,
          body: gateway.rest || C.limitExceededBody,
          actions: [{ kind: "upgrade" }, { kind: "dismiss" }],
          persistent: true,
        };
      // Bridge custom RPC layer — display generic recovery actions; specific
      // copy via gateway.rest (which is brand-scrubbed by the bridge already).
      case "UPDATE_FAILED":
      case "CONFIG_ERROR":
      case "ENGINE_ERROR":
      case "SERVER_ERROR":
      case "PARSE_ERROR":
      case "INTERNAL_ERROR":
        return {
          kind: "unknown",
          title: C.buffBugTitle,
          body: gateway.rest || C.buffBugBody,
          actions: [{ kind: "reload" }, { kind: "dismiss" }],
          persistent: true,
        };
      default:
        return {
          kind: "unknown",
          title: C.genericTitle,
          body: gateway.rest || gateway.code,
          actions: [{ kind: "dismiss" }],
          persistent: true,
        };
    }
  }

  // Non-GatewayError — network / client-side / stream-closed.
  const lower = message.toLowerCase();
  if (
    lower.includes("gateway closed") ||
    lower.includes("gateway stopped") ||
    lower.includes("gateway not connected") ||
    lower.includes("gateway not ready")
  ) {
    return {
      kind: "gateway_closed",
      title: C.gatewayOffTitle,
      body: C.gatewayOffBody,
      actions: [{ kind: "reload" }, { kind: "dismiss" }],
      persistent: true,
    };
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return {
      kind: "network",
      title: C.networkTitle,
      body: C.networkBody,
      actions: [{ kind: "dismiss" }],
      persistent: true,
    };
  }
  if (!message) {
    return {
      kind: "unknown",
      title: C.genericTitle,
      body: C.genericRetry,
      actions: [{ kind: "dismiss" }],
      persistent: false,
    };
  }
  return {
    kind: "unknown",
    title: C.genericTitle,
    body: message,
    actions: [{ kind: "dismiss" }],
    persistent: true,
  };
}

/** Open the Energy Vault billing popup with the same size + origin policy as
 *  §3.6.1 of CLAUDE.md. Falls back to a same-tab navigation if the popup is
 *  blocked (Chrome blocks popups that aren't triggered by a direct user
 *  gesture — our click handlers qualify, but some browsers are stricter).
 *  Same-origin in both dev and prod — no cross-origin CSP friction. */
export function openEnergyVaultPopup(): Window | null {
  // Delegates to the shared opener so it forwards ?parent=<origin> — without
  // that, the popup's settle postMessage is dropped by validateParentOrigin.
  return openBillingPopup("/billing/energy", "agentbuff-billing-energy");
}

/** Open the upgrade flow (Item Shop / checkout) when a per-tier limit is hit. */
export function openUpgradePopup(): Window | null {
  return openBillingPopup("/checkout", "agentbuff-upgrade");
}
