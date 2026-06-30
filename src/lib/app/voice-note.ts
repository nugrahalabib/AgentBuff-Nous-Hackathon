/**
 * Voice Note recorder — wraps the browser MediaRecorder API to capture an
 * audio Blob the user can attach as a chat message (parallel to mic
 * dictation which writes live text into the textarea).
 *
 * Why a separate module from `speech.ts`:
 *   * `speech.ts` uses SpeechRecognition → real-time text-to-textarea,
 *     no file produced, output is plain TEXT.
 *   * `voice-note.ts` uses MediaRecorder → produces an audio FILE (Blob)
 *     the user sends as an attachment. The bridge's multimodal plugin
 *     (v3.0.0) then runs the universal STT chain on it via the same
 *     path as a paperclip-uploaded audio file.
 *
 * Both flows need `microphone=(self)` in Permissions-Policy + user grant
 * via the browser's address-bar lock-icon prompt.
 *
 * Browser support: MediaRecorder is in every modern Chrome / Edge /
 * Firefox / Safari (16.4+). We probe MIME support and pick the best
 * format the browser exposes — preferring `audio/webm;codecs=opus`
 * because it gives Telegram/WhatsApp-style VN quality at ~30kbps.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type VoiceNoteRecorder = {
  /** Stop recording. Returns the captured Blob (or null on error). */
  stop: () => Promise<Blob | null>;
  /** Discard recording — no Blob returned, no callbacks fire afterwards. */
  cancel: () => void;
  /** MIME type the underlying MediaRecorder is using. Set lazily on
   *  first chunk; may be empty until then. */
  getMimeType: () => string;
  /** Recording start timestamp (ms since epoch) — caller computes
   *  duration off this for the live timer. */
  startedAt: number;
};

export type VoiceNoteCallbacks = {
  /** Recording stopped naturally (e.g. duration cap exceeded) — receives
   *  the final Blob. NOT fired for cancel() / explicit stop(). */
  onAutoStop?: (blob: Blob) => void;
  /** Permission denied / no mic / recorder error. `code`:
   *    "not-allowed"  — user clicked Deny on browser prompt
   *    "no-device"    — no mic available
   *    "policy"       — Permissions-Policy blocks (site config issue)
   *    "not-supported" — browser doesn't have MediaRecorder
   *    "generic"      — anything else (raw error in .message)
   */
  onError: (code: string, message?: string) => void;
};

/** Maximum recording length before we auto-stop. Bumped 2026-05-23 to
 *  30 minutes — chief asked for liberal limits matching channel apps.
 *  WhatsApp Web caps at 5 min, Telegram VN at ~9, Discord at ~10. Our
 *  30 min comfortably covers podcast clips + long voice messages. */
export const MAX_VN_DURATION_MS = 30 * 60 * 1000;

/** Hard cap on bytes — mirrors `MAX_AUDIO_BYTES` in attachments.ts so
 *  the recorder never produces something the validator will reject.
 *  Bumped to 100 MB to match the new attachments cap. */
export const MAX_VN_BYTES = 100 * 1024 * 1024; // 100 MB

/** Pick the best Opus-capable MIME the browser supports. Falls through
 *  to plain webm or mp4 if none of the preferred options work. */
export function pickRecorderMimeType(): string {
  if (typeof window === "undefined") return "";
  const MR = (window as any).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/aac",
  ];
  for (const mime of candidates) {
    try {
      if (MR.isTypeSupported(mime)) return mime;
    } catch {
      // some browsers throw on bad input — keep walking
    }
  }
  return "";
}

/** Pick the right file extension for a given MIME so the resulting
 *  File has a sensible name (matters for the bridge's MIME sniffing in
 *  attachment_preprocessor.py). */
export function fileExtensionForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "m4a";
  if (m.includes("aac")) return "aac";
  if (m.includes("wav")) return "wav";
  return "webm"; // safe default
}

export function isVoiceNoteSupported(): boolean {
  if (typeof window === "undefined") return false;
  const MR = (window as any).MediaRecorder;
  const md = (window.navigator as any)?.mediaDevices;
  return Boolean(MR && md && typeof md.getUserMedia === "function");
}

/** Start a recording session. Returns the controller (stop / cancel /
 *  introspection). Throws synchronously if MediaRecorder isn't available;
 *  permission errors land in `cb.onError`.
 */
