"use client";

import { Printer } from "lucide-react";

export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 via-indigo-500 to-fuchsia-500 px-5 py-2.5 text-[14px] font-semibold text-white shadow-lg transition-all hover:brightness-110 active:scale-[0.98]"
    >
      <Printer className="size-4" aria-hidden />
      {label}
    </button>
  );
}
