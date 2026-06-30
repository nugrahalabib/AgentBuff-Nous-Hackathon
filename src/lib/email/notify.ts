import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, userProfiles } from "@/lib/db/schema";
import { sendEmail, mailerConfigured, type MailAttachment } from "./mailer";
import { getEmailSettings } from "./settings";
import type { EmailContent, Locale } from "./templates";

// Email a user by id. The `build` callback receives the user's resolved locale
// (`id` default, `en` for English users) so the email language follows the
// account's UI language. Fire-and-forget safe — resolves false on any miss and
// NEVER throws (callers `void` it so settle/expiry are never blocked by mail).
// Skips the DB lookup entirely when SMTP is unconfigured (dev / creds not
// plugged yet).
export async function emailUser(
  userId: string,
  build: (locale: Locale) => EmailContent,
  buildAttachments?: (ctx: {
    email: string;
    name: string | null;
    locale: Locale;
  }) => Promise<MailAttachment[]>,
): Promise<boolean> {
  if (!mailerConfigured()) return false;
  // Admin email kill-switch (default on).
  if (!(await getEmailSettings()).enabled) return false;
  try {
    const [row] = await db
      .select({ email: users.email, name: users.name, locale: userProfiles.locale })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.email) return false;
    const locale: Locale = row.locale === "en" ? "en" : "id";
    // Resolve attachments AFTER the recipient is known, so the PDF is built for
    // the exact address it'll be sent to (correct billed-to + language).
    const attachments = buildAttachments
      ? await buildAttachments({ email: row.email, name: row.name ?? null, locale })
      : undefined;
    return await sendEmail({ to: row.email, ...build(locale), attachments });
  } catch (e) {
    console.error("[email] emailUser failed:", e);
    return false;
  }
}
