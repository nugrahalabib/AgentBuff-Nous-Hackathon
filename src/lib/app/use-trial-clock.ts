"use client";

import { useEffect, useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days remaining (ceil), floored at 0. Mirrors the server resolver. */
export function daysLeftUntil(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / DAY_MS));
}

/**
 * Live trial countdown. Seeds from the server-computed `daysLeft` (so there's
 * no first-paint flash), then recomputes from `endsAt` every 60s on the client
 * — so a tab left open overnight rolls the counter without a reload.
 *
 * `endsAt` is the ISO string from resolveAccessState().trial; `serverDaysLeft`
 * is its already-computed daysLeft (used as the initial value).
 */
export function useTrialClock(
  endsAt: string | null | undefined,
  serverDaysLeft: number,
): number {
  const [days, setDays] = useState(serverDaysLeft);

  useEffect(() => {
    if (!endsAt) return;
    const endsAtMs = Date.parse(endsAt);
    if (!Number.isFinite(endsAtMs)) return;
    const recompute = () => setDays(daysLeftUntil(endsAtMs, Date.now()));
    recompute();
    const id = window.setInterval(recompute, 60_000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  return days;
}
