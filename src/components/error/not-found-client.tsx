"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { siteConfig } from "@/lib/constants";

export function NotFoundClient() {
  const { t } = useI18n();
  const e = t.errorPages.notFound;
  const router = useRouter();

  const [countdown, setCountdown] = useState<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interacted = useRef(false);

  // Start 10s idle detection
  useEffect(() => {
    function resetIdle() {
      interacted.current = true;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setCountdown(null);
    }
    function startIdle() {
      idleTimer.current = setTimeout(() => {
        if (!interacted.current) {
          setCountdown(5);
        }
      }, 10000);
    }

    document.addEventListener("click", resetIdle);
    document.addEventListener("mousemove", resetIdle, { once: true });
    startIdle();

    return () => {
      document.removeEventListener("click", resetIdle);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Countdown → redirect
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      router.push("/");
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => (c ?? 1) - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, router]);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#030014] px-4 text-center text-white">
      {/* Broken grid background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 70%)",
        }}
      />

      {/* Ambient glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-1/4 size-[400px] rounded-full blur-[150px]"
        style={{ background: "radial-gradient(closest-side, rgba(34,211,238,0.15), transparent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 bottom-1/4 size-[400px] rounded-full blur-[150px]"
        style={{ background: "radial-gradient(closest-side, rgba(217,70,239,0.12), transparent)" }}
      />

      {/* Mascot */}
      <div className="relative mb-6">
        <span className="text-6xl">🗺️</span>
      </div>

      {/* Glitch 404 */}
      <div className="relative mb-6">
        <h1
          className="select-none font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px]"
          style={{
            background: "linear-gradient(135deg, #22d3ee, #a855f7, #ec4899)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            textShadow: "none",
          }}
        >
          {e.code}
        </h1>
        {/* Glitch layers */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px] animate-pulse"
          style={{
            background: "linear-gradient(135deg, #22d3ee, transparent)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            clipPath: "polygon(0 0, 100% 0, 100% 45%, 0 45%)",
            transform: "translate(3px, -2px)",
            opacity: 0.4,
          }}
        >
          {e.code}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 font-display text-[120px] font-black leading-none tracking-tighter sm:text-[160px] animate-pulse"
          style={{
            background: "linear-gradient(135deg, #ec4899, transparent)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            clipPath: "polygon(0 55%, 100% 55%, 100% 100%, 0 100%)",
            transform: "translate(-3px, 2px)",
            opacity: 0.4,
            animationDelay: "150ms",
          }}
        >
          {e.code}
        </span>

        {/* Scan line */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(34,211,238,0.03) 2px, rgba(34,211,238,0.03) 4px)",
          }}
        />
      </div>

      {/* Copy */}
      <h2 className="text-xl font-extrabold sm:text-2xl">{e.headline}</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/45">
        {e.subtitle}
      </p>

      {/* Actions */}
      <div className="mt-8 flex flex-col items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500/25 to-fuchsia-500/25 px-8 py-3.5 text-sm font-bold text-white transition-all hover:from-cyan-500/35 hover:to-fuchsia-500/35 hover:shadow-[0_0_30px_rgba(34,211,238,0.2)]"
        >
          {e.primaryCta}
        </Link>
        <div className="flex items-center gap-4 text-xs">
          <Link
            href="/#item-shop"
            className="text-white/35 transition-colors hover:text-cyan-400/70"
          >
            {e.secondaryShop}
          </Link>
          <span className="text-white/10">|</span>
          <a
            href={siteConfig.whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/35 transition-colors hover:text-cyan-400/70"
          >
            {e.secondaryReport}
          </a>
        </div>
      </div>

      {/* Easter egg countdown */}
      {countdown !== null && countdown > 0 && (
        <p className="fixed bottom-6 left-1/2 -translate-x-1/2 animate-pulse font-mono text-xs text-white/25">
          {e.easterEggPrefix}{countdown}{e.easterEggSuffix}
        </p>
      )}
    </div>
  );
}
