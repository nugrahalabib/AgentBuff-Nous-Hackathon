"use client";

import { useState } from "react";

// D1 — sticky banner shown in /app when the current session is an admin
// impersonation. Makes the "acting as someone else" state impossible to miss and
// gives a one-click way back to the admin session.
export function ImpersonationBanner() {
  const [busy, setBusy] = useState(false);

  async function stop() {
    setBusy(true);
    try {
      const res = await fetch("/api/impersonate/stop", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string };
      window.location.href = data.redirect ?? "/admin";
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-[12px] text-amber-100 backdrop-blur-md">
      <span className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]" />
      <span>
        Mode admin: kamu sedang <strong>menyamar sebagai user ini</strong>.
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="rounded border border-amber-400/60 bg-amber-500/20 px-2 py-0.5 font-medium text-amber-50 hover:bg-amber-500/30 disabled:opacity-50"
      >
        {busy ? "Keluar…" : "Berhenti menyamar"}
      </button>
    </div>
  );
}