export async function startVoiceNoteRecording(
  cb: VoiceNoteCallbacks,
): Promise<VoiceNoteRecorder | null> {
  if (!isVoiceNoteSupported()) {
    cb.onError("not-supported");
    return null;
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // VN-quality defaults — voice band, mono, balance size vs clarity.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err: any) {
    const name = String(err?.name || "");
    if (name === "NotAllowedError" || name === "SecurityError") {
      // SecurityError = Permissions-Policy block. NotAllowedError = user
      // denied at browser prompt OR mic disabled at OS level.
      cb.onError(name === "SecurityError" ? "policy" : "not-allowed", err?.message);
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      cb.onError("no-device", err?.message);
    } else {
      cb.onError("generic", err?.message || String(err));
    }
    return null;
  }

  const mimeType = pickRecorderMimeType();
  let recorder: any;
  try {
    recorder = new (window as any).MediaRecorder(
      stream,
      mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined,
    );
  } catch (err: any) {
    // Browser rejected the MIME (rare since we probe support upfront).
    stream.getTracks().forEach((t) => t.stop());
    cb.onError("generic", err?.message || "MediaRecorder construction failed");
    return null;
  }

  const chunks: Blob[] = [];
  let cancelled = false;
  let autoStopped = false;
  let stopResolver: ((blob: Blob | null) => void) | null = null;

  recorder.ondataavailable = (event: any) => {
    const data: Blob | undefined = event?.data;
    if (!data || data.size === 0) return;
    chunks.push(data);
  };

  recorder.onstop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    if (cancelled) {
      stopResolver?.(null);
      stopResolver = null;
      return;
    }
    // CRITICAL: Use the literal MIME we REQUESTED, not `recorder.mimeType`.
    // Chrome's MediaRecorder strips the `;codecs=opus` parameter from the
    // reported mimeType — so a blob built with `recorder.mimeType` ends up
    // as plain `audio/webm` which HTMLMediaElement on a Blob URL refuses
    // to decode (MediaError.code=4 SRC_NOT_SUPPORTED).
    //
    // Evidence:
    //   - https://media-codings.com/articles/recording-cross-browser-compatible-media
    //     ("Chrome fails to include opus in the resulting blob type")
    //   - https://github.com/w3c/mediacapture-record/issues/194
    //     (mimeType ambiguity discussion)
    //   - MDN Web Dictaphone example doesn't trust recorder.mimeType either:
    //     https://github.com/mdn/dom-examples/blob/main/media/web-dictaphone/scripts/app.js
    //
    // Pin the literal we requested at construction. Fall back to a safe
    // default if pickRecorderMimeType found nothing (very old browser).
    const blobMime = mimeType || "audio/webm;codecs=opus";
    const blob = new Blob(chunks, { type: blobMime });
    // Enforce size cap NOW (post-stop) instead of via per-chunk accounting
    // (which required timeslice — see comments below).
    if (blob.size > MAX_VN_BYTES) {
      autoStopped = true;
    }
    if (autoStopped) {
      cb.onAutoStop?.(blob);
    }
    stopResolver?.(blob);
    stopResolver = null;
  };

  // Call `start()` with NO timeslice argument. This is the canonical pattern
  // from MDN Web Dictaphone, react-media-recorder (589★), and RecordRTC
  // (6,893★). Timeslice causes `dataavailable` to fire per-chunk which we
  // don't need, AND has historically exposed adjacent bugs:
  //   * Mozilla #1581203: empty chunks on Windows under load
  //   * Chromium #642012: missing SeekHead/Cues in concatenated WebM
  //   * Mozilla #1664010: Opus sample-start corruption with timeslice
  //
  // Per W3C spec the concat MUST be playable — but in practice every
  // proven recording library defaults to single-blob (no timeslice) for
  // record-then-play workflows.
  try {
    recorder.start();
  } catch (err: any) {
    stream.getTracks().forEach((t) => t.stop());
    cb.onError("generic", err?.message || "recorder.start failed");
    return null;
  }

  const startedAt = Date.now();

  // Duration cap — auto-stop after MAX_VN_DURATION_MS.
  const durationTimer = window.setTimeout(() => {
    if (recorder.state === "recording" && !autoStopped) {
      autoStopped = true;
      try {
        recorder.stop();
      } catch {
        /* idempotent */
      }
    }
  }, MAX_VN_DURATION_MS);

  return {
    startedAt,
    // Return what the BLOB will be tagged with (the literal we requested),
    // not `recorder.mimeType` (Chrome strips codecs param — see onstop).
    getMimeType: () => mimeType || "audio/webm;codecs=opus",
    stop: async (): Promise<Blob | null> => {
      window.clearTimeout(durationTimer);
      if (recorder.state !== "recording" && chunks.length === 0) {
        return null;
      }
      return new Promise<Blob | null>((resolve) => {
        stopResolver = resolve;
        try {
          recorder.stop();
        } catch {
          // Already stopped — onstop has already fired (or won't).
          resolve(null);
        }
      });
    },
    cancel: () => {
      window.clearTimeout(durationTimer);
      cancelled = true;
      try {
        recorder.stop();
      } catch {
        /* idempotent */
      }
      stream?.getTracks().forEach((t) => t.stop());
    },
  };
}

/** Convert a recorded Blob to a `File` with a friendly timestamped name
 *  so it shows nicely in the draft chip + cache. */
export function voiceNoteBlobToFile(blob: Blob): File {
  const ext = fileExtensionForMime(blob.type);
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const name = `voice-note-${stamp}.${ext}`;
  return new File([blob], name, { type: blob.type || `audio/${ext}` });
}

/** Format ms as `M:SS` for the live timer + final duration display. */
export function formatVnDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
