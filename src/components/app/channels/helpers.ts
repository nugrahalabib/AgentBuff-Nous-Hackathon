/**
 * Shared helpers untuk channels tab. Pure functions, mudah di-test.
 */

import type {
  ChannelAccountResponse,
  ChannelDashboardEntryResponse,
} from "@/hooks/use-api";

export type ChannelState =
  | "online" // connected + running
  | "connecting" // configured + reconnect attempts
  | "offline" // configured but not running/connected
  | "needs-setup"; // not configured yet

/**
 * Hitung state dari satu account snapshot. Single source of truth supaya
 * UI consistent (status pill, gradient strip, alert tone).
 *
 * Aturan online (mengikuti channels-service.isAccountOnline):
 * - WS-persistent channel (WhatsApp, Slack socket) set `connected` field
 * - Polling channel (Telegram, Discord polling) TIDAK set `connected`
 * - Account "online" kalau running + tidak ada error + bukan explicit
 *   `connected: false`
 *
 * Tanpa rule polling-aware ini, Telegram running yang functional bakal
 * salah label "offline" → UI nampilin TERPUTUS palsu.
 */
export function accountState(acc: ChannelAccountResponse): ChannelState {
  if (acc.running && acc.connected !== false && !acc.lastError) {
    return "online";
  }
  if (
    typeof acc.reconnectAttempts === "number" &&
    acc.reconnectAttempts > 0 &&
    acc.configured
  ) {
    return "connecting";
  }
  if (acc.configured || acc.linked) return "offline";
  return "needs-setup";
}

/**
 * Channel-level state diturunkan dari semua accounts. Aggregator:
 * - Kalau ada account online → online
 * - Kalau ada account connecting → connecting
 * - Kalau ada account offline (configured but down) → offline
 * - Kalau semua needs-setup → needs-setup
 */
export function channelState(
  entry: ChannelDashboardEntryResponse,
): ChannelState {
  if (entry.accounts.length === 0) return "needs-setup";
  let hasConnecting = false;
  let hasOffline = false;
  let hasNeedsSetup = false;
  for (const acc of entry.accounts) {
    const s = accountState(acc);
    if (s === "online") return "online";
    if (s === "connecting") hasConnecting = true;
    else if (s === "offline") hasOffline = true;
    else hasNeedsSetup = true;
  }
  if (hasConnecting) return "connecting";
  if (hasOffline) return "offline";
  if (hasNeedsSetup) return "needs-setup";
  return "offline";
}

/**
 * Format relative time pendek untuk UI channels.
 *   <60s  → "baru saja"
 *   <1h   → "5 menit lalu"
 *   <24h  → "3 jam lalu"
 *   <30d  → "5 hari lalu"
 *   else  → "DD MMM YYYY"
 */
export function formatChannelRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "baru saja";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} hari lalu`;
  const date = new Date(ts);
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format phone number E.164 → Indonesian-friendly:
 *   +6281234567890 → "+62 812-3456-7890"
 *   Lainnya: spasi tiap 3 angka.
 */
export function formatPhoneE164(raw: string | undefined): string {
  if (!raw) return "—";
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+62") || cleaned.length < 10) {
    // Generic format: +<cc> <body grouped 3>
    return cleaned;
  }
  const cc = cleaned.slice(0, 3); // +62
  const body = cleaned.slice(3);
  // Indonesian mobile: typically 10-11 digits after +62.
  // Pattern: +62 8XX-XXXX-XXXX
  if (body.length >= 9) {
    const a = body.slice(0, 3);
    const b = body.slice(3, 7);
    const c = body.slice(7);
    return `${cc} ${a}-${b}${c ? `-${c}` : ""}`;
  }
  return `${cc} ${body}`;
}

/**
 * Pull WhatsApp self phone E.164 dari rawStatus.
 * Engine WhatsApp Status type: `self?.e164`.
 */
export function extractWhatsAppPhone(rawStatus: unknown): string | null {
  if (!rawStatus || typeof rawStatus !== "object") return null;
  const r = rawStatus as { self?: { e164?: string } };
  return r.self?.e164 ?? null;
}

/**
 * Pull Telegram bot username dari rawStatus account-level probe.
 */
export function extractTelegramBotUsername(
  acc: ChannelAccountResponse,
): string | null {
  const probe = acc.probe;
  if (!probe || typeof probe !== "object") return null;
  const p = probe as { bot?: { username?: string } };
  return p.bot?.username ?? null;
}

/**
 * Pull Slack bot/team info dari probe.
 */
export function extractSlackInfo(
  acc: ChannelAccountResponse,
): { team: string | null; bot: string | null } {
  const probe = acc.probe;
  if (!probe || typeof probe !== "object") return { team: null, bot: null };
  const p = probe as {
    bot?: { name?: string; userId?: string };
    team?: { name?: string; id?: string };
  };
  return {
    team: p.team?.name ?? null,
    bot: p.bot?.name ?? null,
  };
}

/**
 * Validate allowlist entry — channel-aware.
 * - WhatsApp: E.164 phone (+62...)
 * - Telegram: @username atau numeric ID
 * - Discord/Slack: snowflake ID atau username#tag
 * - Generic: non-empty trimmed string
 */
export function validateAllowlistEntry(
  channelId: string,
  raw: string,
): { ok: boolean; normalized: string; reason?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, normalized: "", reason: "Kosong" };
  }
  if (channelId === "whatsapp") {
    // Accept +62..., 62..., or 0... (Indonesian common variations).
    const digits = trimmed.replace(/[^\d+]/g, "");
    if (/^\+\d{8,15}$/.test(digits)) return { ok: true, normalized: digits };
    if (/^62\d{8,13}$/.test(digits))
      return { ok: true, normalized: `+${digits}` };
    if (/^0\d{8,12}$/.test(digits))
      return { ok: true, normalized: `+62${digits.slice(1)}` };
    return { ok: false, normalized: trimmed, reason: "Format nomor salah" };
  }
  if (channelId === "telegram") {
    // Engine matches allowlist ONLY against the NUMERIC user id
    // (gateway/platforms/telegram.py:5719 -> SessionSource.user_id = str(user.id);
    // run.py:_is_user_authorized compares that numeric id). @username is NEVER
    // matched, so we reject it instead of silently storing a dead entry.
    if (/^\d{4,15}$/.test(trimmed)) {
      return { ok: true, normalized: trimmed };
    }
    return {
      ok: false,
      normalized: trimmed,
      reason: "Telegram pakai user ID angka (dari @userinfobot), bukan @username",
    };
  }
  if (channelId === "google_chat") {
    // GC gates by sender EMAIL (GOOGLE_CHAT_ALLOWED_USERS, adapter.py:439).
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return { ok: true, normalized: trimmed.toLowerCase() };
    }
    return {
      ok: false,
      normalized: trimmed,
      reason: "Google Chat pakai alamat email (mis. nama@domain.com)",
    };
  }
  // Generic fallback — trim only.
  return { ok: true, normalized: trimmed };
}

/**
 * Generate paste-split — handle bulk paste comma/newline-separated.
 * Returns array entries to validate one-by-one.
 */
export function splitAllowlistPaste(text: string): string[] {
  return text
    .split(/[,;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
