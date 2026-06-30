// Transactional email templates — trial/renewal reminders + payment receipts.
// Each returns { subject, html, text }. Language follows the user's locale
// (`id` default, `en` for English users) — see emailUser in ./notify.
//
// EMAIL-HTML rules baked in here (NOT web HTML): table-based layout, ALL styles
// inline, web-safe font stack, a bulletproof CTA (table-cell + padded anchor +
// solid bgcolor fallback for Outlook + gradient for the rest), a hidden
// preheader, the AgentBuff logo embedded inline via CID (cid:agentbuff-logo —
// survives image-blocking + works before the domain is live), and a DARK card
// (`color-scheme: dark` so dark-aware clients don't re-tint it). Links come from
// the deployed origin.
//
// Copy goal: PROFESSIONAL + CRYSTAL-CLEAR. Each email's purpose is obvious from
// the subject + heading + first line; no gaming slang as the meaning-carrier.
// COPY strings are PLAIN text (literal "&") — shell() HTML-escapes them.
import { LOGO_CID } from "./mailer";
import { planPrice } from "@/lib/billing/plans";

// OP Buff monthly price for upsell COPY only, from the plans.ts CATALOG default
// (module-load constant — admin price overrides from D14 are NOT reflected here).
// Acceptable: this is marketing copy, not a charge — receipts use the real
// transaction.amountRp and checkout shows/confirms the admin-effective price.
// id → "Rp99.000", en → "Rp99,000".
const OP_BUFF_PRICE_ID = `Rp${planPrice("op_buff", "monthly").toLocaleString("id-ID")}`;
const OP_BUFF_PRICE_EN = `Rp${planPrice("op_buff", "monthly").toLocaleString("en-US")}`;

