/**
 * src/lib/app/client-state-reset.ts
 *
 * Wipe ALL AgentBuff client-side state from the current browser on an account
 * switch, so one user's residual /app data — unsent drafts, private per-message
 * notes/annotations, reactions, command/input history, the active-session
 * pointer, default agent id, onboarding profile, and UI prefs — can never
 * rehydrate under a DIFFERENT account on a shared device.
 *
 * Why this exists: the live /app keys use a COLON namespace
 * ("agentbuff:app:*", "agentbuff:reactions:*"), but the old pre-login cleanup
 * matched only the legacy DOT prefix ("agentbuff."), so every colon key
 * survived a logout+login on a shared browser — a confirmed cross-user content
 * bleed (cross-user-isolation audit 2026-06-15). Matching the bare "agentbuff"
 * prefix covers BOTH namespaces (dot legacy + colon live).
 *
 * Call on BOTH login (defensive — wipes a residue even if the previous user
 * never logged out cleanly) AND logout (proactive — sensitive content is gone
 * the moment the user leaves the shared machine). The OAuth login/logout flow
 * is a full-page navigation, so in-memory module caches (annotations/reactions
 * singletons, the Zustand store) re-initialise from the now-empty localStorage
 * on the next load — a localStorage wipe alone is sufficient.
 */
export function clearAgentbuffClientState(): void {
  if (typeof window === "undefined") return;
  try {
    const ls = window.localStorage;
    // Iterate backwards: removeItem shifts indices, so a forward loop would
    // skip keys.
    for (let i = ls.length - 1; i >= 0; i--) {
      const key = ls.key(i);
      if (key && key.startsWith("agentbuff")) ls.removeItem(key);
    }
  } catch {
    // localStorage unavailable (private mode / storage disabled) — nothing to
    // wipe, and never let cleanup throw into a login/logout handler.
  }
}
