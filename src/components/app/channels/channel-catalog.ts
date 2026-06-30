/**
 * Channel Catalog Metadata — single source untuk daftar channel yang
 * AgentBuff support, beserta visual/copy/onboarding hint.
 *
 * Order ditentukan by mass-market relevance untuk Indonesia (target market):
 * 1. WhatsApp — flagship, paling banyak dipakai UMKM
 * 2. Telegram — popular untuk bot
 * 3. Discord — komunitas + creator
 * 4. Instagram — DM customer service (planned, belum di engine)
 * 5. Slack — work-team
 * 6. Google Chat — enterprise
 * 7. Signal — privacy-first niche
 * 8. iMessage — Mac-only, niche
 * 9. Nostr — crypto/decentralized niche
 *
 * Tier requirement: hide channel-channel niche (Signal, iMessage, Nostr)
 * untuk Starter user. Show untuk OP Buff+.
 */

import type {
  EffectiveTier,
} from "@/lib/dashboard/subscription-resolver";

/**
 * Pairing strategy yang dipakai komponen wizard. Field-level config path
 * inferred dari `tokenField` (untuk single-token strategies).
 *
 * - `qr`                    → WhatsApp QR scan (web.login.start + web.login.wait)
 * - `single-token`          → satu input field, patch ke `channels.<id>.<tokenField>`
 *                              + set `enabled: true`. Telegram=botToken, Discord=token.
 * - `slack-tokens`          → 3 input field (botToken, appToken, signingSecret) +
 *                              mode=socket + enabled=true.
 * - `service-account-json`  → paste JSON service account → `channels.<id>.serviceAccount`.
 * - `bridge-cli`            → Signal/iMessage external bridge (manual setup, link to docs).
 * - `manual`                → Nostr manual key import (link to docs).
 */
export type PairingStrategy =
  | "qr"
  | "single-token"
  | "slack-tokens"
  | "service-account-json"
  | "email-imap"
  | "bridge-cli"
  | "manual";

export type ChannelCatalogEntry = {
  /** Engine channel ID (matches `channelOrder` keys di channels.status). */
  id: string;
  /** Display name di UI. */
  label: string;
  /** Tagline untuk catalog card (1 kalimat, brand voice). */
  tagline: string;
  /** Emoji sebagai logo fallback (sebelum systemImage dari engine load). */
  emoji: string;
  /** Brand color accent untuk gradient/badge. */
  accent: "emerald" | "cyan" | "indigo" | "fuchsia" | "amber" | "rose" | "slate";
  /** Pairing strategy. */
  pairing: PairingStrategy;
  /** Untuk pairing="single-token": nama field di engine schema. Telegram="botToken",
   * Discord="token". Required only when pairing==="single-token". */
  tokenField?: string;
  /** Tier requirement untuk discover di catalog. */
  minTier: EffectiveTier;
  /** Apakah channel mendukung multi-account. */
  multiAccount: boolean;
  /** Apakah channel tier-niche (default collapsed di "Saluran Lanjutan"). */
  advanced: boolean;
  /**
   * Coming-soon flag — UI tampilkan card tapi disable klik + ganti badge
   * "Segera Hadir". Berbeda dari `locked` (tier-locked, nudge upgrade) —
   * coming-soon = simply not available yet, no upsell. Pairing dialog
   * TIDAK boleh dibuka untuk channel comingSoon=true. Field tetap di
   * catalog supaya pas siap, tinggal toggle false (no re-add).
   */
  comingSoon?: boolean;
  /** Optional docs link untuk setup deeper guide. */
  docsHref?: string;
};

