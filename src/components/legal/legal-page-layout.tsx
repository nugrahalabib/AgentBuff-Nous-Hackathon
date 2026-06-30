"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

interface Section {
  readonly id: string;
  readonly title: string;
  readonly tldr: string;
  readonly body: string;
}

interface Pillar {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly tldr: string;
  readonly bullets: readonly string[];
  readonly badge?: string;
}

export function LegalPageLayout({
  heroTitle,
  sections,
  pillars,
}: {
  heroTitle: string;
  sections: readonly Section[];
  pillars?: readonly Pillar[];
}) {
  const { t } = useI18n();
  const lg = t.legal;

  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll spy
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    function handleScroll() {
      const sectionEls = container!.querySelectorAll("[data-section-id]");
      let current = "";
      for (const el of sectionEls) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 160) {
          current = (el as HTMLElement).dataset.sectionId ?? "";
        }
      }
      if (current) setActiveId(current);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = contentRef.current?.querySelector(`[data-section-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Build full ToC: sections + pillar headers
  const tocItems = [
    ...sections.map((s) => ({ id: s.id, title: s.title })),
    ...(pillars?.map((p) => ({ id: p.id, title: p.title })) ?? []),
  ];

  return (
    <div className="min-h-screen bg-[#030014] text-white">
      {/* Hero Banner */}
      <header className="relative overflow-hidden border-b border-white/[0.06]">
        {/* Grid bg */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-0 size-[400px] rounded-full blur-[150px]"
          style={{ background: "radial-gradient(closest-side, rgba(34,211,238,0.10), transparent)" }}
        />

        <div className="relative mx-auto max-w-5xl px-6 py-16 text-center sm:py-20">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-400/80">
            {lg.bannerEyebrow}
          </p>
          <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">{lg.bannerTitle}</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm text-white/45 leading-relaxed">
            {lg.bannerSubtitle}
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-4 py-1.5 text-[11px] text-white/35">
            <span>{lg.lastUpdatedPrefix}</span>
            <span className="font-semibold text-white/50">{lg.lastUpdatedDate}</span>
          </div>

          {/* Document type badge */}
          <div className="mt-5">
            <span className="rounded-lg bg-cyan-500/[0.08] border border-cyan-500/20 px-4 py-1.5 text-sm font-bold text-cyan-300">
              {heroTitle}
            </span>
          </div>

          {/* Nav links to sibling doc */}
          <div className="mt-4 flex items-center justify-center gap-4 text-xs">
            <Link href="/privacy" className="text-white/30 transition-colors hover:text-cyan-400/70">
              {t.legal.privacy.heroTitle}
            </Link>
            <span className="text-white/10">|</span>
            <Link href="/terms" className="text-white/30 transition-colors hover:text-cyan-400/70">
              {t.legal.terms.heroTitle}
            </Link>
          </div>
        </div>
      </header>

      {/* Split layout */}
      <div className="mx-auto flex max-w-5xl">
        {/* Sticky ToC (left) */}
        <aside className="hidden w-[260px] shrink-0 lg:block">
          <nav className="sticky top-0 max-h-screen overflow-y-auto py-8 pr-6 pl-6">
            <p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">
              {lg.tocTitle}
            </p>
            <ul className="space-y-1">
              {tocItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => scrollTo(item.id)}
                    className={cn(
                      "w-full truncate rounded-md px-3 py-1.5 text-left text-[12px] transition-colors",
                      activeId === item.id
                        ? "bg-cyan-500/[0.08] font-semibold text-cyan-300"
                        : "text-white/35 hover:bg-white/[0.03] hover:text-white/55",
                    )}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* Content canvas (right) */}
        <div
          ref={contentRef}
          className="flex-1 overflow-y-auto border-l border-white/[0.04] lg:border-l"
        >
          <div className="mx-auto max-w-[720px] px-6 py-10 sm:px-10">
            {/* Sections */}
            {sections.map((section) => (
              <article
                key={section.id}
                data-section-id={section.id}
                className="mb-12 scroll-mt-8"
              >
                <h2 className="text-base font-extrabold sm:text-lg">{section.title}</h2>

                {/* TL;DR card */}
                <div className="mt-4 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] p-4">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm">💡</span>
                    <p className="text-[13px] font-medium leading-relaxed text-cyan-200/80">
                      <span className="mr-1 font-bold text-cyan-400">TL;DR:</span>
                      {section.tldr}
                    </p>
                  </div>
                </div>

                {/* Legalese */}
                <p className="mt-4 text-[13px] leading-[1.8] text-white/40">
                  {section.body}
                </p>
              </article>
            ))}

            {/* Pillars (privacy page only) */}
            {pillars && pillars.length > 0 && (
              <div className="mt-4 border-t border-white/[0.06] pt-10">
                <div className="grid gap-6">
                  {pillars.map((pillar) => (
                    <div
                      key={pillar.id}
                      data-section-id={pillar.id}
                      className="scroll-mt-8 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex size-12 items-center justify-center rounded-xl bg-white/[0.06] text-2xl">
                          {pillar.icon}
                        </span>
                        <div>
                          <h3 className="text-base font-extrabold">{pillar.title}</h3>
                          {pillar.badge && (
                            <span className="mt-1 inline-block rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                              {pillar.badge}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* TL;DR */}
                      <div className="mt-4 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] p-3">
                        <p className="flex items-start gap-2 text-[12px] leading-relaxed text-amber-200/70">
                          <span className="mt-0.5">💡</span>
                          {pillar.tldr}
                        </p>
                      </div>

                      {/* Bullets */}
                      <ul className="mt-4 space-y-2">
                        {pillar.bullets.map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-white/50">
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-cyan-400/50" />
                            {b}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Back to top + home */}
            <div className="mt-12 flex items-center justify-center gap-4 border-t border-white/[0.06] pt-8 text-xs">
              <Link href="/" className="text-white/30 transition-colors hover:text-cyan-400/70">
                ← Home
              </Link>
              <span className="text-white/10">|</span>
              <Link href="/app" className="text-white/30 transition-colors hover:text-cyan-400/70">
                App
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
