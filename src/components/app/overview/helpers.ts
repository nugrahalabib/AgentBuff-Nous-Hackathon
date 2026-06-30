/**
 * Shared helpers untuk overview sub-components. Pure functions, tidak ada
 * side effect, mudah di-test.
 */

import type { Dictionary } from "@/lib/i18n/types";

export type GreetingTime = "morning" | "afternoon" | "evening" | "night";

/**
 * Tentukan greeting berdasar jam local user.
 * - 5-11 = morning
 * - 11-15 = afternoon
 * - 15-18 = evening
 * - else = night (incl. dini hari)
 *
 * Pakai jam browser local (bukan WIB hardcoded) supaya user di luar Indonesia
 * (e.g. mahasiswa luar negeri yg langganan) tetap dapat greeting yang masuk akal.
 */
export function resolveGreeting(date: Date = new Date()): GreetingTime {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 15) return "afternoon";
  if (h >= 15 && h < 18) return "evening";
  return "night";
}

/**
 * Format angka pakai Indonesian locale separator.
 * 1234567 → "1.234.567"
 */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("id-ID").format(n);
}

/**
 * Format trend % untuk display (misal: "+30%", "-10%", "Sama").
 */
export function formatTrendPct(
  pct: number | null,
  t: Dictionary,
): { label: string; tone: "up" | "down" | "neutral" } {
  if (pct == null) {
    return { label: t.app.overview.todayStats.freshStart, tone: "neutral" };
  }
  if (pct === 0) {
    return { label: t.app.overview.todayStats.noChange, tone: "neutral" };
  }
  const sign = pct > 0 ? "+" : "";
  const rounded = Math.round(pct);
  return {
    label: `${sign}${rounded}% ${t.app.overview.todayStats.vsYesterday}`,
    tone: pct > 0 ? "up" : "down",
  };
}

/**
 * Format relative time pendek untuk strip header (Aktif sejak X).
 * Sangat compact: "2 jam", "5 hari", "baru saja".
 */
export function formatUptimeShort(ms: number | undefined | null): string {
  if (!ms || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} hari`;
  const months = Math.floor(days / 30);
  return `${months} bulan`;
}

/**
 * Format date string ISO ke "12 Mei 2026" Indonesian style.
 */
export function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Greeting full string: "Selamat pagi, Chief" gaya brand.
 */
export function buildGreetingText(
  greeting: GreetingTime,
  nickname: string | null | undefined,
  t: Dictionary,
): string {
  const time = t.app.overview.greeting[greeting];
  const name = nickname?.trim() || t.app.overview.greeting.fallbackName;
  return `${time}, ${name}.`;
}
