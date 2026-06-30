"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { siteConfig } from "@/lib/constants";
import { AuthVisual } from "./auth-visual";

export function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#030014] text-white">
      {/* Cyber grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,.35) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse at center, black 35%, transparent 80%)",
        }}
      />

      {/* Noise */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.6 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      {/* Ambient glows — cyan + magenta */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 size-[540px] rounded-full blur-[140px]"
        style={{ background: "radial-gradient(closest-side, rgba(34,211,238,0.45), transparent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-52 -right-40 size-[620px] rounded-full blur-[160px]"
        style={{ background: "radial-gradient(closest-side, rgba(217,70,239,0.4), transparent)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 left-1/2 size-[320px] -translate-x-1/2 rounded-full blur-[120px]"
        style={{ background: "radial-gradient(closest-side, rgba(129,140,248,0.35), transparent)" }}
      />

      {/* Top bar */}
      <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8 sm:py-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <div className="relative">
            <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 opacity-60 blur-md transition-opacity group-hover:opacity-90" />
            <Image
              src="/images/logo.png"
              alt={siteConfig.name}
              width={32}
              height={32}
              className="relative size-8 rounded-lg"
            />
          </div>
          <span className="text-base font-bold tracking-tight">
            {siteConfig.name}
          </span>
        </Link>

        <Link
          href="/"
          className="group inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-white/70 backdrop-blur-md transition-all hover:border-cyan-400/40 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
          {t.auth.backToHome}
        </Link>
      </header>

      {/* Split content */}
      <main id="main-content" className="relative z-10 mx-auto flex min-h-[calc(100vh-88px)] max-w-7xl flex-col items-stretch gap-6 px-5 pb-10 sm:px-8 lg:grid lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-16">
        {/* Left — visual */}
        <div className="order-2 lg:order-1">
          <AuthVisual />
        </div>

        {/* Right — form */}
        <div className="order-1 flex items-center justify-center lg:order-2">
          <div className="relative w-full max-w-[460px]">
            {/* Glowing border */}
            <div
              aria-hidden
              className="absolute -inset-px rounded-[1.4rem] bg-gradient-to-br from-cyan-400/40 via-indigo-400/10 to-fuchsia-500/40 opacity-70 blur-[2px]"
            />
            <div className="relative rounded-[1.35rem] border border-white/10 bg-white/[0.04] p-7 shadow-[0_30px_80px_-20px_rgba(8,145,178,0.35)] backdrop-blur-2xl sm:p-9">
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
