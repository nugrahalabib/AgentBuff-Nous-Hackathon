"use client";

/**
 * LiveActivityBar — animated agent-busy indicator. Mirrors Hermes TUI's
 * status line content (15 FACES × 15 VERBS rotating at 2.5s tick) but
 * with a brand-consistent calm-yet-eye-catching visual.
 *
 * Renders INSIDE the composer surface (chat-composer.tsx swaps the
 * textarea for this bar while `streaming || sending` is true). That
 * gives the user one obvious signal: "agent is busy, you can't type
 * right now — press Esc or Stop to interrupt."
 *
 * Animations are driven by CSS @keyframes (`agentbuff-bar-*` classes in
 * globals.css). Framer Motion v12 doesn't reliably animate multi-shadow
 * box-shadow strings; CSS keyframes don't have that limitation and they
 * also benefit from `prefers-reduced-motion` out of the box.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import type { ThinkingBlock } from "@/lib/hermes/rpc-types";

const HERMES_FACES = [
  "(｡•́︿•̀｡)",
  "(◔_◔)",
  "(¬‿¬)",
  "( •_•)>⌐■-■",
  "(⌐■_■)",
  "(´･_･`)",
  "◉_◉",
  "(°ロ°)",
  "( ˘⌣˘)♡",
  "ヽ(>∀<☆)☆",
  "٩(๑❛ᴗ❛๑)۶",
  "(⊙_⊙)",
  "(¬_¬)",
  "( ͡° ͜ʖ ͡°)",
  "ಠ_ಠ",
];

const HERMES_VERBS = [
  "pondering",
  "contemplating",
  "musing",
  "cogitating",
  "ruminating",
  "deliberating",
  "mulling",
  "reflecting",
  "processing",
  "reasoning",
  "analyzing",
  "computing",
  "synthesizing",
  "formulating",
  "brainstorming",
];

const HERMES_FACE_TICK_MS = 2500;
const VERB_PAD_LEN =
  HERMES_VERBS.reduce((m, v) => Math.max(m, v.length), 0) + 1;
const padVerb = (v: string) => (v + "…").padEnd(VERB_PAD_LEN, " ");

function fmtHermesDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

export function useAgentBusy(): boolean {
  const streaming = useAppStore(
    (s) => Boolean(s.streaming[s.activeSessionKey]),
  );
  const sending = useAppStore(
    (s) => s.sending[s.activeSessionKey] ?? false,
  );
  return streaming || sending;
}

export function LiveActivityBar() {
  const { t } = useI18n();
  const streaming = useAppStore(
    (s) => s.streaming[s.activeSessionKey] ?? null,
  );
  const sending = useAppStore(
    (s) => s.sending[s.activeSessionKey] ?? false,
  );
  const abortActive = useAppStore((s) => s.abortActive);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [faceTick, setFaceTick] = useState(() =>
    Math.floor(Math.random() * 1000),
  );
  const [verbTick, setVerbTick] = useState(() =>
    Math.floor(Math.random() * HERMES_VERBS.length),
  );
  const startedAtRef = useRef<number | null>(null);

  const active = Boolean(streaming) || sending;

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return;
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const tickElapsed = () =>
      setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    tickElapsed();
    const clock = window.setInterval(tickElapsed, 1000);
    const face = window.setInterval(
      () => setFaceTick((n) => n + 1),
      HERMES_FACE_TICK_MS,
    );
    const verb = window.setInterval(
      () => setVerbTick((n) => n + 1),
      HERMES_FACE_TICK_MS,
    );
    return () => {
      window.clearInterval(clock);
      window.clearInterval(face);
      window.clearInterval(verb);
    };
  }, [active]);

  const latestRealReasoning = useMemo(() => {
    const blocks = streaming?.blocks ?? [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i] as ThinkingBlock;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        const t = b.thinking.trim();
        if (t) return t;
      }
    }
    return "";
  }, [streaming]);

  const face = HERMES_FACES[faceTick % HERMES_FACES.length];
  const verb = HERMES_VERBS[verbTick % HERMES_VERBS.length];
  // Demo polish: the VISIBLE bar always shows the branded Indonesian verb animation,
  // never the model's raw English chain-of-thought (that stays only in the hover title).
  const display = padVerb(verb);

  const handleAbort = useCallback(() => {
    void abortActive();
  }, [abortActive]);

  if (!active) return null;

  return (
    <div
      className="agentbuff-bar-glow relative flex w-full items-center gap-3 overflow-hidden rounded-[1rem] border border-fuchsia-400/30 bg-[#0B0E14]/85 px-4 py-3 backdrop-blur-xl"
      role="status"
      aria-live="polite"
      title={
        latestRealReasoning ||
        `${face} ${verb}… · ${fmtHermesDuration(elapsedMs)}`
      }
    >
      {/* Ambient inner radial glow — soft fuchsia (left) + cyan (right) */}
      <span
        aria-hidden
        className="agentbuff-bar-ambient pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 4% 50%, rgba(217,70,239,0.22), transparent 45%), radial-gradient(circle at 96% 50%, rgba(34,211,238,0.14), transparent 50%)",
        }}
      />

      {/* Left rail — gradient + pulsing glow shadow */}
      <span
        aria-hidden
        className="agentbuff-bar-rail absolute left-0 top-0 h-full w-[4px] bg-gradient-to-b from-cyan-300 via-fuchsia-400 to-fuchsia-500"
      />

      {/* Top + bottom shimmer sweeps — offset phase for data-flow feel */}
      <span
        aria-hidden
        className="agentbuff-shimmer-sweep absolute top-0 left-0 h-[1.5px] w-1/3 bg-gradient-to-r from-transparent via-cyan-300 to-transparent"
        style={{ filter: "drop-shadow(0 0 8px rgba(34,211,238,0.9))" }}
      />
      <span
        aria-hidden
        className="agentbuff-shimmer-sweep-delayed absolute bottom-0 left-0 h-[1.5px] w-1/3 bg-gradient-to-r from-transparent via-fuchsia-400 to-transparent"
        style={{ filter: "drop-shadow(0 0 8px rgba(217,70,239,0.9))" }}
      />

      {/* Twinkling sparkles — staggered delays via inline style */}
      {SPARKLE_POSITIONS.map((pos, i) => (
        <span
          key={i}
          aria-hidden
          className="agentbuff-sparkle-twinkle pointer-events-none absolute size-[3px] rounded-full bg-white"
          style={{
            left: `${pos.x}%`,
            top: `${pos.y}%`,
            boxShadow:
              "0 0 8px rgba(255,255,255,0.95), 0 0 14px rgba(217,70,239,0.6)",
            animationDelay: `${pos.delay}s`,
          }}
        />
      ))}

      {/* Typing dots — staggered bounce */}
      <div className="relative flex shrink-0 items-end gap-1.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="agentbuff-typing-bounce block size-[6px] rounded-full bg-gradient-to-br from-cyan-300 to-fuchsia-400"
            style={{
              boxShadow:
                "0 0 10px rgba(217,70,239,0.9), 0 0 4px rgba(34,211,238,0.7)",
              animationDelay: `${i * 0.18}s`,
            }}
          />
        ))}
      </div>

      {/* Kaomoji + verb — fade-in entrance per face/verb tick via key */}
      <div className="relative flex min-w-0 flex-1 items-baseline gap-2">
        <span
          key={face}
          className="agentbuff-fade-in shrink-0 font-mono text-[17px] leading-none text-white"
          style={{
            textShadow:
              "0 0 12px rgba(217,70,239,0.7), 0 0 22px rgba(34,211,238,0.4)",
          }}
        >
          {face}
        </span>
        {latestRealReasoning ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-white/90">
            {display}
          </span>
        ) : (
          <span
            key={verb}
            className="agentbuff-fade-in min-w-0 flex-1 truncate bg-gradient-to-r from-cyan-200 via-white to-fuchsia-200 bg-clip-text font-mono text-[13.5px] font-medium text-transparent"
          >
            {verb}…
          </span>
        )}
      </div>

      {/* Elapsed pill — fuchsia tint with breathing glow */}
      <div className="agentbuff-elapsed-glow relative flex shrink-0 items-center gap-1.5 rounded-full border border-fuchsia-400/40 bg-fuchsia-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums text-fuchsia-100">
        <span
          aria-hidden
          className="block size-1.5 animate-pulse rounded-full bg-fuchsia-300"
          style={{ boxShadow: "0 0 6px rgba(217,70,239,0.95)" }}
        />
        {fmtHermesDuration(elapsedMs)}
      </div>

      <span
        aria-hidden
        className="relative hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.22em] text-white/45 lg:inline"
      >
        {t.app.chat.liveBar.escToStop}
      </span>

      {/* Stop button — gradient + pulsing red halo + shimmer pass */}
      <button
        type="button"
        onClick={handleAbort}
        className="agentbuff-stop-glow group relative shrink-0 overflow-hidden rounded-lg border border-red-400/60 bg-gradient-to-br from-red-500 to-rose-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white transition-transform hover:scale-105 active:scale-95"
        title={t.app.chat.liveBar.stopAgentTitle}
        aria-label={t.app.chat.liveBar.stopAgentAria}
      >
        <span
          aria-hidden
          className="agentbuff-stop-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />
        <span className="relative">{t.app.chat.liveBar.stop}</span>
      </button>
    </div>
  );
}

const SPARKLE_POSITIONS = [
  { x: 28, y: 22, delay: 0 },
  { x: 52, y: 70, delay: 0.5 },
  { x: 78, y: 30, delay: 1.0 },
];
