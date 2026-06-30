"use client";

/**
 * Energy Teaser Strip — non-dominant footnote (BYOK-phase).
 *
 * KOREKSI BISNIS MODEL (Chief 2026-06-02 + redesign 2026-06-10):
 *   AgentBuff saat ini full BYOK — user bawa API key & pilih model sendiri,
 *   jadi belum ada "energy" beneran. Versi lama komponen ini adalah HERO
 *   terbesar dashboard yang isinya cuma "Segera Hadir" → prime real-estate
 *   terbuang + bikin tab Ringkasan terasa hampar.
 *
 *   Chief minta teaser energy tetap ada (priming model berbayar ke depan) tapi
 *   KECIL & non-dominan. Komponen ini sekarang strip tipis satu baris, jujur:
 *   gak ada counter palsu, gak ada CTA Top Up ke skema yang belum ada. Focal
 *   point dashboard pindah ke CommandCenterHero.
 */
import { Clock, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

export function EnergyTeaserStrip() {
  const { t } = useI18n();
  const e = t.app.overview.energy;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-amber-400/15 bg-amber-400/[0.03] px-4 py-2.5 backdrop-blur-md sm:flex-row sm:items-center sm:gap-3"
      aria-label={e.stripTitle}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-orange-500 text-[#0B0E14]"
        >
          <Zap className="size-3" strokeWidth={2.5} />
        </span>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200/85">
          {e.stripTitle}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-amber-200">
          <Clock className="size-2.5" aria-hidden />
          {e.comingSoonBadge}
        </span>
      </span>
      <span className="text-[12px] leading-snug text-white/45 sm:ml-1">
        {e.stripNote}
      </span>
    </div>
  );
}
