/**
 * Reactions module — emoji-pickable reactions on chat bubbles.
 *
 * Mirrors Telegram + Discord reaction UX:
 *   - Hover bubble → emoji-picker popover appears
 *   - Click emoji → adds it as a reaction chip below the bubble
 *   - Click an existing chip → toggles (add if not yours, remove if yours)
 *   - Chip shows `<emoji> <count>` with cyan accent if current user reacted
 *
 * Persistence:
 *   Per-session reactions are stored in `localStorage` keyed by
 *   `agentbuff:reactions:<sessionKey>` as a serialized
 *   `Record<messageId, Record<emoji, string[]>>` where the inner array
 *   is the list of user IDs that reacted.
 *
 *   Future: bridge `reactions.set` RPC syncs reactions to ALL channels
 *   (when /app reacts on a message, bridge calls
 *   `adapter.add_reaction()` on the channel adapter where the original
 *   message lives, propagating to Telegram/Discord). For Iter 6 we
 *   ship the client-side persistence first; bridge sync is additive.
 *
 * Default emoji set: matches Telegram's most-used 12 + Discord parity.
 */

export const DEFAULT_REACTION_EMOJI = [
  "👍",
  "❤️",
  "🔥",
  "👏",
  "🎉",
  "😂",
  "🤔",
  "😢",
  "✅",
  "❌",
  "⏰",
  "🚀",
] as const;

const STORAGE_PREFIX = "agentbuff:reactions:";

export type ReactionMap = Record<string, Record<string, string[]>>;
/** Inner: messageId → emoji → list of userIds who reacted. */

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${sessionKey}`;
}

/** Read the full reaction map for a session from localStorage.
 *  Returns empty object on miss or parse error. */
export function loadReactions(sessionKey: string): ReactionMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(sessionKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ReactionMap;
  } catch {
    /* swallow */
  }
  return {};
}

/** Write the reaction map back to localStorage. Silent-fail on quota
 *  exceeded (rare since reactions are tiny). */
function saveReactions(sessionKey: string, map: ReactionMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(sessionKey),
      JSON.stringify(map),
    );
  } catch {
    /* swallow */
  }
}

/** Toggle a reaction by user. If `userId` already reacted with this
 *  emoji, removes them. Otherwise adds them. Returns the updated map
 *  (call `saveReactions` to persist). */
export function toggleReaction(
  map: ReactionMap,
  messageId: string,
  emoji: string,
  userId: string,
): ReactionMap {
  const msgEntry = { ...(map[messageId] ?? {}) };
  const userList = msgEntry[emoji] ?? [];
  const idx = userList.indexOf(userId);
  if (idx >= 0) {
    const next = userList.filter((u) => u !== userId);
    if (next.length === 0) {
      const { [emoji]: _removed, ...rest } = msgEntry;
      return { ...map, [messageId]: rest };
    }
    msgEntry[emoji] = next;
  } else {
    msgEntry[emoji] = [...userList, userId];
  }
  return { ...map, [messageId]: msgEntry };
}

/** Convenience: load → toggle → save. */
export function persistToggleReaction(
  sessionKey: string,
  messageId: string,
  emoji: string,
  userId: string,
): ReactionMap {
  const updated = toggleReaction(
    loadReactions(sessionKey),
    messageId,
    emoji,
    userId,
  );
  saveReactions(sessionKey, updated);
  return updated;
}

/** Wire-event broadcast for live updates within the same tab. Other
 *  components subscribe via `subscribeReactions(sessionKey, cb)`. */
type Listener = (map: ReactionMap) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribeReactions(
  sessionKey: string,
  cb: Listener,
): () => void {
  if (!listeners.has(sessionKey)) listeners.set(sessionKey, new Set());
  listeners.get(sessionKey)!.add(cb);
  return () => {
    listeners.get(sessionKey)?.delete(cb);
  };
}

function notify(sessionKey: string, map: ReactionMap): void {
  listeners.get(sessionKey)?.forEach((cb) => cb(map));
}

/** Public action — used by ReactionPicker + MessageReactions.
 *  Optionally fires bridge `reactions.set` RPC for cross-channel sync
 *  (Telegram/Discord) and live broadcast to other /app instances. */
export function applyReaction(
  sessionKey: string,
  messageId: string,
  emoji: string,
  userId: string,
): void {
  const before = loadReactions(sessionKey);
  const wasReacted =
    (before[messageId]?.[emoji] ?? []).includes(userId);
  const updated = toggleReaction(before, messageId, emoji, userId);
  // Save BEFORE notify so subscribers see the new state.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        `agentbuff:reactions:${sessionKey}`,
        JSON.stringify(updated),
      );
    } catch {
      /* swallow */
    }
  }
  notify(sessionKey, updated);
  // Fire-and-forget bridge sync — non-blocking so UI feels instant.
  // Reaches bridge via the gateway client attached in gateway-provider.
  try {
    // Lazy global import to avoid a hard React→non-React module dep.
    const w = window as unknown as {
      __agentbuffBridgeRequest?: (
        method: string,
        params: unknown,
      ) => Promise<unknown>;
    };
    if (typeof w.__agentbuffBridgeRequest === "function") {
      void w.__agentbuffBridgeRequest("reactions.set", {
        sessionKey,
        messageId,
        emoji,
        userId,
        add: !wasReacted,
      });
    }
  } catch {
    /* swallow */
  }
}

/** Apply a reaction update received from another /app instance via the
 *  bridge `reaction.changed` broadcast. Updates localStorage + notifies
 *  subscribers but does NOT re-broadcast. */
export function receiveReactionEvent(
  sessionKey: string,
  messageId: string,
  emoji: string,
  userId: string,
  add: boolean,
): void {
  const before = loadReactions(sessionKey);
  const users = before[messageId]?.[emoji] ?? [];
  const isReacted = users.includes(userId);
  // Only mutate if state actually changes (avoid loop with origin client)
  if (add === isReacted) return;
  const updated = toggleReaction(before, messageId, emoji, userId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        `agentbuff:reactions:${sessionKey}`,
        JSON.stringify(updated),
      );
    } catch {
      /* swallow */
    }
  }
  notify(sessionKey, updated);
}
