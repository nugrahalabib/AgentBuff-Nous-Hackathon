import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { getEmailSettings } from "./settings";

// AgentBuff logo embedded INLINE (CID) so it renders in Gmail/Apple/Outlook
// even before the public domain is live + survives image-blocking (unlike a
// hosted URL or a data: URI, which Gmail strips). Templates reference it as
// <img src="cid:agentbuff-logo">; we only attach when the HTML uses it. Asset =
// the 54KB square brand mark.
export const LOGO_CID = "agentbuff-logo";
const LOGO_PATH = path.join(process.cwd(), "public", "images", "apple-icon.png");

// Gmail SMTP mailer for trial/renewal reminders + payment receipts. Config via
// env (plug the Gmail App Password later). If SMTP creds are absent the mailer
// is a NO-OP (dev / not yet configured) — email must NEVER block settle/expiry.
//
// Chief's Gmail setup: a sender Gmail account → enable 2-Step Verification →
// create an App Password (myaccount.google.com → Security → App passwords →
// "Mail") → set env:
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=<sender@gmail.com>
//   SMTP_PASS=<16-char app password, no spaces>
//   MAIL_FROM=AgentBuff <sender@gmail.com>
// (Gmail SMTP allows ~500 emails/day on a free account — enough to start.)

let cached: Transporter | null = null;
let resolved = false;

function transporter(): Transporter | null {
  if (resolved) return cached;
  resolved = true;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    cached = null; // not configured → no-op
    return null;
  }
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  cached = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user, pass },
  });
  return cached;
}

/** True when SMTP creds are present (so callers can skip building templates). */
export function mailerConfigured(): boolean {
  return transporter() !== null;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
}

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

/**
 * Fire-and-forget safe. Returns true if SMTP accepted the message, false if
 * skipped (unconfigured / no recipient) or failed. NEVER throws — an email
 * failure must not fail the settle/expiry path that called it.
 */
export async function sendEmail(input: MailInput): Promise<boolean> {
  const tx = transporter();
  if (!tx || !input.to) return false;
  const fromAddr = process.env.MAIL_FROM || process.env.SMTP_USER || "";
  // Apply the admin-configured sender display name + reply-to (D15). Without
  // this, those settings were stored but never reached an actual email.
  let senderName: string | null = null;
  let replyTo: string | undefined;
  try {
    const s = await getEmailSettings();
    senderName = s.senderName;
    replyTo = s.replyTo || undefined;
  } catch {
    // settings hiccup -> fall back to a bare from address (never block the send)
  }
  const from =
    senderName && fromAddr
      ? `"${senderName.replace(/["\r\n]/g, "")}" <${fromAddr}>`
      : fromAddr;
  try {
    // Inline the logo (CID) when referenced, plus any caller attachments (PDF).
    const attachments: Array<{
      filename: string;
      path?: string;
      cid?: string;
      content?: Buffer;
    }> = [];
    if (input.html.includes(`cid:${LOGO_CID}`)) {
      attachments.push({ filename: "agentbuff.png", path: LOGO_PATH, cid: LOGO_CID });
    }
    if (input.attachments) {
      for (const a of input.attachments) {
        attachments.push({ filename: a.filename, content: a.content });
      }
    }
    await tx.sendMail({
      from,
      replyTo,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: attachments.length ? attachments : undefined,
    });
    return true;
  } catch (e) {
    console.error("[mailer] sendEmail failed:", e);
    return false;
  }
}
