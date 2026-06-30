"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  AudioLines,
  Check,
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Lock,
  Mic,
  Paperclip,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { useAppStore } from "@/lib/app/store";
import { classifySessionSource } from "@/lib/app/session-utils";
import { useI18n } from "@/lib/i18n/context";
import { useInputHistory } from "@/lib/app/use-input-history";
import { LiveActivityBar } from "./live-activity-bar";
import {
  ACCEPTED_MIME_TYPES,
  MAX_FILES_PER_MESSAGE,
  extractTextFromFile,
  isTextLikeFile,
  prettyFileSize,
  revokeDraft,
  textExtractionToMarkdown,
  validateFiles,
  type AttachmentDraft,
  type AttachmentValidationError,
} from "@/lib/app/attachments";
import {
  isSpeechRecognitionAvailable,
  startSpeechRecognition,
  type SpeechSession,
} from "@/lib/app/speech";
import {
  formatVnDuration,
  isVoiceNoteSupported,
  startVoiceNoteRecording,
  voiceNoteBlobToFile,
  type VoiceNoteRecorder,
} from "@/lib/app/voice-note";
import { AudioPlayer } from "./attachment-player";
import { cn } from "@/lib/utils";

// B2 — File picker accepts images (attached as image parts) AND text-shaped
// files (inlined into the composer textarea as a fenced code block).
// Drag-drop + paste are not restricted by this attr; they fall through to
// validateFiles + the text-extraction path.
const ACCEPT_ATTR = [
  ...ACCEPTED_MIME_TYPES,
  "text/*",
  "application/json",
  "application/xml",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".sh",
  ".sql",
].join(",");

/** Bahasa Indonesia glosses for the most common Hermes slash commands.
 *  Falls back to the raw English description from `commands.catalog`
 *  for any command we haven't translated. Mirrors `slash-menu.tsx`. */
const BAHASA_GLOSS: Record<string, string> = {
  "/new": "Mulai sesi chat baru",
  "/reset": "Reset percakapan ini",
  "/model": "Ganti AI model yang dipakai",
  "/reasoning": "Atur level reasoning (none/low/medium/high)",
  "/personality": "Ganti persona agent",
  "/retry": "Ulangi pesan terakhir",
  "/undo": "Hapus pesan terakhir",
  "/status": "Lihat status sesi sekarang",
  "/stop": "Hentikan agent yang lagi jalan",
  "/steer": "Inject pesan setelah tool selesai",
  "/compress": "Kompres context (hemat token)",
  "/title": "Set/lihat judul sesi",
  "/resume": "Lanjut sesi sebelumnya",
  "/usage": "Lihat pemakaian token",
  "/help": "Daftar semua perintah",
  "/insights": "Analitik pemakaian (7 hari)",
  "/restart": "Restart container",
  "/update": "Update versi Hermes",
  "/approve": "Setujui command yang nunggu",
  "/deny": "Tolak command yang nunggu",
  "/thread": "Bikin thread baru",
  "/queue": "Antrekan prompt buat turn berikutnya",
  "/background": "Jalankan di background",
  "/skill": "Panggil skill (autocomplete)",
  "/clear": "Bersihkan transcript",
  "/forget": "Hapus N pesan terakhir",
  "/voice": "Toggle voice mode (mic + TTS)",
  "/reload-mcp": "Reload MCP servers",
  "/reload-skills": "Reload skills dari folder",
  "/sethome": "Set channel sebagai home",
};