export const CHANNEL_CATALOG: ReadonlyArray<ChannelCatalogEntry> = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    tagline: "Balas chat pelanggan WA otomatis 24/7",
    emoji: "💬",
    accent: "emerald",
    pairing: "qr",
    minTier: "starter",
    // Per-agen multi-account PROVEN (2026-05-29): 2 WhatsApp bridges (different
    // ports + sessions) run concurrently in one container. Each agent pairs its
    // own number via the agentbuff-multichannel plugin (synthetic platform
    // whatsapp__<agent>).
    multiAccount: true,
    advanced: false,
  },
  {
    id: "telegram",
    label: "Telegram",
    tagline: "Bot Telegram pribadi untuk customer service",
    emoji: "✈️",
    accent: "cyan",
    pairing: "single-token",
    tokenField: "botToken",
    minTier: "starter",
    // Per-agen multi-account PROVEN (R8): 2 Telegram bots (different tokens +
    // models) run concurrently in ONE gateway process. The agentbuff-multichannel
    // plugin registers a synthetic platform telegram__<agent> per account and
    // routes each to its bound agent — bypassing the native single-env-var
    // (TELEGRAM_BOT_TOKEN) constraint. Source: hermes_multichannel_plugin/.
    multiAccount: true,
    advanced: false,
    docsHref: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  },
  {
    id: "discord",
    label: "Discord",
    tagline: "AI moderator + helper di server Discord kamu",
    emoji: "🎮",
    accent: "indigo",
    // Engine schema: `channels.discord.token` (NOT botToken — Discord
    // beda nama field sama Telegram). Lihat config.schema dump.
    pairing: "single-token",
    tokenField: "token",
    minTier: "starter",
    // Per-agen multi-account: plugin adapter_discord.py wraps one discord.py Bot
    // per token (instance-scoped aiohttp+websocket) → N bots coexist in one
    // process. Synthetic platform discord__<agent>.
    multiAccount: true,
    advanced: false,
    docsHref: "https://discord.com/developers/applications",
  },
  {
    id: "slack",
    label: "Slack",
    tagline: "Asisten kerja di workspace Slack",
    emoji: "💼",
    accent: "fuchsia",
    // Slack butuh 3 token (botToken xoxb-, appToken xapp-, signingSecret)
    // + mode=socket. Per-user container gak punya public URL → socket
    // mode satu-satunya yang viable.
    pairing: "slack-tokens",
    minTier: "starter",
    // Per-agen multi-account: plugin adapter_slack.py wraps one slack-bolt AsyncApp
    // + AsyncSocketModeHandler per workspace (Socket Mode = outbound WS, no public
    // URL needed). N workspaces coexist. Synthetic platform slack__<agent>.
    multiAccount: true,
    advanced: false,
    docsHref: "https://api.slack.com/apps",
  },
  {
    // Engine platform id is "google_chat" (underscore) — MUST match the bridge
    // SYNTHETIC_SUPPORTED + the Hermes plugin at plugins/platforms/google_chat/.
    // (Was "googlechat" which the bridge channels.pair would reject.)
    id: "google_chat",
    label: "Google Chat",
    tagline: "Bot enterprise di Google Workspace",
    emoji: "📧",
    accent: "amber",
    pairing: "service-account-json",
    minTier: "op_buff",
    // Per-agen multi-account: native GoogleChatAdapter reads creds from
    // config.extra (service_account_json/project_id/subscription_name) → the
    // native-wrap factory injects per-account extra. Each account = own SA +
    // own Pub/Sub subscription. Synthetic platform google_chat__<agent>.
    multiAccount: true,
    advanced: false,
    docsHref: "https://developers.google.com/chat/quickstart/gcp-project",
  },
  // ───────────────────────────────────────────────────────────────────────
  // PARKED — POST-LAUNCH (v-next). DO NOT FORGET. (chief decision 2026-06-08)
  //
  // Email per-agen (IMAP/SMTP) is FULLY BUILT and proven live: the plugin
  // reports 15 base channels, the bridge field-validates the email pair RPC,
  // and the image is already baked with it. It is intentionally HIDDEN from
  // this catalog until AFTER launch (next version) — chief said: "channel ini
  // kita anggap clear, email-nya hide dulu, lanjut di tahap berikutnya".
  //
  // Re-enable = un-comment the entry below. Everything else is intact and
  // untouched: PairingStrategy "email-imap", EmailPairingBody + the
  // case "email-imap" dispatch (pairing-dialog.tsx), "email" in the frontend
  // SYNTHETIC_SUPPORTED (agent-saluran-panel.tsx) + bridge SYNTHETIC_SUPPORTED
  // / SYNTHETIC_CRED_MAP / PER_CHANNEL_PAIR_SCHEMA (channels_handler.py, email
  // forced through the synthetic path in pair()+logout()), adapter_email.py,
  // and the chat-source-badge Email icon/tone.
  //
  // BEFORE going live it still needs ONE verification: an end-to-end pair with
  // a REAL mailbox (Gmail + App Password) to confirm IMAP/SMTP login actually
  // succeeds (the only thing not yet proven without real creds).
  //
  // Full dossier: ~/.claude/.../memory/channel_email_parked_vnext.md
  // ───────────────────────────────────────────────────────────────────────
  // {
  //   id: "email",
  //   label: "Email",
  //   tagline: "Agen balas email bisnis (IMAP/SMTP) otomatis 24/7",
  //   emoji: "✉️",
  //   accent: "rose",
  //   pairing: "email-imap",
  //   minTier: "starter",
  //   multiAccount: true,
  //   advanced: false,
  //   docsHref: "https://support.google.com/mail/answer/185833",
  // },
  {
    id: "signal",
    label: "Signal",
    tagline: "Channel privacy-first via Signal bridge",
    emoji: "🔒",
    accent: "slate",
    pairing: "bridge-cli",
    minTier: "op_buff",
    multiAccount: false,
    advanced: true,
    comingSoon: true,
  },
  {
    id: "imessage",
    label: "iMessage",
    tagline: "iMessage relay (Mac-only, butuh setup)",
    emoji: "💙",
    accent: "slate",
    pairing: "bridge-cli",
    minTier: "op_buff",
    multiAccount: false,
    advanced: true,
    comingSoon: true,
  },
  {
    id: "nostr",
    label: "Nostr",
    tagline: "Decentralized social (advanced)",
    emoji: "🟣",
    accent: "rose",
    pairing: "manual",
    minTier: "op_buff",
    // Engine constraint sama dengan token-based channel — 1 keypair env per
    // container. Flip ke true ketika bridge support multi-relay/multi-keypair
    // runtime spawn.
    multiAccount: false,
    advanced: true,
    comingSoon: true,
  },
];

