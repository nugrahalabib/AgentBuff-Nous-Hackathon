"use client";

import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useAppStore } from "@/lib/app/store";
import { useProfile } from "@/hooks/use-api";
import { useAgentsList } from "@/components/app/agents/use-agents-data";
import {
  getAgentDisplayName,
  getAgentEmoji,
} from "@/components/app/agents/helpers";
import {
  ACCEPTED_MIME_TYPES,
  MAX_FILES_PER_MESSAGE,
  prettyFileSize,
  revokeDraft,
  validateFiles,
  type AttachmentDraft,
  type AttachmentValidationError,
} from "@/lib/app/attachments";
import {
  isSpeechRecognitionAvailable,
  startSpeechRecognition,
  type SpeechSession,
} from "@/lib/app/speech";
import { cn } from "@/lib/utils";

// Mirrors /basecamp CenterStage — COMMAND CENTER hero with the big glowing
// omnibar as the ONLY input on the empty state. First submit triggers
// store.sendMessage(); the resulting message populates store.messages and
// the shell swaps in <ChatThread /> + <ChatComposer />.
//
// Full attachment parity with ChatComposer: paperclip picker, paste,
// drag-drop, ALL accepted MIME kinds (image/audio/video/document), draft
// chips, error panel, plus live mic dictation (UX-2). The store's
// sendMessage(msg, attachments?) accepts attachments on the first turn, so
// the hero can send a message WITH files from the empty state.

// Fallback when the user's primary-goal focus has no dedicated set (or no
// onboarding focus yet) — a universal, audience-neutral business-grade set.
const FOCUS_FALLBACK = "default";
const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(",");

// Per-card accent cycle for the quick-action shortcut cards — mirrors the
// kanban empty-state idiom (icon-tile + corner glow blob). Indexed by
// i % QUICK_ACTION_ACCENTS.length; each focus ships exactly 4 chips.
// glow = corner-blob gradient, tile = emoji-tile border tint, hint = hover
// affordance text color. The emoji itself comes from chip.icon.
const QUICK_ACTION_ACCENTS = [
  { glow: "from-cyan-400/30 to-cyan-400/0", tile: "border-cyan-400/25", hint: "text-cyan-300/80" },
  { glow: "from-fuchsia-400/30 to-fuchsia-400/0", tile: "border-fuchsia-400/25", hint: "text-fuchsia-300/80" },
  { glow: "from-indigo-400/30 to-indigo-400/0", tile: "border-indigo-400/25", hint: "text-indigo-300/80" },
  { glow: "from-emerald-400/30 to-emerald-400/0", tile: "border-emerald-400/25", hint: "text-emerald-300/80" },
] as const;

