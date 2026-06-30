/**
 * B3 — Web Speech API wrapper for voice-to-text in the composer.
 *
 * Browser support: Chrome / Edge / modern Safari. Firefox does not ship
 * SpeechRecognition; `isSpeechRecognitionAvailable()` returns false there
 * and the mic button stays disabled with a tooltip explaining why.
 *
 * We use:
 *   - `interimResults = true` so the user sees their words live as they
 *     speak (textarea updates in realtime).
 *   - `continuous = true` so a pause doesn't end the session.
 *   - `lang` matched to the active i18n locale.
 *
 * No backend involved — entire flow is browser-local.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionAvailable(): boolean {
  return getCtor() !== null;
}

export type SpeechSession = {
  /** Stop the current recognition gracefully, finalizing partial results. */
  stop: () => void;
  /** Abort immediately and discard any partial. */
  abort: () => void;
};

export type SpeechCallbacks = {
  /** Called whenever the transcript changes — `transcript` is the full
   *  accumulated text since session start (interim + final). Callers
   *  REPLACE the textarea value with this rather than appending. */
  onTranscript: (transcript: string, isFinal: boolean) => void;
  /** Called when the recognition stops on its own (silence timeout etc.)
   *  or when stop() / abort() completes. Receives the final transcript so
   *  callers can persist it before the recognizer is torn down. */
  onEnd: (finalTranscript: string) => void;
  /** Called on a recognizer error. `code` is one of:
   *    "not-allowed" — mic permission denied
   *    "no-speech"   — user didn't say anything
   *    "network"     — network issue (Chrome relays speech to Google)
   *    "aborted"     — abort() was called (normal user cancel)
   *    "audio-capture" — no mic device
   *    "service-not-allowed" — browser blocked the API
   *    otherwise: passes through the raw `event.error` value. */
  onError: (code: string) => void;
};

/** Map our two-letter app locales to BCP-47 codes the SpeechRecognition
 *  API expects. Defaults to id-ID for unknown values. */
function bcp47(locale: string): string {
  if (locale === "en" || locale.startsWith("en-")) return "en-US";
  if (locale === "id" || locale.startsWith("id-")) return "id-ID";
  return locale.includes("-") ? locale : "id-ID";
}

/** Start a recognition session. Returns a handle with `stop`/`abort`
 *  controls. Throws if the API isn't available (caller should have
 *  guarded with `isSpeechRecognitionAvailable()` first). */
export function startSpeechRecognition(
  locale: string,
  cb: SpeechCallbacks,
): SpeechSession {
  const Ctor = getCtor();
  if (!Ctor) {
    throw new Error("SpeechRecognition is not available in this browser");
  }
  const rec = new Ctor();
  rec.lang = bcp47(locale);
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let lastTranscript = "";

  // Web Speech API contract: `event.results` is a SpeechRecognitionResultList
  // containing ALL results from session start, NOT a delta. Each event call
  // gives us the full state. So we REBUILD the transcript from scratch every
  // event — accumulating across events would duplicate finalized segments
  // (e.g. "Aku gantengAku gantengAku ganteng" — observed bug 2026-05-23).
  //
  // Reference: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionEvent/results
  // > "Returns a SpeechRecognitionResultList object representing all the speech
  // > recognition results for the current session." — emphasis on ALL.
  rec.onresult = (event: any) => {
    let finalPart = "";
    let interimPart = "";
    const results = event?.results;
    const len = results?.length ?? 0;
    for (let i = 0; i < len; i++) {
      const r = results[i];
      const alt = r?.[0];
      const text = (alt?.transcript ?? "") as string;
      if (r?.isFinal) {
        finalPart += text;
      } else {
        interimPart += text;
      }
    }
    const combined = (finalPart + interimPart).trim();
    if (combined !== lastTranscript) {
      lastTranscript = combined;
      cb.onTranscript(combined, /* isFinal */ false);
    }
  };

  rec.onerror = (event: any) => {
    const code: string = event?.error ?? "unknown";
    cb.onError(code);
  };

  rec.onend = () => {
    cb.onEnd(lastTranscript);
  };

  rec.start();

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* idempotent */
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* idempotent */
      }
    },
  };
}
