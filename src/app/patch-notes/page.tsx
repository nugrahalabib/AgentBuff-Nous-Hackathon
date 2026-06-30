"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

export default function PatchNotesPage() {
  const { t } = useI18n();
  const pn = t.patchNotes;

  return (
    <div className="min-h-screen bg-[#030014] text-white">
      <header className="relative overflow-hidden border-b border-white/[0.06]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center sm:py-20">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-400/80">
            {pn.eyebrow}
          </p>
          <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">{pn.title}</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm text-white/45 leading-relaxed">
            {pn.subtitle}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="space-y-10">
          {pn.entries.map((entry) => (
            <article
              key={entry.version}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-cyan-500/[0.12] px-3 py-1 font-mono text-xs font-bold text-cyan-300">
                  {entry.version}
                </span>
                <span className="text-xs text-white/35">{entry.date}</span>
              </div>
              <h2 className="mt-3 text-base font-bold sm:text-lg">{entry.title}</h2>
              <ul className="mt-4 space-y-2">
                {entry.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-white/50"
                  >
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-cyan-400/50" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-12 flex items-center justify-center border-t border-white/[0.06] pt-8">
          <Link
            href="/"
            className="text-sm text-white/30 transition-colors hover:text-cyan-400/70"
          >
            {pn.backToHome}
          </Link>
        </div>
      </main>
    </div>
  );
}
