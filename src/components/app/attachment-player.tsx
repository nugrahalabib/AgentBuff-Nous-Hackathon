"use client";

/**
 * Shared audio player — Telegram/WhatsApp-style custom UI replacing
 * Chrome's broken `<audio controls>` for MediaRecorder WebM output.
 *
 * Why custom vs `<audio controls>`:
 *   * Chrome's native controls show "0:00 / 0:00" for MediaRecorder WebM
 *     (chromium issue 642012 — missing Duration field in container).
 *   * Native controls require `display: block` or visible audio element,
 *     awkward to style consistently with AgentBuff's design system.
 *
 * Why this pattern:
 *   * Uses `document.createElement("audio")` + `canplay` event listener
 *     (MDN Web Dictaphone canonical pattern, proven in production since
 *     2014). Avoids `new Audio()` race condition that surfaces as
 *     NotSupportedError before bytes are sniffed.
 *   * Drives playback state via React state, reads `audio.currentTime`
 *     for live progress (reliable even when duration is bogus).
 *   * Accepts an OPTIONAL `knownDurationMs` prop — when the caller
 *     knows the real duration (e.g. from MediaRecorder elapsed timer),
 *     we use it instead of `audio.duration`. This matters for
 *     MediaRecorder WebM where audio.duration is Infinity until
 *     playback fully completes.
 *
 * Used by:
 *   - Composer VN preview (records → previews before sending)
 *   - Message audio attachments (echoes user-sent audio files)
 *
 * Reference: https://github.com/mdn/dom-examples/blob/main/media/web-dictaphone/scripts/app.js
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Play, Square } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  downloadAttachment,
  formatPlaybackTime,
} from "@/lib/app/attachment-actions";

export type AudioPlayerProps = {
  /** Blob URL / data URL / same-origin path to the audio resource. */
  src: string;
  /** Filename used when chief clicks the download button. */
  filename: string;
  /** Optional caller-supplied duration in ms. When provided we display
   *  this instead of `audio.duration` (which is unreliable for
   *  MediaRecorder WebM). */
  knownDurationMs?: number;
  /** Visual variant — "compact" for inline message bubbles, "wide" for
   *  the VN preview panel above the omnibar. */
  variant?: "compact" | "wide";
  /** Show the download button. Default true. */
  showDownload?: boolean;
  /** Optional className for the outer container. */
  className?: string;
  /** Optional "voice note" badge prefix (e.g. for WA-style "Voice note · 0:05"
   *  display). Pass null to skip. */
  label?: string | null;
};

/** Number of waveform "bars" rendered in the progress strip. Telegram
 *  uses ~48; we go ~40 for a balance between detail and DOM weight. */
const WAVEFORM_BARS = 40;

/** Deterministic pseudo-waveform — Telegram synthesises one when the
 *  server hasn't returned real amplitude data. We do the same: hash the
 *  filename so each VN has a stable but distinct shape, mapped to bar
 *  heights between 0.25 and 1.0 of the strip height. */
function synthesiseWaveform(filename: string): number[] {
  let seed = 0;
  for (let i = 0; i < filename.length; i++) {
    seed = ((seed << 5) - seed + filename.charCodeAt(i)) | 0;
  }
  // Linear congruential generator — fast, deterministic, no crypto needed.
  const next = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
  const bars: number[] = [];
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    // Mix in a slight sin curve so bars look more "voice-like" (peaks in
    // the middle of speech bursts rather than pure white noise).
    const noise = next();
    const curve = 0.6 + 0.4 * Math.sin((i / WAVEFORM_BARS) * Math.PI * 3);
    bars.push(Math.min(1, Math.max(0.18, 0.25 + 0.75 * noise * curve)));
  }
  return bars;
}

