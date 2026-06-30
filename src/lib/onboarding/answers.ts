// Shared client-side shape for the onboarding wizard answers, plus the two
// transforms that bridge it to the API's `answers` jsonb (which stores arrays
// as comma-separated strings, matching the canonical text columns + the
// onboarding PATCH zod schema).
//
// Used by both the server page (hydrate initial answers from GET) and the
// client wizard (collect + PATCH).

export interface OnboardingAnswers {
  nickname: string;
  /** YYYY-MM-DD */
  dob: string;
  /** Known city id OR a custom typed value (SelectWithOther). */
  city: string;
  /** Country id (locations.ts) OR a custom typed value. */
  country: string;
  /** IANA timezone, captured from the browser at mount. */
  timezone: string;
  referralSource: string;
  role: string;
  industryIds: string[];
  businessName: string;
  /** Study program (students only). */
  jurusan: string;
  teamSize: string;
  interestIds: string[];
  /** Auto-derived from goals + role (deriveArchetype) — no longer user-picked. */
  archetype: string;
  agentName: string;
  agentEmoji: string;
  /** Speaking-style id (persona-options TONES). */
  tone: string;
  /** How the user wants the agent to address them (USER_TITLES ids / free text), up to 3. */
  userTitles: string[];
  /** Personality trait ids (persona-options PERSONALITY_TRAITS). */
  personality: string[];
  /** Language preference id (persona-options LANGUAGES). */
  language: string;
  /** Emoji-usage id (persona-options EMOJI_USAGE). */
  emojiUsage: string;
  /** Response-length id (persona-options RESPONSE_STYLES). */
  responseStyle: string;
  /** BYOK provider id (e.g. "gemini"). */
  modelProvider: string;
  /** Engine model slug the forged agent defaults to. */
  modelDefault: string;
}

export const EMPTY_ANSWERS: OnboardingAnswers = {
  nickname: "",
  dob: "",
  city: "",
  country: "",
  timezone: "",
  referralSource: "",
  role: "",
  industryIds: [],
  businessName: "",
  jurusan: "",
  teamSize: "",
  interestIds: [],
  archetype: "",
  agentName: "",
  agentEmoji: "",
  tone: "santai",
  userTitles: [],
  personality: [],
  language: "id",
  emojiUsage: "some",
  responseStyle: "balanced",
  modelProvider: "",
  modelDefault: "",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function csvToList(v: unknown): string[] {
  return str(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Hydrate the wizard from the API GET `answers` jsonb (CSV → arrays). */
export function fromAnswersPayload(
  raw: Record<string, unknown> | null | undefined,
): OnboardingAnswers {
  const a = raw ?? {};
  return {
    nickname: str(a.nickname),
    dob: str(a.dob),
    city: str(a.city),
    country: str(a.country),
    timezone: str(a.timezone),
    referralSource: str(a.referralSource),
    role: str(a.role),
    industryIds: csvToList(a.industryIds),
    businessName: str(a.businessName),
    jurusan: str(a.jurusan),
    teamSize: str(a.teamSize),
    interestIds: csvToList(a.interestIds),
    archetype: str(a.archetype),
    agentName: str(a.agentName),
    agentEmoji: str(a.agentEmoji),
    tone: str(a.tone) || "santai",
    userTitles: csvToList(a.userTitles),
    personality: csvToList(a.personality),
    language: str(a.language) || "id",
    emojiUsage: str(a.emojiUsage) || "some",
    responseStyle: str(a.responseStyle) || "balanced",
    modelProvider: str(a.modelProvider),
    modelDefault: str(a.modelDefault),
  };
}

/**
 * Serialize the wizard answers to the API PATCH `answers` payload. Arrays →
 * CSV, plus the derived fields the backend canonical columns want
 * (focus = primary interest, displayName mirrors nickname).
 */
export function toAnswersPayload(a: OnboardingAnswers): Record<string, string> {
  const payload: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (v && v.trim()) payload[k] = v.trim();
  };
  put("nickname", a.nickname);
  // displayName mirrors the call-name (full name is no longer collected).
  put("displayName", a.nickname);
  put("dob", a.dob);
  put("city", a.city);
  put("country", a.country);
  put("timezone", a.timezone);
  put("referralSource", a.referralSource);
  put("role", a.role);
  if (a.industryIds.length) payload.industryIds = a.industryIds.join(",");
  put("businessName", a.businessName);
  put("jurusan", a.jurusan);
  put("teamSize", a.teamSize);
  if (a.interestIds.length) {
    payload.interestIds = a.interestIds.join(",");
    // `focus` is the single canonical column an existing feature reads — feed
    // it the primary interest so it isn't left null.
    put("focus", a.interestIds[0]);
  }
  put("archetype", a.archetype);
  put("agentName", a.agentName);
  put("agentEmoji", a.agentEmoji);
  put("tone", a.tone);
  if (a.userTitles.length) payload.userTitles = a.userTitles.join(",");
  if (a.personality.length) payload.personality = a.personality.join(",");
  put("language", a.language);
  put("emojiUsage", a.emojiUsage);
  put("responseStyle", a.responseStyle);
  put("modelProvider", a.modelProvider);
  put("modelDefault", a.modelDefault);
  return payload;
}
