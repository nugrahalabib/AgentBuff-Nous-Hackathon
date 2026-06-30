"use client";

import Link from "next/link";
import Image from "next/image";
import { siteConfig } from "@/lib/constants";
import { useI18n } from "@/lib/i18n/context";

/* ═══════════════════════════════════════════════════════
   Footer — "The Neon Basecamp"
   Gamer-hustler vibe, glassmorphism social icons,
   neon glow top border, hover arrow indicators.
   ═══════════════════════════════════════════════════════ */

function SocialIcon({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="group flex size-10 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-slate-500 backdrop-blur-md transition-all duration-300 hover:border-cyan-500/40 hover:bg-cyan-50 hover:text-cyan-600 hover:shadow-[0_0_15px_-3px_rgba(6,182,212,0.3)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/40 dark:hover:border-cyan-400/30 dark:hover:bg-cyan-400/[0.08] dark:hover:text-cyan-400"
    >
      {children}
    </a>
  );
}

function FooterLink({ href, label, external }: { href: string; label: string; external?: boolean }) {
  const inner = (
    <span className="group flex items-center gap-1.5 text-sm text-slate-500 transition-all duration-200 hover:text-cyan-600 dark:text-white/35 dark:hover:text-cyan-400">
      {/* Arrow indicator on hover */}
      <Image
        src="/images/logo.png"
        alt=""
        width={12}
        height={12}
        className="size-3 opacity-0 transition-all duration-200 group-hover:opacity-60"
      />
      {label}
    </span>
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return <Link href={href}>{inner}</Link>;
}

export function Footer() {
  const { t } = useI18n();
  const f = t.footer;

  return (
    <footer className="relative bg-slate-50 dark:bg-[#030014]">
      {/* ── Neon Top Border Glow ── */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
      <div className="absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-cyan-400/[0.04] to-transparent" />

      <div className="relative z-10 mx-auto max-w-7xl px-4 pb-8 pt-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6 lg:gap-12">
          {/* ═══ Brand Column (spans 2) ═══ */}
          <div className="col-span-2">
            {/* Logo */}
            <Link href="/" className="group inline-flex items-center gap-2.5">
              <div className="relative">
                <Image
                  src="/images/logo.png"
                  alt={siteConfig.name}
                  width={36}
                  height={36}
                  className="drop-shadow-[0_0_8px_rgba(6,182,212,0.4)]"
                />
              </div>
              <span
                className="text-xl font-black tracking-tight text-slate-900 dark:text-white"
                style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
              >
                {siteConfig.name}
              </span>
            </Link>

            {/* Tagline */}
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-600 dark:text-white/30">
              {f.tagline}
            </p>

            {/* Social Icons — glassmorphism circles */}
            <div className="mt-6 flex items-center gap-3">
              {/* X / Twitter */}
              <SocialIcon href={siteConfig.links.twitter} label="X / Twitter">
                <svg viewBox="0 0 24 24" className="size-4 fill-current">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </SocialIcon>

              {/* Instagram */}
              <SocialIcon href={siteConfig.links.instagram} label="Instagram">
                <svg viewBox="0 0 24 24" className="size-4 fill-current">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                </svg>
              </SocialIcon>

              {/* TikTok */}
              <SocialIcon href={siteConfig.links.tiktok} label="TikTok">
                <svg viewBox="0 0 24 24" className="size-4 fill-current">
                  <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.75a8.18 8.18 0 004.77 1.52V6.84a4.83 4.83 0 01-1-.15z" />
                </svg>
              </SocialIcon>

              {/* Discord */}
              <SocialIcon href={siteConfig.links.discord} label="Discord">
                <svg viewBox="0 0 24 24" className="size-4 fill-current">
                  <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </SocialIcon>
            </div>
          </div>

          {/* ═══ Column 1: PRODUCT ═══ */}
          <div>
            <h3
              className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-white/20"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {f.product}
            </h3>
            <ul className="mt-4 space-y-3">
              <li><FooterLink href="#item-shop" label={f.productItemShop} /></li>
              <li><FooterLink href="#item-shop" label={f.productPricing} /></li>
              <li><FooterLink href="/seller" label={f.becomeSeller} /></li>
            </ul>
          </div>

          {/* ═══ Column 2: PLAYER GUIDE ═══ */}
          <div>
            <h3
              className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-white/20"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {f.playerGuide}
            </h3>
            <ul className="mt-4 space-y-3">
              <li><FooterLink href={`${siteConfig.links.docs}/getting-started`} label={f.starterPack} external /></li>
              <li><FooterLink href={siteConfig.links.docs} label={f.documentation} external /></li>
              <li><FooterLink href="/patch-notes" label={f.patchNotes} /></li>
            </ul>
          </div>

          {/* ═══ Column 3: GUILD COMMUNITY ═══ */}
          <div>
            <h3
              className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-white/20"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {f.guildCommunity}
            </h3>
            <ul className="mt-4 space-y-3">
              <li><FooterLink href={siteConfig.links.twitter} label={f.followTwitter} external /></li>
              <li><FooterLink href={siteConfig.links.instagram} label={f.followInstagram} external /></li>
              <li><FooterLink href={siteConfig.links.tiktok} label={f.followTiktok} external /></li>
            </ul>
          </div>

          {/* ═══ Column 4: LEGAL ═══ */}
          <div>
            <h3
              className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-white/20"
              style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
            >
              {f.legal}
            </h3>
            <ul className="mt-4 space-y-3">
              <li><FooterLink href="/privacy" label={f.privacyPolicy} /></li>
              <li><FooterLink href="/terms" label={f.termsOfService} /></li>
            </ul>
          </div>
        </div>

        {/* ═══ Bottom Credits ═══ */}
        <div className="mt-14 border-t border-slate-200 pt-6 dark:border-white/[0.06]">
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <p className="text-xs text-slate-500 dark:text-white/20">
              {f.builtBy}{" "}
              <span className="text-slate-700 dark:text-white/35">{siteConfig.creator}</span>
            </p>
            <p className="text-xs text-slate-500 dark:text-white/20">
              &copy; {new Date().getFullYear()} {siteConfig.name}. {f.madeIn}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
