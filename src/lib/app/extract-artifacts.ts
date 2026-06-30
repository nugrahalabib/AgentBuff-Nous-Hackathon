/**
 * extract-artifacts.ts — aggregate every media artifact the agent + user have
 * produced across chat sessions into a flat, newest-first list for the Galeri
 * (Hasil Karya) gallery tab.
 *
 * Parity note: the official Nous desktop's Artifacts view regex-scans raw
 * message TEXT for markdown images / links / file paths (brittle, 3 kinds).
 * We do BETTER: we read our already-structured `ChatMessage.attachments`
 * (`AttachmentPart[]`), which the bridge + store already normalized into 4
 * typed kinds (image / audio / video / document) with a real `displayUrl`,
 * name and size. So the gallery is accurate (no guessing), covers 4 media
 * kinds, and reuses the same thumbnails + lightbox the chat already uses.
 *
 * Pure + side-effect-free → trivially testable, no store/React dependency.
 */
import type { AttachmentPart } from "@/lib/app/attachments";
import type { ChatMessage, SessionSummary } from "@/lib/app/store";

export type Artifact = AttachmentPart & {
  /** Stable React key — `${sessionKey}::${messageId}::${index}`. */
  id: string;
  sessionKey: string;
  sessionTitle: string;
  messageId: string;
  /** ms epoch — taken from the producing message. Drives newest-first sort. */
  createdAt: number;
  role: ChatMessage["role"];
};

/**
 * Is this media actually fetchable, or a dead/ephemeral reference we must NOT
 * show (no false hope)?
 *   - `data:`            → self-contained base64, always loads.
 *   - `/media/d/…`       → DURABLE store, persists past TTL + restart.
 *   - `/media/<token>/…` → legacy ephemeral token URL: dies after 24h or any
 *                          restart → almost certainly broken → HIDE it.
 *   - `blob:`            → tab-local, dead on a separate page → HIDE.
 */
export function isReachableMedia(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("data:")) return true;
  if (url.includes("/media/d/")) return true;
  return false;
}

/**
 * Walk loaded sessions + their messages, emit one Artifact per attachment.
 * Sessions whose transcript isn't loaded yet are simply skipped (the caller
 * lazily loads them and this recomputes). Dedupes by `displayUrl` per session
 * so the same generated image referenced twice doesn't double-list.
 */
export function extractArtifactsFromSessions(
  sessions: readonly SessionSummary[],
  messages: Record<string, ChatMessage[]>,
): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const list = messages[session.key];
    if (!list || list.length === 0) continue;
    const title = session.title?.trim() || "Tanpa judul";
    for (const msg of list) {
      if (msg.deleted) continue;
      const atts = msg.attachments;
      if (!atts || atts.length === 0) continue;
      atts.forEach((att, idx) => {
        // Don't surface dead/ephemeral media — it would just be a broken tile
        // (false hope). Only durable + inline media is shown.
        if (!isReachableMedia(att.displayUrl)) return;
        const dedupKey = `${session.key}::${att.displayUrl}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        out.push({
          ...att,
          id: `${session.key}::${msg.id}::${idx}`,
          sessionKey: session.key,
          sessionTitle: title,
          messageId: msg.id,
          // Per-message timestamps aren't reliably supplied on history
          // rehydrate (the store falls back to Date.now() → everything looked
          // "baru saja"). The session's last-active time is reliable + a good
          // proxy for when its media was produced.
          createdAt: session.updatedAt ?? msg.createdAt,
          role: msg.role,
        });
      });
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
