"use client";

/**
 * EmptyState — dashed-border glass card for "nothing here yet" surfaces.
 * Dipakai list-tab saat data kosong, atau placeholder tab sebelum slice
 * landed (body = "coming soon" copy).
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-6 my-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-12 text-center backdrop-blur-xl">
      {Icon ? (
        <div className="relative flex size-12 items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-400/30 to-fuchsia-500/30 opacity-60 blur-lg" />
          <Icon className="relative size-6 text-white/65" aria-hidden />
        </div>
      ) : null}
      <h2 className="text-base font-semibold text-white/85">{title}</h2>
      {subtitle ? (
        <p className="max-w-md text-sm text-white/55">{subtitle}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
