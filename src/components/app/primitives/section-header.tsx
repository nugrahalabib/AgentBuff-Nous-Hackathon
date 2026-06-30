"use client";

/**
 * SectionHeader — eyebrow + title + subtitle + optional action slot.
 * Every tab opens with one of these so the chrome stays consistent with
 * the basecamp M7 glass language.
 *
 * Eyebrow = font-mono 10px uppercase 0.24em — matches command-center hero
 * and chat workspace header.
 */
import type { ReactNode } from "react";

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-white/[0.06] bg-[#0B0E14]/40 px-6 py-5 backdrop-blur-xl sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-400/5 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/90">
          <span className="size-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.85)]" />
          {eyebrow}
        </span>
        <h1 className="text-xl font-semibold text-white/90 sm:text-2xl">
          {title}
        </h1>
        {subtitle ? (
          <p className="max-w-2xl text-sm text-white/55">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
