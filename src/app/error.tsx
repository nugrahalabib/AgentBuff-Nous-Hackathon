"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  const e = t.errorPages.serverError;

  const [stage, setStage] = useState<"idle" | "pinging" | "cooldown">("idle");
  const [cooldownSecs, setCooldownSecs] = useState(0);

  const handleRefresh = useCallback(() => {
    if (stage !== "idle") return;
    setStage("pinging");

    setTimeout(() => {
      try {
        reset();
      } catch {
        // still broken
      }
      setStage("cooldown");
      setCooldownSecs(10);
    }, 2000);
  }, [stage, reset]);

  // Cooldown timer
  useEffect(() => {
    if (stage !== "cooldown" || cooldownSecs <= 0) {
      if (stage === "cooldown" && cooldownSecs <= 0) setStage("idle");
      return;
    }
    const timer = setTimeout(() => setCooldownSecs((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [stage, cooldownSecs]);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#030014] px-4 text-center text-white">
      {/* Alert ambient — red/amber */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-1/3 size-[500px] rounded-full blur-[180px]"
        style={{ background: "radial-gradient(closest-side, rgba(239,68,68,0.12), transparent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 bottom-1/3 size-[500px] rounded-full blur-[180px]"
        style={{ background: "radial-gradient(closest-side, rgba(245,158,11,0.10), transparent)" }}
      />

      {/* Grid with alert tint */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(239,68,68,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(239,68,68,0.03) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 70%)",
        }}
      />

      {/* Mascot */}
      <div className="relative mb-6">
        <span className="text-6xl">🔧</span>
      </div>

      {/* 500 with red/amber glitch */}
      <div className="relative mb-6">
        <h1
          className="select-none font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px]"
          style={{
            background: "linear-gradient(135deg, #ef4444, #f59e0b, #ef4444)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          {e.code}
        </h1>
        {/* Glitch layers */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px] animate-pulse"
          style={{
            background: "linear-gradient(135deg, #f59e0b, transparent)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            clipPath: "polygon(0 0, 100% 0, 100% 45%, 0 45%)",
            transform: "translate(2px, -1px)",
            opacity: 0.5,
          }}
        >
          {e.code}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px] animate-pulse"
          style={{
            background: "linear-gradient(135deg, #ef4444, transparent)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            clipPath: "polygon(0 55%, 100% 55%, 100% 100%, 0 100%)",
            transform: "translate(-2px, 1px)",
            opacity: 0.5,
            animationDelay: "200ms",
          }}
        >
          {e.code}
        </span>

        {/* Scan lines */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(239,68,68,0.02) 2px, rgba(239,68,68,0.02) 4px)",
          }}
        />
      </div>

      {/* Copy */}
      <h2 className="text-xl font-extrabold sm:text-2xl">{e.headline}</h2>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-white/45">
        {e.subtitle}
      </p>

      {/* Actions */}
      <div className="mt-8 flex flex-col items-center gap-4">
        <button
          type="button"
          disabled={stage !== "idle"}
          onClick={handleRefresh}
          className={`inline-flex items-center gap-2 rounded-xl border px-8 py-3.5 text-sm font-bold transition-all ${
            stage === "idle"
              ? "border-amber-500/30 bg-amber-500/[0.08] text-amber-300 hover:bg-amber-500/[0.15] hover:shadow-[0_0_20px_rgba(245,158,11,0.15)]"
              : "border-white/[0.06] bg-white/[0.03] text-white/30 cursor-not-allowed"
          }`}
        >
          {stage === "pinging" && (
            <span className="size-4 animate-spin rounded-full border-2 border-amber-400/20 border-t-amber-400/70" />
          )}
          {stage === "idle" && e.refreshCta}
          {stage === "pinging" && e.refreshingLabel}
          {stage === "cooldown" && `${e.refreshCooldown} (${cooldownSecs}s)`}
        </button>

        <a
          href={e.statusUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-white/35 transition-colors hover:text-amber-400/70"
        >
          {e.statusCta}
        </a>
      </div>
    </div>
  );
}
