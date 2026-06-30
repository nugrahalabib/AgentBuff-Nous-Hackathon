/**
 * B5 — Inline message annotations. Single-user, per-thread notes that
 * stick on a specific message id. Persisted to localStorage so they
 * survive a refresh; NOT synced to the bridge (no engine modify, no DB
 * dependency). Storage shape:
 *
 *   {
 *     "<sessionKey>": {
 *       "<messageId>": {
 *         note: string,
 *         createdAt: number,
 *         updatedAt: number
 *       }
 *     }
 *   }
 *
 * UI integration lives in chat-thread.tsx — the AnnotationButton hover
 * action + the per-message annotation badge.
 */
const STORAGE_KEY = "agentbuff:app:annotations:v1";
const NOTE_MAX_LENGTH = 2000;

export type Annotation = {
  note: string;
  createdAt: number;
  updatedAt: number;
};

type Store = Record<string, Record<string, Annotation>>;

let cache: Store | null = null;

function read(): Store {
  if (cache) return cache;
  if (typeof window === "undefined") {
    cache = {};
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cache = parsed as Store;
      return cache;
    }
  } catch {
    /* fall through to empty */
  }
  cache = {};
  return cache;
}

function write(store: Store): void {
  cache = store;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota — non-fatal. UI already surfaces a generic "penyimpanan
    // browser penuh" toast for draft persistence; annotation save failures
    // are rarer + smaller, just drop silently.
  }
}

/** Cross-tab sync: when another tab updates annotations, invalidate the
 *  cache so the next read picks up the change. UI re-reads after edit
 *  via the subscriber list below. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cache = null;
    notifySubscribers();
  });
}

// Tiny pub/sub so React components can re-render when annotations change.
// Zustand's React-friendly API would be heavier than needed for one key.
type Subscriber = () => void;
const subscribers = new Set<Subscriber>();
function notifySubscribers() {
  subscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener crashed — keep others going */
    }
  });
}

export function subscribeAnnotations(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getAnnotation(
  sessionKey: string,
  messageId: string,
): Annotation | null {
  const store = read();
  return store[sessionKey]?.[messageId] ?? null;
}

export function listAnnotationsForSession(
  sessionKey: string,
): Record<string, Annotation> {
  const store = read();
  return store[sessionKey] ?? {};
}

export function setAnnotation(
  sessionKey: string,
  messageId: string,
  note: string,
): void {
  const trimmed = note.trim().slice(0, NOTE_MAX_LENGTH);
  if (!trimmed) {
    deleteAnnotation(sessionKey, messageId);
    return;
  }
  const store = { ...read() };
  const existing = store[sessionKey]?.[messageId];
  const now = Date.now();
  store[sessionKey] = {
    ...(store[sessionKey] ?? {}),
    [messageId]: {
      note: trimmed,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
  write(store);
  notifySubscribers();
}

export function deleteAnnotation(sessionKey: string, messageId: string): void {
  const store = read();
  const sessionStore = store[sessionKey];
  if (!sessionStore || !(messageId in sessionStore)) return;
  const { [messageId]: _drop, ...rest } = sessionStore;
  void _drop;
  const nextStore = { ...store };
  if (Object.keys(rest).length === 0) {
    delete nextStore[sessionKey];
  } else {
    nextStore[sessionKey] = rest;
  }
  write(nextStore);
  notifySubscribers();
}

export const NOTE_MAX = NOTE_MAX_LENGTH;