export function AudioPlayer({
  src,
  filename,
  knownDurationMs,
  variant = "compact",
  showDownload = true,
  className,
  label = null,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [errored, setErrored] = useState(false);
  // Detected duration from the audio element. Fallback to knownDurationMs.
  const [detectedMs, setDetectedMs] = useState<number | null>(null);

  // Stable waveform PER filename — recompute when filename changes (e.g.
  // composer switches from preview to a new VN file, or chat-side AudioCard
  // gets reused for a different file via React reconciliation).
  const waveform = useMemo(
    () => synthesiseWaveform(filename),
    [filename],
  );

  useEffect(() => {
    // Reset per-source state when src changes (e.g. composer switches VNs).
    setPlaying(false);
    setCurrentMs(0);
    setAudioReady(false);
    setErrored(false);
    setDetectedMs(null);

    if (!src) return;

    // MDN Web Dictaphone pattern — createElement + canplay event + load().
    // Avoids `new Audio(src).play()` race that surfaces as NotSupportedError.
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.src = src;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => {
      setCurrentMs(Math.round((audio.currentTime || 0) * 1000));
    };
    const onEnded = () => {
      setPlaying(false);
      // Snap progress to end so the UI shows full bar before reset on next play.
      const finalMs =
        knownDurationMs ??
        (Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : currentMs);
      setCurrentMs(finalMs);
    };
    const onCanPlay = () => setAudioReady(true);
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDetectedMs(audio.duration * 1000);
      }
    };
    const onError = () => {
      setErrored(true);
      setAudioReady(false);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("error", onError);

    try {
      audio.load();
    } catch {
      /* idempotent */
    }
    audioRef.current = audio;

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("error", onError);
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {
        /* idempotent */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, knownDurationMs, filename]);

  /** Total duration shown in the UI. Prefer caller-supplied (most reliable),
   *  then detected from audio element, fallback to currentMs (when both
   *  upstream values are missing). */
  const totalMs =
    knownDurationMs && knownDurationMs > 0
      ? knownDurationMs
      : detectedMs && detectedMs > 0
        ? detectedMs
        : Math.max(currentMs, 0);

  const progress = totalMs > 0 ? Math.min(1, currentMs / totalMs) : 0;

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Restart from 0 if we played through.
      if (totalMs > 0 && currentMs >= totalMs - 100) {
        try {
          audio.currentTime = 0;
        } catch {
          /* idempotent */
        }
      }
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // play() rejection (autoplay policy / decode failure) — surface
          // by setting errored so the caller can fall back to download.
          setErrored(true);
        });
      }
    } else {
      audio.pause();
    }
  }, [currentMs, totalMs]);

  /** Click anywhere on the waveform to seek. Useful for chief skipping
   *  to a specific point in a long VN. */
  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !totalMs || errored) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      try {
        audio.currentTime = (ratio * totalMs) / 1000;
        setCurrentMs(Math.round(ratio * totalMs));
      } catch {
        /* idempotent */
      }
    },
    [totalMs, errored],
  );

  const onDownload = useCallback(() => {
    downloadAttachment(src, filename);
  }, [src, filename]);

  const sizing =
    variant === "wide"
      ? {
          container: "w-full max-w-xl",
          waveBars: "h-10",
        }
      : {
          // Wider compact card so the 40-bar waveform actually breathes.
          // Old `max-w-[280px]` left ~190px after play+gap+download which
          // squeezed bars to ~2px wide — visually invisible. 360px gives
          // ~270px for the bar row, ~5-6px per bar with gap — readable
          // waveform like Telegram/WhatsApp.
          container: "w-full min-w-[300px] max-w-[360px]",
          waveBars: "h-9",
        };

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-fuchsia-400/25 bg-[#0B0E14]/80 px-3 py-2 backdrop-blur-sm",
        sizing.container,
        className,
      )}
    >
      {/* Play / pause / disabled circle */}
      <motion.button
        type="button"
        onClick={togglePlayback}
        disabled={!audioReady || errored}
        whileTap={{ scale: 0.92 }}
        aria-label={playing ? "Pause" : "Putar audio"}
        title={errored ? "Audio gagal di-decode" : playing ? "Pause" : "Putar"}
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center rounded-full transition",
          errored
            ? "cursor-not-allowed bg-red-500/15 text-red-300"
            : !audioReady
              ? "cursor-not-allowed bg-white/[0.06] text-white/30"
              : playing
                ? "bg-fuchsia-400/25 text-fuchsia-100 shadow-[0_0_18px_rgba(217,70,239,0.45)] hover:bg-fuchsia-400/35"
                : "bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_12px_rgba(217,70,239,0.25)] hover:bg-fuchsia-400/25",
        )}
      >
        {playing ? (
          <Square className="size-3.5 fill-current" />
        ) : (
          <Play className="ml-0.5 size-3.5 fill-current" />
        )}
      </motion.button>

      {/* Waveform + time */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        {label ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-200/70">
            {label}
          </span>
        ) : null}
        <div
          onClick={handleSeek}
          role="slider"
          aria-label="Posisi audio"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={errored ? -1 : 0}
          className={cn(
            "relative flex items-center gap-[2px]",
            sizing.waveBars,
            errored ? "cursor-not-allowed" : "cursor-pointer",
          )}
        >
          {waveform.map((bar, i) => {
            const barProgress = (i + 0.5) / WAVEFORM_BARS;
            const isPlayed = barProgress <= progress;
            // Identify the leading edge bar — the one currently "playing"
            // — so we can pulse it for the lively Telegram-style cue.
            const isLeadingEdge =
              playing && Math.abs(barProgress - progress) < 1 / WAVEFORM_BARS;
            return (
              <span
                key={i}
                aria-hidden
                className={cn(
                  "block flex-1 min-w-[2px] rounded-full transition-colors duration-150",
                  isPlayed
                    ? "bg-gradient-to-t from-fuchsia-400 via-cyan-300 to-fuchsia-200 shadow-[0_0_3px_rgba(217,70,239,0.45)]"
                    : "bg-white/25",
                  isLeadingEdge && "animate-pulse",
                )}
                style={{ height: `${Math.max(20, bar * 100)}%` }}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] tabular-nums text-white/55">
            {formatPlaybackTime(currentMs)} / {formatPlaybackTime(totalMs)}
          </span>
          {errored ? (
            <span className="text-[10px] text-red-300/80">decode error</span>
          ) : null}
        </div>
      </div>

      {/* Download */}
      {showDownload ? (
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download audio"
          title="Download audio"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          <Download className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
