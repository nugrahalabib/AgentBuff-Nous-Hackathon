"use client";

/**
 * Terminal-style input history navigation for the chat composer.
 *
 * Ported from Hermes Desktop's `useInputHistory` (Reff/UI HERMES/
 * hermes-desktop-main/src/renderer/src/screens/Chat/hooks/useInputHistory.ts)
 * with two web-specific upgrades:
 *
 *   1. **Per-session localStorage persistence** — history survives across
 *      page reload + session switch. Desktop app's RAM-only hook loses
 *      everything on quit; web needs persistence so the chief's "↑ to
 *      re-send last message" muscle memory works after refresh.
 *
 *   2. **Capacity cap (50 entries / session)** + dedup-last to prevent
 *      `agentbuff:app:input-hist:*` keys from growing unbounded if the
 *      chief sends a lot of messages.
 *
 * Behavior (matches Hermes Desktop semantics exactly):
 *   - ↑ at single-line input → recall PREVIOUS sent message. On the
 *     FIRST press, the current draft is captured so subsequent ↓ past
 *     the newest entry can restore it.
 *   - ↓ while navigating → cycle FORWARD; one step past the newest
 *     restores the saved draft and exits navigation mode.
 *   - Index `-1` means "fresh edit, not navigating". `push()` resets
 *     index to `-1` so the next ↑ starts from the most recent entry.
 *   - Multi-line input (contains `\n`) → caller should skip the hook
 *     entirely so native cursor-movement isn't hijacked.
 *
 * State is held in refs (not React state) so arrow-key presses don't
 * cause re-renders — only `applyText` re-renders the textarea via
 * React's controlled input.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const HISTORY_LIMIT = 50;
const STORAGE_PREFIX = "agentbuff:app:input-hist:";

interface UseInputHistoryArgs {
  /** Active session key — history is partitioned per session so a switch
   *  doesn't leak the prior session's messages into this session's
   *  recall buffer. */
  sessionKey: string;
  /** Current draft text — used to save the in-progress draft on first ↑. */
  currentInput: string;
  /** Apply recalled history (or restored draft) text to the textarea. */
  applyText: (text: string) => void;
}

interface UseInputHistoryResult {
  /** Append a freshly-sent message to history; resets cursor. */
  push: (text: string) => void;
  /** Move backwards through history. Returns false if nothing to recall. */
  recallPrev: () => boolean;
  /** Move forwards through history. Returns false if not navigating. */
  recallNext: () => boolean;
  /** True if the user is currently navigating history (not editing fresh). */
  isNavigating: () => boolean;
  /** Number of entries — caller uses this to decide whether to engage. */
  size: () => number;
}

function readStorage(sessionKey: string): string[] {
  if (typeof window === "undefined" || !sessionKey) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop any non-string entries (corruption / legacy).
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeStorage(sessionKey: string, history: string[]): void {
  if (typeof window === "undefined" || !sessionKey) return;
  try {
    const trimmed = history.slice(-HISTORY_LIMIT);
    window.localStorage.setItem(
      STORAGE_PREFIX + sessionKey,
      JSON.stringify(trimmed),
    );
  } catch {
    // Quota / privacy mode — silent fall-through. Worst case history
    // works in-memory for the current page lifetime; reload resets.
  }
}

export function useInputHistory({
  sessionKey,
  currentInput,
  applyText,
}: UseInputHistoryArgs): UseInputHistoryResult {
  const [history, setHistory] = useState<string[]>(() =>
    readStorage(sessionKey),
  );
  const indexRef = useRef(-1);
  const draftRef = useRef("");

  // Re-hydrate when sessionKey changes (sidebar session switch).
  useEffect(() => {
    setHistory(readStorage(sessionKey));
    indexRef.current = -1;
    draftRef.current = "";
  }, [sessionKey]);

  // Persist on every history change.
  useEffect(() => {
    writeStorage(sessionKey, history);
  }, [sessionKey, history]);

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      // Dedup against the most recent entry — pressing send twice on the
      // same text shouldn't double-fill the recall buffer.
      if (prev.length > 0 && prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed];
      return next.length > HISTORY_LIMIT
        ? next.slice(-HISTORY_LIMIT)
        : next;
    });
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  const recallPrev = useCallback((): boolean => {
    if (history.length === 0) return false;
    const cur = indexRef.current;
    const nextIdx = cur === -1 ? history.length - 1 : Math.max(0, cur - 1);
    if (cur === -1) draftRef.current = currentInput;
    indexRef.current = nextIdx;
    applyText(history[nextIdx]);
    return true;
  }, [history, currentInput, applyText]);

  const recallNext = useCallback((): boolean => {
    const cur = indexRef.current;
    if (cur === -1) return false;
    if (cur < history.length - 1) {
      indexRef.current = cur + 1;
      applyText(history[cur + 1]);
    } else {
      indexRef.current = -1;
      applyText(draftRef.current);
    }
    return true;
  }, [history, applyText]);

  const isNavigating = useCallback(() => indexRef.current !== -1, []);
  const size = useCallback(() => history.length, [history.length]);

  return { push, recallPrev, recallNext, isNavigating, size };
}
