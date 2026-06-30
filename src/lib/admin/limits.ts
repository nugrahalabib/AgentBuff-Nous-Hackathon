// Per-tier entitlement + media limits (admin-panel D7). One resolver, one shape,
// consumed by BOTH the /app client (UX) and the bridge enforcement gate (real
// enforcement). All values are admin-overridable per tier via admin_setting; the
// hardcoded defaults below mirror the marketing promise (Starter constrained, OP
// Buff + Guild Master unlimited) and the current media caps.
//
// NO `import "server-only"`: reachable from the bridge-facing user endpoint and
// (potentially) the worker chain — same constraint as settings.ts.
//
// -1 = unlimited (entitlement counts). Media values are in MEGABYTES (admins
// think in MB; the bridge + client multiply to bytes at the edge).
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { containerSkills } from "@/lib/db/schema";
import { resolveSetting } from "@/lib/admin/settings";
import {
  resolveSubscription,
  type EffectiveTier,
} from "@/lib/dashboard/subscription-resolver";
import { resolveAccessState } from "@/lib/billing/trial-resolver";

export type MediaLimits = {
  imageMb: number;
  audioMb: number;
  videoMb: number;
  documentMb: number;
  filesPerMessage: number;
  totalMb: number;
};

export type UserLimits = {
  tier: EffectiveTier;
  maxAgents: number;
  maxChannels: number;
  maxSkills: number;
  media: MediaLimits;
};

export const LIMIT_KEYS = {
  maxAgents: "limit.entitlement.maxAgents",
  maxChannels: "limit.entitlement.maxChannels",
  maxSkills: "limit.entitlement.maxSkills",
  imageMb: "limit.media.imageMb",
  audioMb: "limit.media.audioMb",
  videoMb: "limit.media.videoMb",
  documentMb: "limit.media.documentMb",
  filesPerMessage: "limit.media.filesPerMessage",
  totalMb: "limit.media.totalMb",
} as const;

// Mirrors attachments.ts (client) + attachment_preprocessor.py (bridge). These
// stay equal across tiers by default — admin can tighten per tier later.
const MEDIA_DEFAULT: MediaLimits = {
  imageMb: 50,
  audioMb: 100,
  videoMb: 200,
  documentMb: 100,
  filesPerMessage: 10,
  totalMb: 300,
};

const UNLIMITED = -1;

// Entitlement defaults per tier. Starter is the PLG-constrained free tier (CLAUDE
// §2.6 "1 agent"); OP Buff promises "Unlimited Slot Agent / Semua Role"; Guild
// Master is enterprise-unlimited. Trial is mapped to op_buff (full features).
export const LIMIT_DEFAULTS: Record<EffectiveTier, Omit<UserLimits, "tier">> = {
  starter: { maxAgents: 1, maxChannels: 2, maxSkills: 10, media: { ...MEDIA_DEFAULT } },
  op_buff: { maxAgents: UNLIMITED, maxChannels: UNLIMITED, maxSkills: UNLIMITED, media: { ...MEDIA_DEFAULT } },
  guild_master: { maxAgents: UNLIMITED, maxChannels: UNLIMITED, maxSkills: UNLIMITED, media: { ...MEDIA_DEFAULT } },
};

/**
 * The tier whose limits apply to a user. A paid op_buff/guild_master sub wins; an
 * ACTIVE trial (onboarded, not lapsed, no active sub) gets op_buff limits so the
 * trial is genuinely "full features"; everyone else is starter.
 */
export async function resolveLimitsTier(userId: string): Promise<EffectiveTier> {
  const sub = await resolveSubscription(userId);
  if (sub.tier === "op_buff" || sub.tier === "guild_master") return sub.tier;
  try {
    const access = await resolveAccessState(userId);
    if (access.trial && access.trial.daysLeft > 0 && !access.locked && !access.hasActiveSub)
      return "op_buff";
  } catch {
    // fall through to starter on any trial-resolution hiccup
  }
  return "starter";
}

/** Resolve a user's effective limits (tier defaults overlaid with admin per-tier
 *  overrides). Never throws — a DB hiccup falls back to the tier defaults so the
 *  enforcement layer degrades to the marketing baseline rather than breaking. */
export async function resolveUserLimits(userId: string): Promise<UserLimits> {
  const tier = await resolveLimitsTier(userId);
  const d = LIMIT_DEFAULTS[tier];
  const scope = { tier };
  try {
    const [
      maxAgents,
      maxChannels,
      maxSkills,
      imageMb,
      audioMb,
      videoMb,
      documentMb,
      filesPerMessage,
      totalMb,
    ] = await Promise.all([
      resolveSetting(LIMIT_KEYS.maxAgents, d.maxAgents, scope),
      resolveSetting(LIMIT_KEYS.maxChannels, d.maxChannels, scope),
      resolveSetting(LIMIT_KEYS.maxSkills, d.maxSkills, scope),
      resolveSetting(LIMIT_KEYS.imageMb, d.media.imageMb, scope),
      resolveSetting(LIMIT_KEYS.audioMb, d.media.audioMb, scope),
      resolveSetting(LIMIT_KEYS.videoMb, d.media.videoMb, scope),
      resolveSetting(LIMIT_KEYS.documentMb, d.media.documentMb, scope),
      resolveSetting(LIMIT_KEYS.filesPerMessage, d.media.filesPerMessage, scope),
      resolveSetting(LIMIT_KEYS.totalMb, d.media.totalMb, scope),
    ]);
    return {
      tier,
      maxAgents,
      maxChannels,
      maxSkills,
      media: { imageMb, audioMb, videoMb, documentMb, filesPerMessage, totalMb },
    };
  } catch {
    return { tier, ...d };
  }
}

/** True when a count limit means "no cap". */
export function isUnlimited(limit: number): boolean {
  return limit < 0;
}

/**
 * True when the user is at/over their per-tier installed-skill cap. The portal
 * billing routes call this before a NEW skill purchase (the caller checks
 * already-owned first, so a re-purchase is never blocked). Counts container_skill
 * rows (bundled engine skills are not stored there, so only installed/purchased
 * skills count). Unlimited (-1) is never at cap.
 */
export async function isAtSkillCap(userId: string): Promise<boolean> {
  const limits = await resolveUserLimits(userId);
  if (limits.maxSkills < 0) return false;
  const [row] = await db
    .select({ n: count() })
    .from(containerSkills)
    .where(eq(containerSkills.userId, userId));
  return (row?.n ?? 0) >= limits.maxSkills;
}
