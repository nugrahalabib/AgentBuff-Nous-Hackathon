import { db } from "@/lib/db";
import { emailSettings } from "@/lib/db/schema";

// Admin-configurable reminder/email settings (single-row table, edited by the
// future Admin page). Workers read this each sweep via a 60s cache. An absent
// row → safe defaults, so the system works before any admin config exists.

export interface EmailSettings {
  enabled: boolean;
  reminderOffsetsDays: number[];
  senderName: string | null;
  replyTo: string | null;
}

const DEFAULTS: EmailSettings = {
  enabled: true,
  reminderOffsetsDays: [3, 2, 1],
  senderName: null,
  replyTo: null,
};

let cache: { v: EmailSettings; at: number } | null = null;
const TTL_MS = 60_000;

export async function getEmailSettings(): Promise<EmailSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;
  try {
    const [row] = await db.select().from(emailSettings).limit(1);
    const v: EmailSettings = row
      ? {
          enabled: row.enabled,
          reminderOffsetsDays:
            Array.isArray(row.reminderOffsetsDays) &&
            row.reminderOffsetsDays.length > 0
              ? row.reminderOffsetsDays
              : DEFAULTS.reminderOffsetsDays,
          senderName: row.senderName,
          replyTo: row.replyTo,
        }
      : DEFAULTS;
    cache = { v, at: Date.now() };
    return v;
  } catch (e) {
    console.error("[email-settings] read failed, using defaults:", e);
    return DEFAULTS;
  }
}