const APP_ORIGIN = (
  process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentbuff.id"
).replace(/\/$/, "");
const UPGRADE_URL = `${APP_ORIGIN}/checkout`;
const APP_URL = `${APP_ORIGIN}/app`;
const BRAND = "AgentBuff";
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type Locale = "id" | "en";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function rupiah(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Dark email shell
// ---------------------------------------------------------------------------

type Tone = "info" | "warn" | "success";

interface ShellOpts {
  locale: Locale;
  preheader: string;
  badge?: string;
  badgeTone?: Tone;
  heading: string;
  bodyLines: string[];
  infoHtml?: string;
  ctaLabel: string;
  ctaUrl: string;
}

// Hand-mixed dark tints (hex only — some clients drop rgba in inline styles).
const TONES: Record<Tone, { text: string; bg: string; border: string }> = {
  info: { text: "#67e8f9", bg: "#0e2a33", border: "#155e6b" },
  warn: { text: "#fcd34d", bg: "#332810", border: "#854d0e" },
  success: { text: "#6ee7b7", bg: "#0c2f23", border: "#15803d" },
};

const FOOTER = {
  id: {
    openApp: "Buka AgentBuff",
    note: "Email otomatis dari AgentBuff. Kalau kamu merasa tidak pernah mendaftar, abaikan saja email ini.",
  },
  en: {
    openApp: "Open AgentBuff",
    note: "Automated email from AgentBuff. If you never signed up, you can ignore this message.",
  },
} as const;

function shell(o: ShellOpts): string {
  const tone = TONES[o.badgeTone ?? "info"];
  const foot = FOOTER[o.locale];

  const badge = o.badge
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr><td style="background-color:${tone.bg};border:1px solid ${tone.border};border-radius:999px;padding:5px 13px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${tone.text};">${esc(o.badge)}</td></tr></table>`
    : "";

  const paras = o.bodyLines
    .map(
      (l) =>
        `<p style="margin:0 0 15px;font-family:${FONT};font-size:15px;line-height:1.68;color:#aab4c4;">${esc(l)}</p>`,
    )
    .join("");

  const info = o.infoHtml
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr><td style="background-color:#141a26;border:1px solid #232b3b;border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:13px;line-height:1.6;color:#aab4c4;">${o.infoHtml}</td></tr></table>`
    : "";

  return `<!doctype html>
<html lang="${o.locale}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="x-ua-compatible" content="IE=edge">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background-color:#05060a;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#05060a;opacity:0;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#05060a;">
  <tr><td align="center" style="padding:30px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#0e1116;border:1px solid #1e2433;border-radius:16px;overflow:hidden;">
      <tr><td style="height:4px;font-size:0;line-height:0;background-color:#6366f1;background-image:linear-gradient(90deg,#22d3ee,#6366f1,#d946ef);">&nbsp;</td></tr>
      <tr><td style="padding:22px 36px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="padding-right:11px;vertical-align:middle;">
            <img src="cid:${LOGO_CID}" width="40" height="40" alt="${BRAND}" style="display:block;border-radius:9px;border:1px solid #232a3a;">
          </td>
          <td style="vertical-align:middle;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:-0.01em;color:#f1f5f9;">AgentBuff</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:24px 36px 8px;">
        ${badge}
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:23px;line-height:1.3;font-weight:800;color:#f1f5f9;">${esc(o.heading)}</h1>
        ${paras}
        ${info}
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;"><tr>
          <td align="center" bgcolor="#6366f1" style="border-radius:11px;background-image:linear-gradient(90deg,#22d3ee,#6366f1,#d946ef);">
            <a href="${o.ctaUrl}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:11px;">${esc(o.ctaLabel)}</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 36px 30px;border-top:1px solid #1c2331;">
        <p style="margin:0 0 9px;font-family:${FONT};font-size:12px;line-height:1.6;color:#7c8aa0;">
          <a href="${APP_URL}" target="_blank" style="color:#67e8f9;text-decoration:none;font-weight:600;">${foot.openApp}</a>
        </p>
        <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:#566074;">${foot.note}</p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-family:${FONT};font-size:11px;color:#444e60;">&copy; ${BRAND}</p>
  </td></tr>
</table>
</body></html>`;
}

function plain(
  locale: Locale,
  heading: string,
  lines: string[],
  cta: { label: string; url: string },
): string {
  return [
    BRAND.toUpperCase(),
    "",
    heading,
    "",
    ...lines,
    "",
    `${cta.label}: ${cta.url}`,
    "",
    FOOTER[locale].note,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Conversion copy (ID + EN) — professional + crystal-clear. Each email's
// purpose is obvious; plain words a non-technical reader gets in one pass.
// `{n}` = days left (only in trialReminder + subReminder). Plain text, literal
// "&" — shell()/plain() handle escaping.
// ---------------------------------------------------------------------------

interface Variant {
  subject: string;
  preheader: string;
  badge: string;
  heading: string;
  body: string[];
  cta: string;
}

interface CopySet {
  trialReminder: Variant;
  trialLastDay: Variant;
  trialExpired: Variant;
  subReminder: Variant;
  subExpired: Variant;
  paymentReceipt: Variant;
}

const COPY: Record<Locale, CopySet> = {
  id: {
    trialReminder: {
      subject: "Uji coba gratis tinggal {n} hari lagi",
      preheader:
        "Setelah uji coba habis, asisten AI kamu berhenti aktif sampai kamu berlangganan.",
      badge: "Sisa {n} hari",
      heading: "Uji coba gratis kamu tinggal {n} hari lagi",
      body: [
        "Setelah {n} hari, asisten AI kamu berhenti membalas chat di WhatsApp & Telegram sampai kamu berlangganan.",
        `Supaya asisten tetap jalan tanpa terputus, berlangganan paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}).`,
      ],
      cta: "Berlangganan sekarang",
    },
    trialLastDay: {
      subject: "Uji coba gratis kamu berakhir besok",
      preheader:
        "Besok asisten AI kamu berhenti aktif. Berlangganan supaya tetap jalan tanpa terputus.",
      badge: "Berakhir besok",
      heading: "Uji coba gratis kamu berakhir besok",
      body: [
        "Mulai besok, asisten AI kamu berhenti membalas chat di WhatsApp & Telegram sampai kamu berlangganan. Tenang, semua datamu tetap aman.",
        `Berlangganan paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}) hari ini supaya asisten kamu lanjut aktif tanpa terputus.`,
      ],
      cta: "Berlangganan sekarang",
    },
    trialExpired: {
      subject: "Uji coba gratis kamu sudah berakhir",
      preheader:
        "Asisten AI kamu berhenti aktif. Semua data aman. Berlangganan untuk mengaktifkannya lagi.",
      badge: "Sudah berakhir",
      heading: "Uji coba gratis kamu sudah berakhir",
      body: [
        "Asisten AI kamu berhenti membalas chat di WhatsApp & Telegram. Tenang, semua data, pengaturan, saluran (WhatsApp & Telegram) yang tersambung, dan riwayat chat kamu tetap aman tersimpan.",
        `Berlangganan paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}) dan asisten kamu langsung aktif lagi seperti semula.`,
      ],
      cta: "Aktifkan kembali",
    },
    subReminder: {
      subject: "Langganan kamu berakhir dalam {n} hari",
      preheader:
        "Tidak ada tagihan otomatis. Perpanjang sendiri sebelum jatuh tempo supaya asisten tetap jalan.",
      badge: "Sisa {n} hari",
      heading: "Langganan kamu berakhir dalam {n} hari",
      body: [
        `Dalam {n} hari, paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}) kamu berakhir. Kalau tidak diperpanjang, asisten AI kamu berhenti membalas chat di WhatsApp & Telegram.`,
        "Kami tidak menarik dana otomatis, jadi kamu sendiri yang perpanjang sebelum tanggal habis. Perpanjang sekarang supaya asisten kamu lanjut tanpa terputus.",
      ],
      cta: "Perpanjang sekarang",
    },
    subExpired: {
      subject: "Langganan kamu sudah berakhir",
      preheader:
        "Asisten AI kamu berhenti aktif. Semua data aman. Perpanjang untuk mengaktifkannya lagi.",
      badge: "Sudah berakhir",
      heading: "Langganan kamu sudah berakhir",
      body: [
        "Asisten AI kamu berhenti membalas chat di WhatsApp & Telegram. Tenang, semua data, pengaturan, saluran (WhatsApp & Telegram) yang tersambung, dan riwayat chat kamu tetap aman tersimpan.",
        `Perpanjang paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}) dan asisten kamu langsung aktif lagi seperti semula.`,
      ],
      cta: "Aktifkan kembali",
    },
    paymentReceipt: {
      subject: "Pembayaran berhasil, asisten kamu aktif",
      preheader:
        "Terima kasih. Pembayaran kamu sudah kami terima dan asisten AI kamu sudah aktif.",
      badge: "Pembayaran berhasil",
      heading: "Pembayaran kamu berhasil",
      body: [
        `Terima kasih. Pembayaran paket OP Buff (langganan bulanan ${OP_BUFF_PRICE_ID}) sudah kami terima, dan asisten AI kamu kembali aktif 24 jam setiap hari membalas chat di WhatsApp & Telegram serta mengerjakan tugas seperti biasa.`,
        "Buka AgentBuff kapan saja untuk mengatur asisten kamu. Simpan email ini sebagai bukti pembayaran.",
      ],
      cta: "Buka AgentBuff",
    },
  },
  en: {
    trialReminder: {
      subject: "Your free trial ends in {n} days",
      preheader:
        "When the trial ends, your AI assistant stops working until you subscribe.",
      badge: "{n} days left",
      heading: "Your free trial ends in {n} days",
      body: [
        "In {n} days, your AI assistant stops replying on WhatsApp & Telegram until you subscribe.",
        `To keep it running without interruption, subscribe to the OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}).`,
      ],
      cta: "Subscribe now",
    },
    trialLastDay: {
      subject: "Your free trial ends tomorrow",
      preheader:
        "Tomorrow your AI assistant stops working. Subscribe to keep it running.",
      badge: "Ends tomorrow",
      heading: "Your free trial ends tomorrow",
      body: [
        "Starting tomorrow, your AI assistant stops replying on WhatsApp & Telegram until you subscribe. Don't worry, all your data stays safe.",
        `Subscribe to the OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}) today so your assistant keeps running without a gap.`,
      ],
      cta: "Subscribe now",
    },
    trialExpired: {
      subject: "Your free trial has ended",
      preheader:
        "Your AI assistant has stopped. All your data is safe. Subscribe to turn it back on.",
      badge: "Trial ended",
      heading: "Your free trial has ended",
      body: [
        "Your AI assistant has stopped replying on WhatsApp & Telegram. Don't worry, all your data, settings, connected channels like WhatsApp & Telegram, and chat history are safely saved.",
        `Subscribe to the OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}) and your assistant comes right back, just as it was.`,
      ],
      cta: "Reactivate now",
    },
    subReminder: {
      subject: "Your subscription ends in {n} days",
      preheader:
        "No automatic charges. Renew yourself before the due date to keep your assistant running.",
      badge: "{n} days left",
      heading: "Your subscription ends in {n} days",
      body: [
        `In {n} days, your OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}) ends. If you don't renew, your AI assistant stops replying on WhatsApp & Telegram.`,
        "We never charge you automatically, so you renew it yourself before it expires. Renew now to keep your assistant running without interruption.",
      ],
      cta: "Renew now",
    },
    subExpired: {
      subject: "Your subscription has ended",
      preheader:
        "Your AI assistant has stopped. All your data is safe. Renew to turn it back on.",
      badge: "Subscription ended",
      heading: "Your subscription has ended",
      body: [
        "Your AI assistant has stopped replying on WhatsApp & Telegram. Don't worry, all your data, settings, connected channels like WhatsApp & Telegram, and chat history are safely saved.",
        `Renew the OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}) and your assistant comes right back, just as it was.`,
      ],
      cta: "Reactivate now",
    },
    paymentReceipt: {
      subject: "Payment received, your assistant is active",
      preheader:
        "Thank you. We've received your payment and your AI assistant is now active.",
      badge: "Payment received",
      heading: "Your payment was successful",
      body: [
        `Thank you. We've received your payment for the OP Buff plan (monthly subscription, ${OP_BUFF_PRICE_EN}), and your AI assistant is back to running 24 hours a day, replying on WhatsApp & Telegram and handling your tasks as usual.`,
        "Open AgentBuff anytime to manage your assistant. Keep this email as your payment receipt.",
      ],
      cta: "Open AgentBuff",
    },
  },
};

function fill(v: Variant, n: number): Variant {
  const sub = (s: string) => s.replace(/\{n\}/g, String(n));
  return {
    subject: sub(v.subject),
    preheader: sub(v.preheader),
    badge: sub(v.badge),
    heading: sub(v.heading),
    body: v.body.map(sub),
    cta: sub(v.cta),
  };
}

// ---------------------------------------------------------------------------
// D15 — admin copy overrides. Templates stay SYNC (emailUser's builder is sync,
// settle.ts calls paymentReceiptEmail directly), so overrides live in an
// in-memory cache refreshed at module load + after each admin save. Single-proc
// deployment (per CLAUDE.md), so a post-save reload is immediately effective.
// ---------------------------------------------------------------------------

export type TemplateKey = keyof CopySet;
export const TEMPLATE_KEYS: TemplateKey[] = [
  "trialReminder",
  "trialLastDay",
  "trialExpired",
  "subReminder",
  "subExpired",
  "paymentReceipt",
];

type VariantOverride = Partial<Variant>;
const overrideCache: Record<Locale, Partial<Record<TemplateKey, VariantOverride>>> =
  { id: {}, en: {} };

/** Compiled-in defaults (for the admin editor to show + reset against). */
export function emailTemplateDefault(locale: Locale, key: TemplateKey): Variant {
  return COPY[locale][key];
}

/** Reload the override cache from the DB. Called at module load (fire-and-forget)
 *  and awaited by the admin save route so an edit takes effect immediately. */
export async function loadEmailCopyOverrides(): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");
    const rows = await db.select().from(schema.emailTemplateOverrides);
    const next: Record<Locale, Partial<Record<TemplateKey, VariantOverride>>> = {
      id: {},
      en: {},
    };
    for (const r of rows) {
      const loc: Locale = r.locale === "en" ? "en" : "id";
      if (TEMPLATE_KEYS.includes(r.templateKey as TemplateKey)) {
        next[loc][r.templateKey as TemplateKey] = (r.fields ?? {}) as VariantOverride;
      }
    }
    overrideCache.id = next.id;
    overrideCache.en = next.en;
  } catch {
    // Keep whatever is cached (defaults on cold start) — never break a send.
  }
}

/** Variant with admin overrides overlaid field-by-field (empty override = default). */
function resolved(locale: Locale, key: TemplateKey): Variant {
  const base = COPY[locale][key];
  const ov = overrideCache[locale]?.[key];
  if (!ov) return base;
  const str = (o: unknown, d: string) =>
    typeof o === "string" && o.trim() ? o : d;
  const arr = (o: unknown, d: string[]) =>
    Array.isArray(o) && o.length > 0
      ? o.filter((x): x is string => typeof x === "string")
      : d;
  return {
    subject: str(ov.subject, base.subject),
    preheader: str(ov.preheader, base.preheader),
    badge: str(ov.badge, base.badge),
    heading: str(ov.heading, base.heading),
    body: arr(ov.body, base.body),
    cta: str(ov.cta, base.cta),
  };
}

// Warm the cache at import (fire-and-forget). Idempotent; admin saves re-run it.
void loadEmailCopyOverrides();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function trialReminderEmail(
  daysLeft: number,
  locale: Locale = "id",
): EmailContent {
  const last = daysLeft <= 1;
  const c = fill(
    resolved(locale, last ? "trialLastDay" : "trialReminder"),
    daysLeft,
  );
  return {
    subject: c.subject,
    html: shell({
      locale,
      preheader: c.preheader,
      badge: c.badge,
      badgeTone: last ? "warn" : "info",
      heading: c.heading,
      bodyLines: c.body,
      ctaLabel: c.cta,
      ctaUrl: UPGRADE_URL,
    }),
    text: plain(locale, c.heading, c.body, { label: c.cta, url: UPGRADE_URL }),
  };
}

export function trialExpiredEmail(locale: Locale = "id"): EmailContent {
  const c = resolved(locale, "trialExpired");
  return {
    subject: c.subject,
    html: shell({
      locale,
      preheader: c.preheader,
      badge: c.badge,
      badgeTone: "warn",
      heading: c.heading,
      bodyLines: c.body,
      ctaLabel: c.cta,
      ctaUrl: UPGRADE_URL,
    }),
    text: plain(locale, c.heading, c.body, { label: c.cta, url: UPGRADE_URL }),
  };
}

export function subscriptionReminderEmail(
  daysLeft: number,
  locale: Locale = "id",
): EmailContent {
  const last = daysLeft <= 1;
  const c = fill(resolved(locale, "subReminder"), daysLeft);
  return {
    subject: c.subject,
    html: shell({
      locale,
      preheader: c.preheader,
      badge: c.badge,
      badgeTone: last ? "warn" : "info",
      heading: c.heading,
      bodyLines: c.body,
      ctaLabel: c.cta,
      ctaUrl: UPGRADE_URL,
    }),
    text: plain(locale, c.heading, c.body, { label: c.cta, url: UPGRADE_URL }),
  };
}

export function subscriptionExpiredEmail(locale: Locale = "id"): EmailContent {
  const c = resolved(locale, "subExpired");
  return {
    subject: c.subject,
    html: shell({
      locale,
      preheader: c.preheader,
      badge: c.badge,
      badgeTone: "warn",
      heading: c.heading,
      bodyLines: c.body,
      ctaLabel: c.cta,
      ctaUrl: UPGRADE_URL,
    }),
    text: plain(locale, c.heading, c.body, { label: c.cta, url: UPGRADE_URL }),
  };
}

export function paymentReceiptEmail(
  opts: { description: string; amountRp: number },
  locale: Locale = "id",
): EmailContent {
  const c = resolved(locale, "paymentReceipt");
  const paidLabel = locale === "en" ? "Total paid" : "Total dibayar";
  const receiptRow = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7c8aa0;padding-bottom:6px;" colspan="2">${paidLabel}</td></tr><tr><td style="font-family:${FONT};font-size:14px;line-height:1.5;color:#cbd5e1;">${esc(opts.description)}</td><td align="right" style="font-family:${FONT};font-size:17px;font-weight:800;color:#f1f5f9;white-space:nowrap;padding-left:12px;">${rupiah(opts.amountRp)}</td></tr></table>`;
  return {
    subject: c.subject,
    html: shell({
      locale,
      preheader: c.preheader,
      badge: c.badge,
      badgeTone: "success",
      heading: c.heading,
      bodyLines: c.body,
      infoHtml: receiptRow,
      ctaLabel: c.cta,
      ctaUrl: APP_URL,
    }),
    text: plain(
      locale,
      c.heading,
      [...c.body, `${opts.description} — ${rupiah(opts.amountRp)}`],
      { label: c.cta, url: APP_URL },
    ),
  };
}
