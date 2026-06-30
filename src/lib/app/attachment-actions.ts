/**
 * Shared attachment-action helpers — download + open-in-new-tab for any
 * blob/data/HTTPS URL. Used by image lightbox, audio player, video player,
 * and document cards uniformly so behaviour stays consistent across all
 * media types.
 *
 * Implementation notes:
 *   * Download uses the `<a download="filename">` trick that works for
 *     blob: + data: + same-origin HTTPS URLs. Cross-origin URLs may
 *     ignore the download attribute (browser security) — for those
 *     we'd need a server-side proxy with Content-Disposition. /app
 *     attachments are all blob: (user uploads in current session), so
 *     this is sufficient.
 *   * Open-in-tab is just `window.open` with `noreferrer noopener` for
 *     security.
 */

/** Trigger a browser download of the given URL as `filename`. Works for
 *  blob: / data: / same-origin URLs. For cross-origin HTTP URLs (e.g.
 *  the bridge media-serve `http://127.0.0.1:38800/media/<token>/<file>`),
 *  the browser SECURITY POLICY ignores the `<a download>` attribute
 *  silently and navigates instead. To force a real download, append
 *  `?download=1` query — bridge's `media_serve.py` recognises this and
 *  responds with `Content-Disposition: attachment` which honours the
 *  download regardless of origin. Other servers ignore unknown query
 *  params so this is safe to always apply for cross-origin HTTP.
 *  Returns true if the download pipeline was triggered; false if the
 *  browser blocked it. */
export function downloadAttachment(url: string, filename: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const isCrossOriginHttp =
      /^https?:\/\//.test(url) &&
      typeof window !== "undefined" &&
      !!window.location?.origin &&
      !url.startsWith(window.location.origin);
    const finalUrl = isCrossOriginHttp
      ? url.includes("?")
        ? `${url}&download=1`
        : `${url}?download=1`
      : url;
    const a = document.createElement("a");
    a.href = finalUrl;
    a.download = filename || "attachment";
    a.rel = "noopener";
    // Append to body so Firefox honours the click (some versions ignore
    // clicks on detached anchors).
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    return false;
  }
}

/** Open the URL in a fresh tab. For PDFs, Chrome/Firefox render inline
 *  via their built-in PDF viewer — chief gets a real document viewer
 *  for free, no pdf.js dependency needed. */
export function openInNewTab(url: string): Window | null {
  if (typeof window === "undefined") return null;
  return window.open(url, "_blank", "noopener,noreferrer");
}

/** Format a `Date` (or epoch ms) into a stable human-readable "M:SS"
 *  duration string. Used by audio/video player UIs. */
export function formatPlaybackTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