const CATALOG_BY_ID = new Map(CHANNEL_CATALOG.map((c) => [c.id, c]));

/**
 * Lookup catalog entry by channel id. Return null kalau channel tidak
 * dikenal — kemungkinan channel baru di engine yang belum di-list disini
 * (defensive untuk forward compat).
 */
export function getChannelCatalog(id: string): ChannelCatalogEntry | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

/**
 * Filter catalog by user tier — hide channels yang require tier lebih tinggi.
 * Plus exclude channels yang sudah connected (parameter `excludeIds`).
 *
 * Coming-soon channels TIDAK di-tier-filter — selama belum siap, tier user
 * irrelevant. Mereka tetap muncul (sebagai disabled coming-soon card) supaya
 * roadmap visible. Tier-locked filter (caller's job) harus exclude comingSoon.
 */
export function filterCatalogForUser(
  tier: EffectiveTier,
  excludeIds: ReadonlySet<string>,
  includeAdvanced: boolean = false,
): ChannelCatalogEntry[] {
  const TIER_ORDER: Record<EffectiveTier, number> = {
    starter: 0,
    op_buff: 1,
    guild_master: 2,
  };
  const userTierLevel = TIER_ORDER[tier];

  return CHANNEL_CATALOG.filter((entry) => {
    if (excludeIds.has(entry.id)) return false;
    // Coming-soon bypass tier check — always show as disabled card
    if (!entry.comingSoon && TIER_ORDER[entry.minTier] > userTierLevel) {
      return false;
    }
    // Coming-soon entries bypass the advanced gate too — always show as a
    // disabled roadmap card regardless of view mode (matches the tier bypass
    // above). Additive: lets more entries through, never fewer. (Audit MED.)
    if (entry.advanced && !includeAdvanced && !entry.comingSoon) return false;
    return true;
  });
}