export function AppCommandCenter() {
  const { t, locale } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [attachErrors, setAttachErrors] = useState<
    AttachmentValidationError[]
  >([]);
  const [dragOver, setDragOver] = useState(false);
  // Voice dictation (UX-2) — mirrors ChatComposer's mic so the first-message
  // hero has feature parity with the in-chat composer.
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceSessionRef = useRef<SpeechSession | null>(null);
  const voiceBaseRef = useRef<string>("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Drag-enter/leave fires on every child too — track depth so the
  // drop-zone doesn't flicker while dragging across the textarea.
  const dragDepth = useRef(0);

  const status = useAppStore((s) => s.status);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const clearError = useAppStore((s) => s.clearError);
  const createSession = useAppStore((s) => s.createSession);

  // Agent selector — chief's design: pick WHICH agent to talk to before the
  // first message. The chosen agent binds the auto-created session so its
  // persona + model apply (per P0#2). Without this the Command Center always
  // routed to the default agent.
  const agentsQuery = useAgentsList();
  const agentList = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data],
  );
  const agentsDefaultId = agentsQuery.data?.defaultId ?? "default";
  // Which agent the user picked (defaults to the engine default once loaded).
  const [chosenAgentId, setChosenAgentId] = useState<string>("");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  // Each fresh Command Center mount (= new empty session) starts the picker at
  // the ENGINE default agent. Picks are per-session + explicit (chief's
  // channel-like model: "tiap sesi baru pilih agen lagi"). We deliberately do
  // NOT seed from a persisted global "last picked" — that leaked kiwi into
  // later default-intent flows (Ctrl+K, fresh mount) and caused silent
  // wrong-agent routing. agentsDefaultId is the source of truth.
  useEffect(() => {
    if (!chosenAgentId && agentList.length > 0) {
      setChosenAgentId(agentsDefaultId);
    }
  }, [agentList, agentsDefaultId, chosenAgentId]);
  useEffect(() => {
    if (!agentMenuOpen) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setAgentMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [agentMenuOpen]);
  const chosenAgent =
    agentList.find((a) => a.id === chosenAgentId) ?? agentList[0] ?? null;
  // Share the same per-session draft bucket with ChatComposer. If the user
  // types here, closes the browser, comes back to an empty session, the
  // prose is still there. A chip click ALSO writes to the store so if they
  // pick a chip + close tab + come back, the chosen prompt waits.
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const prompt = useAppStore((s) => s.drafts[s.activeSessionKey] ?? "");
  const setDraft = useAppStore((s) => s.setDraft);
  const clearDraft = useAppStore((s) => s.clearDraft);
  const prefersReducedMotion = useReducedMotion();

  // Pick quick-action chips by the user's onboarding focus. Fall back to
  // "content" so we always have something to show.
  const { data: profile } = useProfile();
  const focus = profile?.profile?.focus || FOCUS_FALLBACK;
  const chipsByFocus = t.basecamp.quickActionsByFocus as Record<
    string,
    ReadonlyArray<{ icon: string; label: string; prompt: string }>
  >;
  const chips = chipsByFocus[focus] ?? chipsByFocus[FOCUS_FALLBACK];

  const ready = status === "ready";
  const disabled =
    !ready || submitting || (!prompt.trim() && drafts.length === 0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-resize textarea to fit content, capped at 180px.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [prompt]);

  // Revoke blob URLs on unmount so we don't leak memory when the shell
  // flips to ChatThread+ChatComposer after the first send.
  useEffect(() => {
    return () => {
      drafts.forEach(revokeDraft);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { accepted, errors } = validateFiles(files, drafts);
      if (accepted.length > 0) {
        setDrafts((prev) => [...prev, ...accepted]);
      }
      setAttachErrors(errors);
    },
    [drafts],
  );

  const handlePickClick = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const handlePickChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      addFiles(files);
      // Reset so re-selecting the same file triggers `change` again.
      e.target.value = "";
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items);
      const pastedFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        addFiles(pastedFiles);
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

  // Voice dictation (UX-2) — live SpeechRecognition transcript appended onto
  // the existing draft text. Same contract as ChatComposer.startVoice.
  // HYDRATION-SAFE: this component IS server-rendered (the empty-state hero),
  // and SpeechRecognition only exists in the browser. Computing availability
  // during render makes SSR HTML (false → "not supported" labels) differ from
  // the client's first render (true) → React hydration mismatch + full
  // client re-render of the page. Gate it behind a post-mount effect so the
  // server and the first client render agree (false), then enable.
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
    voiceBaseRef.current = useAppStore.getState().drafts[activeKey] ?? "";
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
          if (code === "aborted") return;
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

  // Auto-clear voice error after a few seconds.
  useEffect(() => {
    if (!voiceError) return;
    const id = window.setTimeout(() => setVoiceError(null), 4500);
    return () => window.clearTimeout(id);
  }, [voiceError]);

  // Stop dictation on unmount so the recognizer doesn't dangle.
  useEffect(() => {
    return () => voiceSessionRef.current?.stop();
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed && drafts.length === 0) return;
    if (!ready || submitting) return;
    setSubmitting(true);
    clearError();
    // Optimistically clear — store echoes the bubble so user sees it instantly.
    // On failure, restore text + drafts so they can retry.
    const pendingDrafts = drafts;
    const pendingText = trimmed;
    const originKey = activeKey;
    clearDraft(originKey);
    setDrafts([]);
    setAttachErrors([]);
    try {
      // Route to the agent the user PICKED (P0#2). The picker is the source of
      // truth for "siapa yang mau diajak ngobrol".
      //
      // CRITICAL FIX (2026-05-30): the old gate required
      // `chosenAgentId !== agentsDefaultId && originKey === DEFAULT_SESSION_KEY`.
      // Both guards misfired: (1) agentsDefaultId is "default", and (2) the
      // Command Center renders whenever the ACTIVE session is empty — which is
      // often an existing `agent:main:<dbkey>` thread, NOT the literal
      // `agent:main:main` placeholder. So a kiwi pick failed the gate → no
      // kiwi session created → sendMessage fell through to the existing Buff
      // session. Chief saw "pilih kiwi, dijawab Buff".
      //
      // New rule: compare the chosen agent to the agent the CURRENT empty
      // session is bound to (parsed from its key `agent:<id>:…`).
      //   - same agent  → reuse the active session (no orphan empty session).
      //   - diff agent  → create a session BOUND to the chosen agent and send
      //                   into THAT key explicitly (passed to sendMessage so a
      //                   re-render shifting activeSessionKey can't misroute).
      // Works in both directions: default→kiwi AND kiwi→default.
      const DEFAULT = "__default__";
      const normAgent = (id: string | null | undefined): string =>
        !id || id === "main" || id === "default" || id === agentsDefaultId
          ? DEFAULT
          : id;
      const parseAgentFromKey = (key: string): string =>
        key.startsWith("agent:") ? key.split(":")[1] || "main" : "main";

      const activeAgent = normAgent(parseAgentFromKey(originKey));
      const chosen = normAgent(chosenAgentId);

      let targetKey: string | undefined;
      if (chosen !== activeAgent) {
        // Bind a fresh session to the chosen agent. Pass "default" explicitly
        // for the house agent so createSession's defaultAgentId fallback can't
        // accidentally bind to a previously-picked non-default agent.
        const bindArg = chosen === DEFAULT ? "default" : chosen;
        const boundKey = await createSession(undefined, bindArg);
        if (!boundKey) {
          // Bind failed — DON'T silently route to the wrong agent. Restore.
          if (pendingText) setDraft(originKey, pendingText);
          setDrafts(pendingDrafts);
          return;
        }
        targetKey = boundKey;
      }

      const ok = await sendMessage(pendingText, pendingDrafts, targetKey);
      if (!ok) {
        // Restore to whatever session is active now (bound or origin).
        const restoreKey = useAppStore.getState().activeSessionKey;
        if (pendingText) setDraft(restoreKey, pendingText);
        setDrafts(pendingDrafts);
      }
      // Blob URLs live on — the echoed AttachmentPart owns them now.
    } finally {
      setSubmitting(false);
    }
  }, [
    prompt,
    drafts,
    ready,
    submitting,
    sendMessage,
    clearError,
    activeKey,
    setDraft,
    clearDraft,
    chosenAgentId,
    agentsDefaultId,
    createSession,
  ]);

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSubmit();
  };

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!disabled) void handleSubmit();
      }
    },
    [disabled, handleSubmit],
  );

  const counter = drafts.length > 0
    ? `${drafts.length}/${MAX_FILES_PER_MESSAGE} lampiran`
    : null;

  return (
    // pb > pt: optical centering — the hero stack reads as "centered" when it
    // sits slightly ABOVE geometric center (the absolute-bottom disclaimer
    // adds visual weight below). Geometric justify-center alone feels low.
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 pt-8 pb-[12vh] sm:px-8">
      {/* Headline (eyebrow chip removed per chief 2026-06-11) */}
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-10 max-w-2xl text-center"
      >
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {t.basecamp.center.title}{" "}
          <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">
            {t.basecamp.center.titleHighlight}
          </span>
          .
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-white/55 sm:text-[15px]">
          {t.basecamp.center.subtitle}
        </p>
      </motion.div>

      {/* Omnibar block — form contains the input box. Disclaimer lives as a
          sibling below so glow bleed can't sit on top of the text. Drag-drop
          captured on the whole block so dropping on the textarea OR on the
          draft strip both accept files. */}
      <div
        className="relative w-full max-w-3xl"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {attachErrors.length > 0 ? (
          <div
            role="alert"
            className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          >
            <div className="flex items-start justify-between gap-2">
              <ul className="flex-1 space-y-0.5">
                {attachErrors.map((err, idx) => (
                  <li key={idx}>
                    <span className="font-medium text-red-100">
                      {err.fileName}:
                    </span>{" "}
                    {err.reason}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={clearErrors}
                aria-label="Tutup peringatan"
                className="shrink-0 rounded p-0.5 text-red-200/80 transition hover:bg-red-500/20 hover:text-red-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Agent selector — pick WHICH agent to talk to (chief's design).
            Bound to the session on first send so its persona + model apply. */}
        {agentList.length > 0 && chosenAgent ? (
          <div ref={agentMenuRef} className="relative z-20 mb-3 flex justify-center">
            <button
              type="button"
              onClick={() => setAgentMenuOpen((v) => !v)}
              className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium text-white/80 transition hover:border-cyan-400/40 hover:bg-white/[0.07]"
              aria-haspopup="menu"
              aria-expanded={agentMenuOpen}
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
                Ngobrol sama
              </span>
              <span className="text-sm leading-none">
                {getAgentEmoji(chosenAgent) || "🤖"}
              </span>
              <span className="font-semibold text-white/90">
                {getAgentDisplayName(chosenAgent)}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-white/50 transition-transform",
                  agentMenuOpen && "rotate-180",
                )}
              />
            </button>
            {agentMenuOpen ? (
              <div className="absolute left-1/2 top-full z-30 mt-1.5 w-60 -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl">
                <p className="px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                  Pilih agen
                </p>
                <div className="max-h-72 overflow-y-auto">
                  {agentList.map((a) => {
                    const isDefault = a.id === agentsDefaultId;
                    const isChosen = a.id === chosenAgent.id;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => {
                          setChosenAgentId(a.id);
                          setAgentMenuOpen(false);
                          inputRef.current?.focus();
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                          isChosen
                            ? "bg-cyan-400/10 text-white"
                            : "text-white/85 hover:bg-white/[0.06] hover:text-white",
                        )}
                      >
                        <span className="text-base leading-none">
                          {getAgentEmoji(a) || "🤖"}
                        </span>
                        <span className="truncate">
                          {getAgentDisplayName(a)}
                        </span>
                        {isDefault ? (
                          <span className="ml-auto shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-cyan-200/80">
                            utama
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 border-t border-white/[0.06] pt-1">
                  <a
                    href="/app/agents"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-cyan-200/80 transition-colors hover:bg-white/[0.06] hover:text-cyan-100"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    Bikin / atur agen
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {voiceError ? (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          >
            <span className="flex-1">{voiceError}</span>
            <button
              type="button"
              onClick={() => setVoiceError(null)}
              aria-label="Tutup peringatan"
              className="shrink-0 rounded p-0.5 text-red-200/80 transition hover:bg-red-500/20 hover:text-red-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        <motion.form
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.5 }}
          onSubmit={onFormSubmit}
          className="relative"
        >
          {/* Soft ambient glow — one layer, reactive to focus/typing so it
              doesn't overpower when idle. */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute -inset-2 rounded-[1.6rem] bg-gradient-to-r from-cyan-400/30 via-indigo-400/20 to-fuchsia-500/30 blur-2xl"
            animate={{
              opacity:
                dragOver ||
                focusRing ||
                prompt.length > 0 ||
                drafts.length > 0
                  ? 0.75
                  : 0.4,
            }}
            transition={{ duration: 0.35 }}
          />
          <div
            className={cn(
              "relative flex flex-col gap-2 rounded-[1.25rem] border bg-[#0B0E14]/85 p-2 backdrop-blur-xl transition-colors",
              dragOver
                ? "border-cyan-400/60 shadow-[0_0_0_4px_rgba(34,211,238,0.18)]"
                : focusRing
                  ? "border-cyan-400/50 shadow-[0_12px_40px_-12px_rgba(34,211,238,0.5)]"
                  : "border-white/10 shadow-[0_4px_30px_-10px_rgba(0,0,0,0.7)]",
            )}
          >
            {dragOver ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.25rem] bg-[#0B0E14]/70 text-sm font-medium text-cyan-200"
              >
                Lepaskan untuk melampirkan file
              </div>
            ) : null}

            {drafts.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-1 pt-1">
                {drafts.map((d) => (
                  <DraftChip
                    key={d.id}
                    draft={d}
                    onRemove={() => removeDraft(d.id)}
                    disabled={submitting}
                  />
                ))}
              </div>
            ) : null}

            {/* All three elements share size-11 (44px) row height so paperclip,
                placeholder text, and send button center-align perfectly on the
                single-line default. When textarea grows, items-center floats
                the buttons to the middle — fine for the hero empty state. */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePickClick}
                disabled={
                  !ready ||
                  submitting ||
                  drafts.length >= MAX_FILES_PER_MESSAGE
                }
                aria-label="Lampirkan file"
                title={
                  drafts.length >= MAX_FILES_PER_MESSAGE
                    ? `Maksimal ${MAX_FILES_PER_MESSAGE} lampiran`
                    : "Lampirkan file (gambar, audio, video, dokumen)"
                }
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-lg text-white/55 transition",
                  !ready ||
                    submitting ||
                    drafts.length >= MAX_FILES_PER_MESSAGE
                    ? "cursor-not-allowed opacity-40"
                    : "hover:bg-white/[0.06] hover:text-cyan-300",
                )}
              >
                <Paperclip className="h-5 w-5" />
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
                ref={inputRef}
                value={prompt}
                onChange={(e) => setDraft(activeKey, e.target.value)}
                onFocus={() => setFocusRing(true)}
                onBlur={() => setFocusRing(false)}
                onKeyDown={handleKey}
                onPaste={handlePaste}
                placeholder={
                  ready
                    ? drafts.length > 0
                      ? "Tambahkan catatan (opsional)…"
                      : t.basecamp.center.placeholder
                    : "Menyambungkan ke agent…"
                }
                rows={1}
                disabled={!ready}
                className="max-h-[180px] min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-[15px] leading-6 text-white placeholder:text-white/35 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={voiceActive ? stopVoice : startVoice}
                disabled={!voiceAvailable || !ready || submitting}
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
                  !voiceAvailable || !ready || submitting
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
              <button
                type="submit"
                disabled={disabled}
                className={cn(
                  "group relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-all",
                  disabled
                    ? "cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/30"
                    : "bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_28px_-6px_rgba(99,102,241,0.55)] hover:brightness-110 active:scale-[0.96]",
                )}
                aria-label={t.basecamp.center.send}
              >
                <Send className="size-4" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </motion.form>

        {/* Attachment counter — only shown when there are drafts. Stays near
            the form because it's form-contextual info. Disclaimer moved to
            absolute bottom below. */}
        {counter ? (
          <div className="relative mt-3 flex justify-center">
            <span className="rounded-full border border-cyan-400/25 bg-cyan-400/5 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
              {counter}
            </span>
          </div>
        ) : null}
      </div>

      {/* Quick actions — kanban-faithful cards, sized down so they stay
          clearly SECONDARY to the omnibar hero above (2-col vs kanban's 3,
          p-3 vs p-4, size-8 tile vs size-9). Each card FILLS the composer
          (setDraft + focus) for review/edit; it does NOT auto-send. The
          existing chip.prompt is shown clamped as a live preview of exactly
          what gets prefilled, so no new i18n desc strings are needed. */}
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
        className="mt-10 w-full max-w-3xl"
      >
        <div className="mb-3 flex items-center justify-center">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
            {t.basecamp.center.chipsLabel}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {chips.map((chip, i) => {
            const accent =
              QUICK_ACTION_ACCENTS[i % QUICK_ACTION_ACCENTS.length];
            return (
              <motion.button
                key={chip.label}
                type="button"
                initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: prefersReducedMotion ? 0 : 0.35 + i * 0.05,
                  duration: 0.3,
                }}
                onClick={() => {
                  // Write via store so the chip choice survives tab reload —
                  // same bucket as typed prose, ChatComposer inherits it too
                  // once the session has activity. FILLS the composer; does
                  // NOT auto-send.
                  setDraft(activeKey, chip.prompt);
                  inputRef.current?.focus();
                }}
                className="group/qa relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3 text-left transition hover:border-white/[0.14] hover:bg-white/[0.05] motion-reduce:transition-none"
              >
                <div
                  className={cn(
                    "pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-gradient-to-br opacity-40 blur-2xl transition-opacity group-hover/qa:opacity-70 motion-reduce:transition-none",
                    accent.glow,
                  )}
                />
                <div className="relative flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl border bg-[#0B0E14]/60 text-base leading-none",
                      accent.tile,
                    )}
                  >
                    {chip.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-white/90">
                      {chip.label}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-white/45">
                      {chip.prompt}
                    </span>
                    <span
                      className={cn(
                        "mt-2 inline-flex items-center gap-1 text-[11px] font-medium opacity-0 transition group-hover/qa:opacity-100 group-focus-visible/qa:opacity-100 motion-reduce:transition-none",
                        accent.hint,
                      )}
                    >
                      {t.basecamp.center.chipUse}
                      <ArrowRight className="size-3" />
                    </span>
                  </span>
                </div>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* Disclaimer — pinned to the bottom center of the Command Center
          panel, close to the bottom edge. Sits above the panel's rounded
          border but below all interactive content. */}
      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 px-4 text-center text-[11px] text-white/40">
        {t.basecamp.center.disclaimer}
      </p>
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
  // Per-kind thumbnail — images get the real preview, other kinds get an icon
  // + accent matching the basecamp palette (mirrors ChatComposer.DraftChip).
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
        aria-label={`Hapus lampiran ${draft.name}`}
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
