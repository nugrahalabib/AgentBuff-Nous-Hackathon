"use client";

/**
 * CronOverviewStrip — hero 3-tile dengan animated gradient border kalau
 * cron engine aktif. Status / Total / Lari berikutnya.
 */
import { motion } from "framer-motion";
import { AlarmClock, Power, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatNextRun, type CronStatusResult } from "./helpers";

export function CronOverviewStrip({
  status,
  totalEnabled,
  totalRunning,
}: {
  status: CronStatusResult | null;
  totalEnabled: number;
  totalRunning: number;
}) {
  const engineOn = !!status?.enabled;
  const total = status?.jobs ?? 0;
  const nextWake = status?.nextWakeAtMs ?? undefined;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-2xl border p-5 backdrop-blur-xl",
        engineOn
          ? "border-cyan-400/30 bg-gradient-to-br from-[#0B0E14] via-[#0B0E14] to-[#0E1421] shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_28px_64px_-24px_rgba(99,102,241,0.45)]"
          : "border-white/[0.08] bg-[#0B0E14]/60",
      )}
    >
      {engineOn ? (
        <>
          <motion.span
            aria-hidden
            className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500"
            animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
            style={{ backgroundSize: "200% 100%" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-12 top-1/2 h-48 w-48 -translate-y-1/2 rounded-full bg-cyan-500/15 blur-[80px]"
          />
        </>
      ) : null}

      <div className="relative grid gap-4 md:grid-cols-3">
        <Tile
          icon={Power}
          tone={engineOn ? "emerald" : "slate"}
          label="Engine Otomatis"
          value={engineOn ? "Aktif" : "Nyambung…"}
          sub={
            engineOn
              ? "Penjadwal selalu jalan — rutinitas dieksekusi otomatis sesuai jadwal"
              : "Menyambung ke engine…"
          }
        />
        <Tile
          icon={Sparkles}
          tone={total > 0 ? "cyan" : "slate"}
          label="Rutinitas"
          value={`${totalEnabled} / ${total}`}
          sub={
            total > 0
              ? `${totalRunning > 0 ? `${totalRunning} lagi jalan · ` : ""}${total - totalEnabled} di-pause`
              : "Belum ada rutinitas. Bikin sekarang!"
          }
        />
        <Tile
          icon={AlarmClock}
          tone={nextWake ? "fuchsia" : "slate"}
          label="Lari Berikutnya"
          value={nextWake ? formatNextRun(nextWake) : "—"}
          sub={
            nextWake
              ? "Rutinitas terdekat siap dieksekusi"
              : "Belum ada rutinitas aktif"
          }
        />
      </div>
    </section>
  );
}

type Tone = "cyan" | "indigo" | "fuchsia" | "emerald" | "amber" | "red" | "slate";

function Tile({
  icon: Icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: typeof Sparkles;
  tone: Tone;
  label: string;
  value: string;
  sub?: string;
}) {
  const iconColor =
    tone === "cyan"
      ? "text-cyan-300"
      : tone === "indigo"
        ? "text-indigo-300"
        : tone === "fuchsia"
          ? "text-fuchsia-300"
          : tone === "emerald"
            ? "text-emerald-300"
            : tone === "amber"
              ? "text-amber-300"
              : tone === "red"
                ? "text-red-300"
                : "text-white/45";
  const valueColor =
    tone === "cyan"
      ? "text-cyan-100"
      : tone === "indigo"
        ? "text-indigo-100"
        : tone === "fuchsia"
          ? "text-fuchsia-100"
          : tone === "emerald"
            ? "text-emerald-100"
            : tone === "amber"
              ? "text-amber-100"
              : tone === "red"
                ? "text-red-100"
                : "text-white/75";
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        <Icon className={cn("size-3.5", iconColor)} aria-hidden />
        {label}
      </div>
      <div className={cn("mt-1 font-display text-2xl font-bold", valueColor)}>
        {value}
      </div>
      {sub ? (
        <p className="mt-1 text-[11px] leading-snug text-white/55">{sub}</p>
      ) : null}
    </article>
  );
}