export function ChatComposer({ compact = false }: { compact?: boolean } = {}) {
  const { t, locale } = useI18n();
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [attachErrors, setAttachErrors] = useState<
    AttachmentValidationError[]
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const [focused, setFocused] = useState(false);

  // B3 — Voice dictation state. `voiceActive` flips while the SpeechRecognition
  // session is open; `voiceError` flashes for a short tick when a permission
  // or device error fires.
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceSessionRef = useRef<SpeechSession | null>(null);
  // Snapshot of the textarea text taken AT the moment dictation starts.
  // Transcripts are appended onto this base so existing prose stays intact.
  const voiceBaseRef = useRef<string>("");

  const status = useAppStore((s) => s.status);
  const needsBrain = useAppStore((s) => s.needsBrain);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  // Channel-originated sessions are READ-ONLY in the web UI — replying here would
  // disrupt the live conversation happening in WhatsApp/Telegram/etc. The web is
  // monitor-only for those; only Web sessions are chattable here.
  // Select the raw source STRING (primitive — stable across renders); compute
  // the origin object in the render body. Returning an object straight from the
  // selector makes Zustand see a new snapshot every render → infinite loop.
  const activeSource = useAppStore((s) => {
    const sess = s.sessions.find((row) => row.key === s.activeSessionKey);
    return sess?.source ?? null;
  });
  const activeOrigin = classifySessionSource(activeSource);
  const channelLocked = activeOrigin.locked;
  // Text lives in the store (per-session, persisted) so tab reload, session
  // switch, and accidental navigation don't nuke in-progress prose.
  const text = useAppStore((s) => s.drafts[s.activeSessionKey] ?? "");
  const setDraft = useAppStore((s) => s.setDraft);
  const clearDraft = useAppStore((s) => s.clearDraft);

  // Terminal-style input history (↑/↓ recall) — ported from Hermes Desktop.
  // Per-session storage in localStorage so chief's "↑ to resend last
  // message" muscle memory survives refresh + session switch.
  const inputHistory = useInputHistory({
    sessionKey: activeKey,
    currentInput: text,
    applyText: useCallback(
      (next: string) => setDraft(activeKey, next),
      [activeKey, setDraft],
    ),
  });
  const sending = useAppStore((s) => s.sending[s.activeSessionKey] ?? false);
  const streaming = useAppStore(
    (s) => Boolean(s.streaming[s.activeSessionKey]),
  );
  const sendMessage = useAppStore((s) => s.sendMessage);
  const abortActive = useAppStore((s) => s.abortActive);
  // C4: surface draft-persistence failures so the user knows their pending
  // prose won't survive a reload (localStorage quota / Safari private / etc).
  const draftWarning = useAppStore((s) => s.draftPersistenceWarning);
  const clearDraftWarning = useAppStore((s) => s.clearDraftPersistenceWarning);

  // B3 — Voice dictation helpers. `stopVoice` is also wired to the global
  // Esc handler in handleKey via the textarea — see voiceActive branch.
  // HYDRATION-SAFE: availability is browser-only — compute it post-mount so a
  // server render (if this composer ever SSRs) matches the first client
  // render. Same fix as AppCommandCenter's mic button.
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => {
    setVoiceAvailable(isSpeechRecognitionAvailable());
  }, []);
  const stopVoice = useCallback(() => {
    voiceSessionRef.current?.stop();
  }, []);
  const startVoice = useCallback(() => {
    if (!voiceAvailable || voiceActive) return;
    setVoiceError(null);
    voiceBaseRef.current =
      useAppStore.getState().drafts[activeKey] ?? "";
    try {
      const session = startSpeechRecognition(locale, {
        onTranscript: (transcript) => {
          const base = voiceBaseRef.current;
          const joiner = base.trim() && transcript ? " " : "";
          setDraft(activeKey, base + joiner + transcript);
        },
        onEnd: () => {
          voiceSessionRef.current = null;
          setVoiceActive(false);
        },
        onError: (code) => {
          if (code === "aborted") return; // user cancelled, no error UI
          // Always log raw code to console so devtools shows the real
          // reason — `not-allowed` vs `service-not-allowed` vs `network`
          // mean very different things and the user-facing copy has to
          // match.
          // eslint-disable-next-line no-console
          console.warn(
            "[agentbuff] SpeechRecognition error code=%s. Locale=%s. "
              + "If code is 'not-allowed' AFTER granting mic permission, "
              + "refresh the page so the recognizer picks up the new state. "
              + "If code is 'service-not-allowed', your browser blocked the "
              + "API itself (Chrome enterprise policy, or Brave shields). "
              + "If code is 'network', the speech service can't be reached "
              + "(Chrome relays to Google's STT servers — proxy/firewall "
              + "blocks this). Use the paperclip 📎 to upload an audio "
              + "file instead.",
            code,
            locale,
          );
          if (code === "not-allowed") {
            setVoiceError(t.app.chat.composer.voiceErrorPermission);
          } else if (code === "service-not-allowed") {
            setVoiceError(t.app.chat.composer.voiceErrorService);
          } else if (code === "audio-capture") {
            setVoiceError(t.app.chat.composer.voiceErrorNoMic);
          } else if (code === "network") {
            setVoiceError(t.app.chat.composer.voiceErrorNetwork);
          } else if (code !== "no-speech") {
            setVoiceError(t.app.chat.composer.voiceErrorGeneric);
          }
        },
      });
      voiceSessionRef.current = session;
      setVoiceActive(true);
    } catch {
      setVoiceError(t.app.chat.composer.voiceErrorGeneric);
    }
  }, [voiceAvailable, voiceActive, locale, activeKey, setDraft, t]);

  // Auto-clear voice error after a few seconds so the inline pill doesn't
  // stick around forever.
  useEffect(() => {
    if (!voiceError) return;
    const id = window.setTimeout(() => setVoiceError(null), 4500);
    return () => window.clearTimeout(id);
  }, [voiceError]);

  // Abort voice on session change or component unmount so the recognizer
  // never outlives the composer.
  useEffect(() => {
    return () => {
      voiceSessionRef.current?.abort();
      voiceSessionRef.current = null;
    };
  }, []);
  useEffect(() => {
    voiceSessionRef.current?.abort();
    voiceSessionRef.current = null;
    setVoiceActive(false);
  }, [activeKey]);

  // VN (voice note) recorder state. Separate from B3 dictation: this
  // produces an audio FILE attachment that goes through the same
  // multimodal pipeline as a paperclip-uploaded audio (bridge calls the
  // STT chain in `media_providers.py::transcribe_audio_via_chain` →
  // injects `[The user sent a voice message~ "..."]` prefix).
  //
  // Flow:
  //   1. Click VN icon → request mic → recorder starts → panel opens
  //   2. Live timer ticks (1s interval) until user stops or 5min cap
  //   3. Stop → preview panel with play / delete / send buttons
  //   4. Send → blob converted to File → pushed through `validateFiles`
  //      into `drafts` → existing chip + send pipeline takes over
  // HYDRATION-SAFE: browser-only capability check, computed post-mount
  // (same rationale as voiceAvailable above).
  const [vnAvailable, setVnAvailable] = useState(false);
  useEffect(() => {
    setVnAvailable(isVoiceNoteSupported());
  }, []);
  const [vnState, setVnState] = useState<
    | { kind: "idle" }
    | { kind: "recording"; startedAt: number; elapsedMs: number }
    | { kind: "preview"; blob: Blob; mime: string; durationMs: number; previewUrl: string }
  >({ kind: "idle" });
  const [vnError, setVnError] = useState<string | null>(null);
  const vnRecorderRef = useRef<VoiceNoteRecorder | null>(null);
  const vnTickerRef = useRef<number | null>(null);
  // Audio playback in the preview state is owned by the shared
  // <AudioPlayer> component below — no ref needed here.

  const stopVnTicker = useCallback(() => {
    if (vnTickerRef.current !== null) {
      window.clearInterval(vnTickerRef.current);
      vnTickerRef.current = null;
    }
  }, []);

  const startVoiceNote = useCallback(async () => {
    if (!vnAvailable || vnState.kind !== "idle") return;
    setVnError(null);
    // Also abort live dictation if running — only one mic-using flow at a time.
    voiceSessionRef.current?.abort();
    voiceSessionRef.current = null;
    setVoiceActive(false);
    const recorder = await startVoiceNoteRecording({
      onError: (code, message) => {
        // eslint-disable-next-line no-console
        console.warn("[agentbuff] voice-note error", code, message);
        if (code === "not-allowed") {
          setVnError(t.app.chat.composer.voiceErrorPermission);
        } else if (code === "policy") {
          setVnError(t.app.chat.composer.voiceErrorPermission);
        } else if (code === "no-device") {
          setVnError(t.app.chat.composer.voiceErrorNoMic);
        } else if (code === "not-supported") {
          setVnError(t.app.chat.composer.vnUnsupported);
        } else {
          setVnError(t.app.chat.composer.voiceErrorGeneric);
        }
        setVnState({ kind: "idle" });
        stopVnTicker();
      },
      onAutoStop: (blob) => {
        // Hit duration or size cap mid-record — auto-promote to preview.
        stopVnTicker();
        const previewUrl = URL.createObjectURL(blob);
        const durationMs = Date.now() - (vnRecorderRef.current?.startedAt ?? Date.now());
        setVnState({
          kind: "preview",
          blob,
          mime: blob.type || "audio/webm",
          durationMs,
          previewUrl,
        });
      },
    });
    if (recorder === null) {
      // Error already surfaced via onError; nothing more to do.
      return;
    }
    vnRecorderRef.current = recorder;
    setVnState({ kind: "recording", startedAt: recorder.startedAt, elapsedMs: 0 });
    // Tick once per second to update the live timer.
    vnTickerRef.current = window.setInterval(() => {
      setVnState((prev) =>
        prev.kind === "recording"
          ? { ...prev, elapsedMs: Date.now() - prev.startedAt }
          : prev,
      );
    }, 250);
  }, [vnAvailable, vnState.kind, t, stopVnTicker]);

  const stopVoiceNote = useCallback(async () => {
    if (vnState.kind !== "recording") return;
    stopVnTicker();
    const recorder = vnRecorderRef.current;
    if (!recorder) {
      setVnState({ kind: "idle" });
      return;
    }
    const blob = await recorder.stop();
    vnRecorderRef.current = null;
    if (!blob || blob.size === 0) {
      setVnState({ kind: "idle" });
      return;
    }
    const previewUrl = URL.createObjectURL(blob);
    const durationMs = Date.now() - recorder.startedAt;
    setVnState({
      kind: "preview",
      blob,
      mime: blob.type || "audio/webm",
      durationMs,
      previewUrl,
    });
  }, [vnState.kind, stopVnTicker]);

  const cancelVoiceNote = useCallback(() => {
    stopVnTicker();
    vnRecorderRef.current?.cancel();
    vnRecorderRef.current = null;
    if (vnState.kind === "preview") {
      URL.revokeObjectURL(vnState.previewUrl);
    }
    setVnState({ kind: "idle" });
  }, [vnState, stopVnTicker]);

  /** Promote the recorded VN to a draft chip — reuses the standard
   *  attachment pipeline (validateFiles + setDrafts) so the rest of the
   *  send flow is identical to a paperclip-uploaded audio file. The
   *  preview blob URL is kept alive by attachments.ts (it owns the
   *  draft lifecycle), so we DON'T revoke it here. */
  const sendVoiceNote = useCallback(() => {
    if (vnState.kind !== "preview") return;
    const file = voiceNoteBlobToFile(vnState.blob);
    const { accepted, errors } = validateFiles([file], drafts);
    if (accepted.length > 0) {
      setDrafts((prev) => [...prev, ...accepted]);
    }
    if (errors.length > 0) {
      setAttachErrors(errors);
    }
    // validateFiles created its own previewUrl for the chip — revoke
    // the recorder's panel-level previewUrl since the chip owns the
    // file from here on.
    try {
      URL.revokeObjectURL(vnState.previewUrl);
    } catch {
      /* idempotent */
    }
    setVnState({ kind: "idle" });
  }, [vnState, drafts]);

  // Cleanup blob URL on unmount/cancel transitions.
  useEffect(() => {
    return () => {
      stopVnTicker();
      vnRecorderRef.current?.cancel();
      if (vnState.kind === "preview") {
        try {
          URL.revokeObjectURL(vnState.previewUrl);
        } catch {
          /* idempotent */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-clear vnError after a few seconds (same pattern as voiceError).
  useEffect(() => {
    if (!vnError) return;
    const id = window.setTimeout(() => setVnError(null), 5500);
    return () => window.clearTimeout(id);
  }, [vnError]);

  // Clear vnError when entering a fresh preview — stale error banner from
  // a previous record attempt shouldn't leak into the new preview.
  useEffect(() => {
    if (vnState.kind === "preview") {
      setVnError(null);
    }
  }, [vnState.kind]);
  // NOTE: VN audio playback (play/pause/seek/progress) is now owned by
  // the shared <AudioPlayer> component rendered in the preview JSX below.
  // The old playback effect + toggleVnPlayback callback that lived here
  // were retired 2026-05-23 in favour of single-source-of-truth audio UI
  // shared between composer preview AND in-chat audio attachments.

  /**
   * Diagnostic: log VN blob size + MIME when a recording lands in preview.
   * If the blob is tiny (<2KB) for a >1s recording, mic permission is
   * granted but no actual audio frames came through (silent mic, virtual
   * audio device issue, etc.). Console output helps chief debug from
   * DevTools without us needing to add UI for it.
   */
  useEffect(() => {
    if (vnState.kind !== "preview") return;
    // eslint-disable-next-line no-console
    console.info(
      "[agentbuff] VN recorded — size=%d bytes (%s), mime=%s, computedDuration=%dms",
      vnState.blob.size,
      (vnState.blob.size / 1024).toFixed(1) + " KB",
      vnState.mime,
      vnState.durationMs,
    );
    if (vnState.blob.size < 2048 && vnState.durationMs > 1000) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agentbuff] VN blob suspiciously small — mic likely captured silence. "
          + "Check Windows mic device + recording level + that no other app is "
          + "exclusively holding the mic.",
      );
    }
  }, [vnState]);

  // BYOK PHASE (Chief 2026-06-02): no "energy" currency yet — user bawa API
  // key & model sendiri. Energy footer/balance/low-energy/top-up dihapus dari
  // composer biar gak nyesatin. Akan balik pas skema energy launch.
  const lowEnergy = false;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const busy = sending || streaming;
  const [aborting, setAborting] = useState(false);

  useEffect(() => {
    if (!busy && aborting) setAborting(false);
  }, [busy, aborting]);
  useEffect(() => {
    setAborting(false);
  }, [activeKey]);

  // On session switch: text auto-follows the store's per-session draft, but
  // attachments stay local because File handles can't be persisted. Revoke
  // blob URLs for any drafts that were on the previous session so we don't
  // leak memory.
  useEffect(() => {
    setAttachErrors([]);
    setDrafts((prev) => {
      prev.forEach(revokeDraft);
      return [];
    });
  }, [activeKey]);

  useEffect(() => {
    return () => {
      drafts.forEach(revokeDraft);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendDisabled =
    needsBrain || busy || status !== "ready" || (!text.trim() && drafts.length === 0);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      // B2 — Split text-like files from image files BEFORE validation. Text
      // files are read inline into the composer textarea as a fenced code
      // block; image files go through the existing attachment validator.
      const textFiles: File[] = [];
      const imageOrUnknown: File[] = [];
      for (const f of files) {
        if (isTextLikeFile(f)) textFiles.push(f);
        else imageOrUnknown.push(f);
      }

      // Read all text files in parallel + concat their fenced renderings
      // onto the active session's draft text. Skip silently on read failure
      // (browser-side OOM / blocked, very rare) so user still gets the rest.
      if (textFiles.length > 0) {
        const extractions = await Promise.all(
          textFiles.map((f) => extractTextFromFile(f)),
        );
        const blocks = extractions
          .filter((x): x is NonNullable<typeof x> => !!x)
          .map(textExtractionToMarkdown);
        if (blocks.length > 0) {
          const currentDraft =
            useAppStore.getState().drafts[activeKey] ?? "";
          const joiner = currentDraft.trim() ? "\n\n" : "";
          setDraft(
            activeKey,
            currentDraft + joiner + blocks.join("\n\n"),
          );
        }
      }

      // Validate the image side as before.
      const { accepted, errors } = validateFiles(imageOrUnknown, drafts);
      if (accepted.length > 0) {
        setDrafts((prev) => [...prev, ...accepted]);
      }
      setAttachErrors(errors);
    },
    [drafts, activeKey, setDraft],
  );

  const handlePickClick = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const handlePickChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      addFiles(files);
      e.target.value = "";
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items);
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = e.dataTransfer.files
        ? Array.from(e.dataTransfer.files)
        : [];
      addFiles(files);
    },
    [addFiles],
  );

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) => {
      const removed = prev.find((d) => d.id === id);
      if (removed) revokeDraft(removed);
      return prev.filter((d) => d.id !== id);
    });
    setAttachErrors([]);
  }, []);

  const clearErrors = useCallback(() => setAttachErrors([]), []);

  const dispatchCommand = useAppStore((s) => s.dispatchCommand);
  // Hoisted hermes catalog read — handleSend dispatches via
  // command.dispatch RPC when the typed text matches a real Hermes
  // slash. Declared here (not inside slashCommands section) so it
  // sits ABOVE handleSend in scope.
  const hermesCatalog = useAppStore((s) => s.commandsCatalog);
  const hermesCatalogLoaded = useAppStore((s) => s.commandsCatalogLoaded);
  const loadCommandsCatalog = useAppStore((s) => s.loadCommandsCatalog);

  // Reply-in-context (Wave 1C). When user clicks "Reply" on a bubble
  // in the transcript, `replyTarget[sessionKey]` is set in the store.
  // Composer renders a pinned quote chip above the textarea, and on
  // send, prepends the user's message with a blockquote line so the
  // agent sees the reference. Cleared via setReplyTarget(key, null).
  const replyTarget = useAppStore(
    (s) => s.replyTarget[s.activeSessionKey] ?? null,
  );
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);

  const handleSend = useCallback(async () => {
    const userText = text.trim();
    if (!userText && drafts.length === 0) return;

    // Local-execute slash commands FIRST — `/help`, `/version`, `/model`,
    // `/memory`, `/tools`, `/skills`, `/persona`, `/usage`. These are
    // resolved client-side without invoking the agent (no token cost).
    // tryLocalCommand returns true if it handled the input — in that case
    // we clear the composer and skip the regular send path.
    if (
      userText.startsWith("/") &&
      drafts.length === 0
    ) {
      const handled = await useAppStore
        .getState()
        .tryLocalCommand(userText);
      if (handled) {
        clearDraft(activeKey);
        setDrafts([]);
        setAttachErrors([]);
        if (replyTarget) setReplyTarget(activeKey, null);
        // Push to history so ↑ can recall the command.
        inputHistory.push(userText);
        taRef.current?.focus();
        return;
      }
    }

    // Prepend a Telegram-style quote block if user is replying to a
    // specific bubble. The previous format (just `> @by: text` then the
    // user's prose) made the agent miss the semantic link — chief tested
    // with "coba tulis ini" replying to "pong" and the bot asked for
    // clarification on what "ini" was because it didn't realize "ini"
    // referred to "pong" in the quote.
    //
    // New format adds an explicit AGENT INSTRUCTION line + a clean quote
    // header so the agent sees:
    //   1) a `[KONTEKS BALASAN]` marker that's unmistakable as metadata
    //   2) the full quoted text labeled with speaker
    //   3) a hint that pronouns ("ini", "itu", "tersebut", "tadi") in
    //      the user's actual message likely refer to the quoted content
    //   4) the user's prose, clearly separated
    //
    // The UserBubble parser (parseReplyPrefix in chat-thread.tsx) still
    // extracts the quote card visually; the hint line stays in the agent-
    // facing prompt body where it actually changes model behavior.
    let msg = userText;
    if (replyTarget) {
      const quoted = replyTarget.snippet
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
      const speaker = replyTarget.by || (replyTarget.role === "user" ? "Chief" : "Buff");
      msg =
        `**↪ Membalas @${speaker}:**\n${quoted}\n\n` +
        `_(Catatan untuk Buff: pesan user di bawah membalas kutipan di atas. ` +
        `Jika user pakai kata "ini", "itu", "tadi", "tersebut", atau pronoun lain, ` +
        `kemungkinan besar mengacu ke isi kutipan tersebut. Jangan minta klarifikasi ` +
        `lagi soal apa yang dimaksud — pakai konteks kutipan langsung.)_\n\n` +
        userText;
    }
    const pending = drafts;
    // Capture activeKey at send-time so restore lands on the correct session
    // even if the user switches mid-flight (race is theoretical at ~ms
    // granularity but the capture costs nothing).
    const sendKey = activeKey;

    // Slash command dispatch path: if text starts with `/` AND no
    // attachments AND the first word matches a known Hermes command in
    // the catalog, route through `command.dispatch` RPC instead of
    // `chat.send`. This mirrors Telegram + Discord behavior where `/model`
    // (etc) are gateway commands not chat content.
    const firstWord = msg.split(/\s/)[0] ?? "";
    const isHermesCommand =
      msg.startsWith("/") &&
      pending.length === 0 &&
      hermesCatalog.some((c) => c.name === firstWord);
    if (isHermesCommand) {
      clearDraft(sendKey);
      setDrafts([]);
      setAttachErrors([]);
      const ok = await dispatchCommand(msg, sendKey);
      if (!ok && msg) {
        setDraft(sendKey, msg);
      }
      taRef.current?.focus();
      return;
    }

    clearDraft(sendKey);
    setDrafts([]);
    setAttachErrors([]);
    // Clear reply target optimistically — restored on failure path below.
    if (replyTarget) setReplyTarget(sendKey, null);
    // Push to input history BEFORE awaiting the send — even if the network
    // fails, the user expects ↑ to recall what they typed.
    if (userText) inputHistory.push(userText);
    const ok = await sendMessage(msg, pending);
    if (!ok) {
      // Send rejected (e.g. ENERGY_EXHAUSTED, network). Restore the draft +
      // reply target so the user doesn't lose context. Attachments only
      // restore when the failure was after encoding — if encoding itself
      // failed the pending array is empty from our POV.
      if (userText) setDraft(sendKey, userText);
      if (pending.length > 0) setDrafts(pending);
      if (replyTarget) setReplyTarget(sendKey, replyTarget);
    }
    taRef.current?.focus();
  }, [
    text,
    drafts,
    activeKey,
    sendMessage,
    setDraft,
    clearDraft,
    dispatchCommand,
    hermesCatalog,
    replyTarget,
    setReplyTarget,
    inputHistory,
  ]);

  const handleStop = useCallback(async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await abortActive();
    } finally {
      /* latch clears via busy→idle effect */
    }
  }, [abortActive, aborting]);

  // H7 — Slash commands. Open when the composer text starts with `/` and
  // no whitespace appears between the slash and the cursor. Closed by Esc,
  // Tab/Enter pick, or text losing the `^/` prefix.
  //
  // Two-tier surface:
  //  1. **Prompt templates** (Summarize / Brainstorm / Code / Translate /
  //     Explain / Help) — insert verbose chat prompts.
  //  2. **Hermes system commands** (`/new`, `/reset`, `/model`, `/usage`,
  //     etc) — pulled from Hermes' `commands.catalog` RPC via
  //     `loadCommandsCatalog` store action. These dispatch through
  //     `command.dispatch` instead of `chat.send`.
  //
  // Lazy-load the catalog on first slash open to avoid wire chatter on
  // mount. `commandsCatalogLoaded` flag prevents repeat fetches.
  // (hermesCatalog/hermesCatalogLoaded/loadCommandsCatalog declared
  // above handleSend so they're in scope for the dispatchCommand path.)

  const slashCommands = useMemo(() => {
    // Source of truth: Hermes engine's `commands.list` RPC catalog.
    // Mirrors what Telegram bot users + Hermes Desktop users see.
    //
    // Local-execute commands (`/new`, `/clear`, `/help`, `/version`,
    // `/model`, `/memory`, `/tools`, `/skills`, `/persona`, `/usage`,
    // `/fast`) intercept BEFORE the agent — see `tryLocalCommand` in
    // store.ts. Everything else passes through `chat.send`.
    //
    // Ordering (chief feedback 2026-05-24): categorized so the menu is
    // navigable. Priority within each category by perceived utility:
    //   1. chat   — session control (/new, /clear) — top-of-mind
    //   2. info   — lookup commands (/help, /version, /model, /memory,
    //               /tools, /skills, /persona, /usage) — frequently
    //               referenced for "show me what I have"
    //   3. agent  — control verbs (/btw, /approve, /deny, /fast,
    //               /compact, /retry, etc.) — mid-frequency
    //   4. tools  — action commands (/web, /image, /code, etc.) —
    //               specific use cases
    //
    // Within each category we preserve the engine's catalog ordering
    // so this list stays stable as engine adds/removes commands.
    const CATEGORY_RANK: Record<string, number> = {
      chat: 0,
      info: 1,
      agent: 2,
      tools: 3,
    };

    // UX-3: engine-plumbing commands an awam user should never touch — hide
    // them from the autocomplete menu (they're managed in dedicated tabs, and
    // the bare list overwhelms). Still dispatchable if typed in full; we only
    // drop them from the suggestion surface.
    const HIDDEN_SLASH = new Set([
      "/reload-mcp", "/reload-skills", "/reload", "/sethome", "/steer",
      "/background", "/compress", "/restart", "/update", "/mcp", "/node",
      "/nodes", "/debug", "/logs", "/dump", "/trace",
    ]);

    const seen = new Set<string>();
    const catalog: Array<{
      label: string;
      template: string;
      hint: string;
      kind: "command";
      category: string;
    }> = [];
    for (const c of hermesCatalog) {
      if (!c.name || seen.has(c.name)) continue;
      if (HIDDEN_SLASH.has(c.name)) continue;
      seen.add(c.name);
      catalog.push({
        label: c.name,
        template: `${c.name} `,
        hint:
          BAHASA_GLOSS[c.name] ?? c.description ?? c.name.slice(1),
        kind: "command" as const,
        category: c.category ?? "",
      });
    }
    // Stable sort by category rank — entries within the same category
    // keep their original engine order.
    catalog.sort((a, b) => {
      const ra = CATEGORY_RANK[a.category] ?? 99;
      const rb = CATEGORY_RANK[b.category] ?? 99;
      return ra - rb;
    });
    return catalog;
  }, [hermesCatalog]);

  // The slash menu is OPEN when:
  //   - text starts with "/"
  //   - there's no whitespace yet (the user is still typing the command)
  //   - the textarea is focused
  const slashFilter = useMemo(() => {
    if (!text.startsWith("/")) return null;
    const firstSpace = text.search(/\s/);
    if (firstSpace !== -1) return null; // user moved past the slash word
    return text.slice(1).toLowerCase();
  }, [text]);

  // Lazy-load Hermes' commands.catalog on first slash detection. The store
  // caches per-session (commandsCatalogLoaded flag) so subsequent slashes
  // don't re-fetch. Silent failure leaves the prompt-template-only menu.
  useEffect(() => {
    if (slashFilter !== null && !hermesCatalogLoaded) {
      void loadCommandsCatalog();
    }
  }, [slashFilter, hermesCatalogLoaded, loadCommandsCatalog]);

  // ── @mention agent detection ───────────────────────────────────────
  // Open when the text contains `@<partial>` token (at start OR after
  // whitespace) where `<partial>` has no space yet. The dropdown lists
  // agents from Hermes' agents.list — chief picks one, composer inserts
  // `@<agentName> ` and continues. Multi-agent routing on send is handled
  // by the agent's own mention-detection (Hermes runtime feature).
  const agentsCatalog = useAppStore((s) => s.agentsCatalog);
  const agentsCatalogLoaded = useAppStore((s) => s.agentsCatalogLoaded);
  const loadAgentsCatalog = useAppStore((s) => s.loadAgentsCatalog);

  const mentionFilter = useMemo(() => {
    // Find the LAST `@` in the text that's at start or preceded by space,
    // followed by a partial (no space yet). This is the active mention.
    const m = text.match(/(?:^|\s)@([\w\-]*)$/);
    if (!m) return null;
    return m[1].toLowerCase();
  }, [text]);

  const filteredAgents = useMemo(() => {
    if (mentionFilter === null) return [];
    return agentsCatalog
      .filter((a) =>
        a.name.toLowerCase().includes(mentionFilter) ||
        a.id.toLowerCase().includes(mentionFilter),
      )
      .slice(0, 8);
  }, [mentionFilter, agentsCatalog]);

  const mentionOpen =
    focused && mentionFilter !== null && filteredAgents.length > 0;
  const [mentionHighlight, setMentionHighlight] = useState(0);
  useEffect(() => {
    if (mentionHighlight >= filteredAgents.length) setMentionHighlight(0);
  }, [filteredAgents.length, mentionHighlight]);

  useEffect(() => {
    if (mentionFilter !== null && !agentsCatalogLoaded) {
      void loadAgentsCatalog();
    }
  }, [mentionFilter, agentsCatalogLoaded, loadAgentsCatalog]);

  const applyMention = useCallback(
    (idx: number) => {
      const pick = filteredAgents[idx];
      if (!pick) return;
      // Replace `@<partial>` (at cursor) with `@<agentName> ` (with space).
      const replaced = text.replace(
        /(?:^|\s)@([\w\-]*)$/,
        (_, p1, offset) =>
          (offset === 0 ? "" : " ") + `@${pick.name} `,
      );
      setDraft(activeKey, replaced);
      window.requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    },
    [filteredAgents, text, setDraft, activeKey],
  );

  const filteredSlash = useMemo(() => {
    if (slashFilter === null) return [];
    return slashCommands.filter((c) =>
      c.label.slice(1).toLowerCase().startsWith(slashFilter),
    );
  }, [slashFilter, slashCommands]);

  // NL-c (Chief 2026-06-12): the "/" slash-command autocomplete surfaced mostly
  // engine pass-through commands that don't actually work in /app (~100% broken
  // per Chief). HIDDEN — not removed — so it's a zero-risk change to the complex
  // composer. Supporting logic (slashFilter/filteredSlash/applySlash/catalog
  // load) stays intact, so local commands typed IN FULL (/new, /model, /clear,
  // /help…) still work via tryLocalCommand in handleSend. Proper removal/rework
  // is deferred (tracked in memory parity-worklist NL-c).
  const SLASH_MENU_ENABLED = false;
  const slashOpen =
    SLASH_MENU_ENABLED && focused && slashFilter !== null && filteredSlash.length > 0;
  const [slashHighlight, setSlashHighlight] = useState(0);
  useEffect(() => {
    if (slashHighlight >= filteredSlash.length) setSlashHighlight(0);
  }, [filteredSlash.length, slashHighlight]);

  const applySlash = useCallback(
    (idx: number) => {
      const pick = filteredSlash[idx];
      if (!pick) return;
      setDraft(activeKey, pick.template);
      // Re-focus so cursor lands at the end of the template.
      window.requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    },
    [filteredSlash, setDraft, activeKey],
  );

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mention nav takes priority while the @ menu is open.
      if (mentionOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionHighlight((i) =>
            Math.min(filteredAgents.length - 1, i + 1),
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionHighlight((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applyMention(mentionHighlight);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // Strip the trailing @<partial> so the menu closes
          setDraft(
            activeKey,
            text.replace(/(?:^|\s)@[\w\-]*$/, ""),
          );
          return;
        }
      }
      // Slash-command nav takes priority while the menu is open.
      if (slashOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashHighlight((i) => Math.min(filteredSlash.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashHighlight((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applySlash(slashHighlight);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(activeKey, "");
          return;
        }
      }
      // B3 — Voice dictation: Esc cancels an active session without
      // ending the textarea focus.
      if (voiceActive && e.key === "Escape") {
        e.preventDefault();
        voiceSessionRef.current?.abort();
        voiceSessionRef.current = null;
        setVoiceActive(false);
        return;
      }

      // Terminal-style input history (↑/↓). Engages ONLY when:
      //   - textarea is single-line (no embedded newline)
      //   - slash menu + mention menu both closed
      //   - voice dictation inactive
      //
      // ↑ at any cursor position recalls previous sent. The history hook
      // captures the current draft on the first ↑ so a subsequent ↓ past
      // the newest entry restores it. Multi-line input passes through to
      // native cursor-up behavior — same UX as a terminal where ↑ only
      // engages when you're not editing a multi-line block.
      const isMultiLine = text.includes("\n");
      const canEngageHistory =
        !isMultiLine && !slashOpen && !mentionOpen && !voiceActive;
      if (canEngageHistory && e.key === "ArrowUp") {
        if (inputHistory.size() === 0) {
          // Nothing to recall — fall through to native (no-op for empty).
        } else {
          e.preventDefault();
          inputHistory.recallPrev();
          return;
        }
      }
      if (canEngageHistory && e.key === "ArrowDown") {
        if (inputHistory.isNavigating()) {
          e.preventDefault();
          inputHistory.recallNext();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendDisabled) void handleSend();
      }
    },
    [
      slashOpen,
      filteredSlash.length,
      slashHighlight,
      applySlash,
      mentionOpen,
      filteredAgents.length,
      mentionHighlight,
      applyMention,
      text,
      sendDisabled,
      handleSend,
      setDraft,
      activeKey,
      voiceActive,
      inputHistory,
    ],
  );

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const counter = drafts.length > 0
    ? t.app.chat.composer.attachmentCount
        .replace("{n}", String(drafts.length))
        .replace("{max}", String(MAX_FILES_PER_MESSAGE))
    : null;

  // M1: iOS safe-area-inset-bottom handling for mobile — applied as an inline
  // style on the wrapper below so the Send button stays clear of the home
  // indicator + virtual keyboard.
  if (channelLocked) {
    return (
      <div
        className="mx-auto w-full max-w-3xl px-4 pt-2"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 1rem))" }}
      >
        <div className="flex items-center gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-amber-100/90 backdrop-blur-md">
          <Lock className="size-4 shrink-0 text-amber-300" aria-hidden />
          <div className="min-w-0 text-[12.5px] leading-snug">
            <span className="font-semibold">Mode Pantau · Sesi {activeOrigin.label}.</span>{" "}
            Obrolan ini jalan di {activeOrigin.label}, jadi di web cuma bisa dilihat —
            balasnya langsung lewat {activeOrigin.label} biar gak ngerusak alur chat di sana.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("mx-auto w-full", compact ? "px-2 pt-1.5" : "max-w-3xl px-4 pt-2")}
      style={{
        paddingBottom: compact ? "0.5rem" : "max(1rem, env(safe-area-inset-bottom, 1rem))",
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {attachErrors.length > 0 ? (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          <div className="flex items-start justify-between gap-2">
            <ul className="flex-1 space-y-0.5">
              {attachErrors.map((err, idx) => (
                <li key={idx}>
                  <span className="font-medium text-red-100">{err.fileName}:</span>{" "}
                  {err.reason}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={clearErrors}
              aria-label={t.app.chat.composer.closeWarn}
              className="shrink-0 rounded p-0.5 text-red-200/80 transition hover:bg-red-500/20 hover:text-red-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {voiceError ? (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex-1">{voiceError}</span>
            <button
              type="button"
              onClick={() => setVoiceError(null)}
              aria-label={t.app.chat.composer.closeWarn}
              className="shrink-0 rounded p-0.5 text-red-200/80 transition hover:bg-red-500/20 hover:text-red-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {vnError ? (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex-1">{vnError}</span>
            <button
              type="button"
              onClick={() => setVnError(null)}
              aria-label={t.app.chat.composer.closeWarn}
              className="shrink-0 rounded p-0.5 text-red-200/80 transition hover:bg-red-500/20 hover:text-red-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {/* VN recording panel — appears between the optional error banners
          and the omnibar. Two states: live recording (red pulse + timer
          + Stop) and preview (play / discard / send). */}
      {vnState.kind === "recording" ? (
        <div
          className="mb-2 flex items-center gap-3 rounded-xl border border-red-500/40 bg-[#0B0E14]/80 px-4 py-3 backdrop-blur-md shadow-[0_0_0_1px_rgba(239,68,68,0.08)]"
        >
          <span
            aria-hidden
            className="inline-flex size-2.5 animate-pulse rounded-full bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.85)]"
          />
          <span className="font-mono text-xs uppercase tracking-[0.22em] text-red-200">
            {t.app.chat.composer.vnRecording}
          </span>
          <span className="ml-auto font-mono text-base tabular-nums text-white/90">
            {formatVnDuration(vnState.elapsedMs)}
          </span>
          <button
            type="button"
            onClick={stopVoiceNote}
            aria-label={t.app.chat.composer.vnStopLabel}
            className="ml-2 flex size-9 items-center justify-center rounded-lg border border-red-500/50 bg-red-500/20 text-red-100 transition hover:bg-red-500/30"
          >
            <Square className="size-3.5 fill-current" />
          </button>
          <button
            type="button"
            onClick={cancelVoiceNote}
            aria-label={t.app.chat.composer.vnCancelLabel}
            className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-white/20 hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {vnState.kind === "preview" ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-400/30 bg-[#0B0E14]/80 p-2 backdrop-blur-md shadow-[0_0_0_1px_rgba(34,211,238,0.08)] sm:flex-nowrap"
        >
          {/* Reuse the shared AudioPlayer so VN preview UX is identical to
              the in-chat audio attachment player downstream — consistent
              Telegram/WA-style waveform + seek + time display. */}
          <AudioPlayer
            src={vnState.previewUrl}
            filename={`voice-note-preview.${vnState.mime.includes("webm") ? "webm" : "ogg"}`}
            knownDurationMs={vnState.durationMs}
            variant="wide"
            showDownload={false}
            label={t.app.chat.composer.vnPreviewLabel}
            className="flex-1"
          />
          <button
            type="button"
            onClick={cancelVoiceNote}
            aria-label={t.app.chat.composer.vnDiscardLabel}
            title={t.app.chat.composer.vnDiscardLabel}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-red-500/40 hover:text-red-200"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={sendVoiceNote}
            aria-label={t.app.chat.composer.vnAttachLabel}
            title={t.app.chat.composer.vnAttachLabel}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_24px_-6px_rgba(99,102,241,0.55)] transition hover:brightness-110 active:scale-[0.96]"
          >
            <Check className="size-3.5" />
          </button>
        </div>
      ) : null}

      {draftWarning ? (
        <div
          role="alert"
          className="mb-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex-1">
              {draftWarning === "quota"
                ? t.app.chat.composer.draftWarnQuota
                : draftWarning === "oversize"
                  ? t.app.chat.composer.draftWarnOversize
                  : t.app.chat.composer.draftWarnUnavailable}
            </span>
            <button
              type="button"
              onClick={clearDraftWarning}
              aria-label={t.app.chat.composer.closeDraftWarn}
              className="shrink-0 rounded p-0.5 text-amber-200/80 transition hover:bg-amber-500/20 hover:text-amber-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {busy ? <LiveActivityBar /> : null}

      <div className={cn("relative", busy ? "hidden" : "block")}>
        {mentionOpen ? (
          <div
            role="listbox"
            aria-label="Pilih agent"
            className="absolute bottom-full left-2 right-2 mb-2 max-h-60 overflow-y-auto rounded-xl border border-fuchsia-400/30 bg-[#0B0E14]/95 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
          >
            <div className="border-b border-white/[0.06] px-3 py-1.5">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-fuchsia-200/85">
                Agent · {filteredAgents.length}
              </p>
            </div>
            <ul className="p-1">
              {filteredAgents.map((agent, idx) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={idx === mentionHighlight}
                    onMouseEnter={() => setMentionHighlight(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyMention(idx);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition",
                      idx === mentionHighlight
                        ? "bg-fuchsia-400/15 text-fuchsia-50"
                        : "text-white/65 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-[12px]"
                      style={{
                        background: agent.theme
                          ? `${agent.theme}30`
                          : "rgba(217,70,239,0.18)",
                        border: `1px solid ${agent.theme ?? "rgba(217,70,239,0.45)"}`,
                      }}
                    >
                      {agent.emoji || "🤖"}
                    </span>
                    <span className="font-mono text-fuchsia-200/85">
                      @{agent.name}
                    </span>
                    {agent.description ? (
                      <span className="min-w-0 flex-1 truncate text-white/45">
                        {agent.description}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {slashOpen ? (
          <div
            role="listbox"
            aria-label={t.app.chat.composer.slashCommandsHeader}
            className="absolute bottom-full left-2 right-2 mb-2 max-h-72 overflow-y-auto rounded-xl border border-cyan-400/30 bg-[#0B0E14]/95 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
          >
            <div className="border-b border-white/[0.06] px-3 py-1.5">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/40">
                {t.app.chat.composer.slashCommandsHeader}
              </p>
            </div>
            <ul className="p-1">
              {filteredSlash.map((cmd, idx) => (
                // Composite key — label alone CAN collide if a future
                // duplication slips through (e.g. engine catalog grows
                // a `/help` alias). `kind:label:idx` triple is safe
                // against any future dup pattern.
                <li key={`${cmd.kind}:${cmd.label}:${idx}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={idx === slashHighlight}
                    onMouseEnter={() => setSlashHighlight(idx)}
                    onMouseDown={(e) => {
                      // mousedown beats textarea blur; otherwise the menu
                      // closes before the click fires.
                      e.preventDefault();
                      applySlash(idx);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-xs transition",
                      idx === slashHighlight
                        ? "bg-cyan-400/15 text-cyan-100"
                        : "text-white/65 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <span className="font-mono text-cyan-300/85">
                      {cmd.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-white/55">
                      {cmd.hint}
                    </span>
                    {cmd.category ? (
                      <span
                        className="shrink-0 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.18em] text-white/55"
                        title={`Kategori: ${cmd.category}`}
                      >
                        {cmd.category}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {lowEnergy ? (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute -inset-0.5 rounded-[1.15rem] bg-amber-400/35 blur-md"
            animate={{ opacity: [0.35, 0.75, 0.35] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : null}

        <div
          className={cn(
            "relative flex flex-col gap-2 rounded-[1rem] border bg-[#0B0E14]/80 backdrop-blur-xl transition-all",
            compact ? "gap-1 p-1.5" : "gap-2 p-2",
            dragOver
              ? "border-cyan-400/60 shadow-[0_0_0_4px_rgba(34,211,238,0.18)]"
              : lowEnergy
                ? "border-amber-400/50 shadow-[0_0_0_1px_rgba(251,191,36,0.25)]"
                : focused
                  ? "border-cyan-400/50 shadow-[0_12px_34px_-12px_rgba(34,211,238,0.45)]"
                  : "border-white/10",
          )}
        >
          {dragOver ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1rem] bg-[#0B0E14]/70 text-sm font-medium text-cyan-200"
            >
              {t.app.chat.composer.dropZoneHint}
            </div>
          ) : null}

          {replyTarget ? (
            // A11Y-2: two SIBLING real buttons inside a non-interactive
            // container (was a role=button <span> nested in a <button> —
            // invalid HTML + the cancel-X was keyboard-unreachable).
            <div className="mx-2 mt-1 flex w-full items-start gap-2 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-400/[0.06] px-2 py-1.5">
              <button
                type="button"
                onClick={() => {
                  // Click the chip → scroll to the bubble being replied to +
                  // flash a brief cyan ring so the user can confirm WHICH
                  // message they're quoting before they hit Send.
                  const el = document.querySelector<HTMLElement>(
                    `[data-message-id="${replyTarget.messageId}"]`,
                  );
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.classList.add("ring-2", "ring-cyan-400/60");
                    setTimeout(() => {
                      el.classList.remove("ring-2", "ring-cyan-400/60");
                    }, 1500);
                  }
                }}
                aria-label="Lompat ke pesan yang dibalas"
                title="Klik untuk lompat ke pesan asli"
                className="flex min-w-0 flex-1 items-start gap-2 rounded text-left transition hover:opacity-90"
              >
                <span aria-hidden className="mt-0.5 text-[12px] text-cyan-300/85">
                  ↩
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
                      Reply ke {replyTarget.by}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
                      · klik untuk lompat
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[11.5px] text-white/65">
                    {replyTarget.snippet}
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setReplyTarget(activeKey, null)}
                aria-label="Batal reply"
                className="shrink-0 rounded p-1 text-white/45 transition hover:bg-white/[0.06] hover:text-white/85"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}
          {drafts.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-2 pt-1">
              {drafts.map((d) => (
                <DraftChip
                  key={d.id}
                  draft={d}
                  onRemove={() => removeDraft(d.id)}
                  disabled={busy}
                />
              ))}
            </div>
          ) : null}

          {needsBrain ? (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] leading-relaxed text-amber-100">
              <span aria-hidden className="text-base leading-none">
                🧠
              </span>
              <p>
                <span className="font-semibold text-amber-200">
                  Otak belum terpasang.
                </span>{" "}
                AgentBuff perlu kunci AI dulu buat bisa chat.{" "}
                <a
                  href="/app/providers"
                  className="font-semibold underline underline-offset-2 hover:text-white"
                >
                  Pasang di tab Penyedia
                </a>{" "}
                ya.
              </p>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePickClick}
              disabled={
                status !== "ready" ||
                busy ||
                drafts.length >= MAX_FILES_PER_MESSAGE
              }
              aria-label={t.app.chat.composer.attachLabel}
              title={
                drafts.length >= MAX_FILES_PER_MESSAGE
                  ? t.app.chat.composer.attachMaxTitle.replace(
                      "{n}",
                      String(MAX_FILES_PER_MESSAGE),
                    )
                  : t.app.chat.composer.attachLabel
              }
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-lg text-white/55 transition",
                status !== "ready" ||
                  busy ||
                  drafts.length >= MAX_FILES_PER_MESSAGE
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-white/5 hover:text-white",
              )}
            >
              <Paperclip className="size-4" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              onChange={handlePickChange}
              className="hidden"
              aria-hidden
              tabIndex={-1}
            />
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setDraft(activeKey, e.target.value)}
              onKeyDown={handleKey}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              rows={1}
              disabled={status !== "ready"}
              placeholder={
                status === "ready"
                  ? busy
                    ? t.app.chat.composer.placeholderBusy
                    : drafts.length > 0
                      ? t.app.chat.composer.placeholderDrafts
                      : t.app.chat.composer.placeholderDefault
                  : t.app.chat.composer.placeholderNotReady
              }
              className={cn(
                "flex-1 resize-none bg-transparent px-2 text-white placeholder:text-white/30 focus:outline-none disabled:opacity-50",
                compact ? "max-h-[120px] min-h-9 py-1.5 text-[13.5px] leading-5" : "max-h-[180px] min-h-11 py-2.5 text-[15px] leading-6",
              )}
              aria-label={t.app.chat.composer.chatLabel}
            />

            <button
              type="button"
              onClick={voiceActive ? stopVoice : startVoice}
              disabled={!voiceAvailable || status !== "ready" || busy}
              aria-label={
                voiceActive
                  ? t.app.chat.composer.voiceStopLabel
                  : !voiceAvailable
                    ? t.app.chat.composer.voiceUnavailable
                    : t.app.chat.composer.voiceLabel
              }
              title={
                !voiceAvailable
                  ? t.app.chat.composer.voiceUnavailable
                  : voiceActive
                    ? t.app.chat.composer.voiceListening
                    : t.app.chat.composer.voiceTitle
              }
              aria-pressed={voiceActive}
              className={cn(
                "relative flex size-11 shrink-0 items-center justify-center rounded-lg transition",
                !voiceAvailable || status !== "ready" || busy
                  ? "cursor-not-allowed text-white/25"
                  : voiceActive
                    ? "bg-red-500/20 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.45)] hover:bg-red-500/30"
                    : "text-white/55 hover:bg-white/5 hover:text-white",
              )}
            >
              <Mic className="size-4" />
              {voiceActive ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 right-0.5 inline-flex h-2 w-2 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.9)]"
                />
              ) : null}
            </button>

            {/* VN (voice note) button — records audio file attachment,
                distinct from mic (which does live dictation-to-text).
                When recording is active, the inline VN panel below the
                composer takes over the action affordances. */}
            <button
              type="button"
              onClick={
                vnState.kind === "idle"
                  ? startVoiceNote
                  : vnState.kind === "recording"
                    ? stopVoiceNote
                    : cancelVoiceNote
              }
              disabled={!vnAvailable || status !== "ready" || busy}
              aria-label={
                vnState.kind === "recording"
                  ? t.app.chat.composer.vnStopLabel
                  : !vnAvailable
                    ? t.app.chat.composer.vnUnsupported
                    : t.app.chat.composer.vnStartLabel
              }
              title={
                !vnAvailable
                  ? t.app.chat.composer.vnUnsupported
                  : vnState.kind === "recording"
                    ? t.app.chat.composer.vnRecording
                    : t.app.chat.composer.vnTitle
              }
              aria-pressed={vnState.kind !== "idle"}
              className={cn(
                "relative flex size-11 shrink-0 items-center justify-center rounded-lg transition",
                !vnAvailable || status !== "ready" || busy
                  ? "cursor-not-allowed text-white/25"
                  : vnState.kind === "recording"
                    ? "bg-red-500/20 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.45)] hover:bg-red-500/30"
                    : vnState.kind === "preview"
                      ? "bg-cyan-400/15 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.35)] hover:bg-cyan-400/25"
                      : "text-white/55 hover:bg-white/5 hover:text-white",
              )}
            >
              <AudioLines className="size-4" />
              {vnState.kind === "recording" ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 right-0.5 inline-flex h-2 w-2 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.9)]"
                />
              ) : null}
            </button>

            {busy ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={aborting}
                aria-label={t.app.chat.composer.stopLabel}
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold transition",
                  aborting
                    ? "cursor-wait border border-red-500/40 bg-red-500/20 text-red-200"
                    : "border border-red-500/50 bg-red-500/90 text-white hover:bg-red-500 hover:shadow-[0_8px_24px_-6px_rgba(239,68,68,0.55)]",
                )}
              >
                <span
                  aria-hidden
                  className="block h-3 w-3 rounded-[2px] bg-current"
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={sendDisabled}
                aria-label={t.app.chat.composer.sendLabel}
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-all",
                  sendDisabled
                    ? "cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/30"
                    : "bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_24px_-6px_rgba(99,102,241,0.55)] hover:brightness-110 active:scale-[0.96]",
                )}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path d="m22 2-7 20-4-9-9-4Z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Footer — busy hint atau jumlah lampiran. Energy/balance/top-up dihapus
          selama fase BYOK (Chief 2026-06-02). Hidden in compact (mini) mode. */}
      <div className={cn("flex items-center gap-3 pl-2 pr-1", compact ? "hidden" : "mt-2")}>
        <div className="min-w-0 flex-1">
          {busy ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">
              {t.app.chat.composer.busyHint}
            </p>
          ) : counter ? (
            <p className="flex items-center gap-2 text-[11px] text-white/35">
              <span className="rounded-full border border-cyan-400/25 bg-cyan-400/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-300/85">
                {counter}
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DraftChip({
  draft,
  onRemove,
  disabled,
}: {
  draft: AttachmentDraft;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  // Per-kind thumbnail rendering — images get the actual preview, other
  // kinds get an icon + accent border matching the basecamp palette.
  const KindIcon =
    draft.kind === "audio"
      ? FileAudio
      : draft.kind === "video"
        ? FileVideo
        : draft.kind === "document"
          ? FileText
          : ImageIcon;
  const accentBorder =
    draft.kind === "audio"
      ? "hover:border-fuchsia-400/30"
      : draft.kind === "video"
        ? "hover:border-indigo-400/30"
        : draft.kind === "document"
          ? "hover:border-amber-400/30"
          : "hover:border-cyan-400/30";
  const accentText =
    draft.kind === "audio"
      ? "text-fuchsia-300/80"
      : draft.kind === "video"
        ? "text-indigo-300/80"
        : draft.kind === "document"
          ? "text-amber-300/80"
          : "text-cyan-300/80";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] pr-2 transition",
        accentBorder,
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden bg-[#0B0E14]">
        {draft.kind === "image" && draft.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draft.previewUrl}
            alt={draft.name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <KindIcon className={cn("size-4", accentText)} aria-hidden />
        )}
      </div>
      <div className="min-w-0 py-1 pr-1 text-left">
        <p className="max-w-[160px] truncate text-xs font-medium text-white/90">
          {draft.name}
        </p>
        <p
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.14em]",
            accentText,
          )}
        >
          {draft.kind} · {prettyFileSize(draft.sizeBytes)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t.app.chat.composer.removeAttachment.replace(
          "{name}",
          draft.name,
        )}
        className={cn(
          "shrink-0 rounded p-1 text-white/45 transition",
          disabled
            ? "cursor-not-allowed opacity-40"
            : "hover:bg-red-500/20 hover:text-red-300",
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

