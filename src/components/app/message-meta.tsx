"use client";

/**
 * Per-message usage footer shown under an assistant bubble.
 *
 * Visual idiom ported from openclaw ui-agentbuff:
 *   `src/ui/chat/grouped-render.ts::renderMessageMeta`  (ordering + formatting)
 *   `src/styles/chat/grouped.css` lines 353–393         (typography + colors)
 *
 * Differences from openclaw:
 *  - NO clock / timestamp here — the WhatsApp-style HH:MM now lives INSIDE
 *    the bubble's bottom-right corner (see `chat-thread.tsx::BubbleTime`),
 *    so this footer is pure usage metadata (tokens + context % + model).
 *  - No `$cost` chip — /app abstracts tokens into Energy via Postgres ledger,
 *    raw USD cost would confuse users (our pricing is IDR + energy units).
 *  - Model pill uses a cyan-tinted chip (basecamp accent).
 *  - Context % colors: neutral by default, amber at ≥75%, red at ≥90%.
 */

import { useMemo } from "react";
import type { MessageMeta as MessageMetaType } from "@/lib/app/session-utils";
import { formatTokens, shortenModel } from "@/lib/app/session-utils";
import { cn } from "@/lib/utils";

type Props = {
  meta: MessageMetaType | null | undefined;
  /** Session-level context window (tokens). Combined with `meta.input` to
   *  compute contextPercent. Skipped when unknown. */
  contextTokens?: number;
};

export function MessageMeta({ meta, contextTokens }: Props) {
  const ctxPct = useMemo<number | null>(() => {
    if (!meta || !contextTokens) return null;
    if (meta.input <= 0) return null;
    const pct = Math.round((meta.input / contextTokens) * 100);
    return Math.min(100, Math.max(0, pct));
  }, [meta, contextTokens]);

  const hasAnyUsage =
    !!meta &&
    (meta.input > 0 ||
      meta.output > 0 ||
      meta.cacheRead > 0 ||
      meta.cacheWrite > 0 ||
      !!meta.model);
  if (!hasAnyUsage) return null;

  const ctxCls =
    ctxPct == null
      ? null
      : ctxPct >= 90
      ? "text-red-300/90"
      : ctxPct >= 75
      ? "text-amber-300/90"
      : "text-white/55";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-white/35">
      {meta?.input ? (
        <span
          className="inline-flex items-center gap-0.5 tabular-nums"
          title={`Input: ${meta.input.toLocaleString("id-ID")} token`}
        >
          <span aria-hidden>↑</span>
          <span>{formatTokens(meta.input)}</span>
        </span>
      ) : null}

      {meta?.output ? (
        <span
          className="inline-flex items-center gap-0.5 tabular-nums"
          title={`Output: ${meta.output.toLocaleString("id-ID")} token`}
        >
          <span aria-hidden>↓</span>
          <span>{formatTokens(meta.output)}</span>
        </span>
      ) : null}

      {meta?.cacheRead ? (
        <span
          className="inline-flex items-center gap-0.5 tabular-nums text-emerald-300/55"
          title={`Cache read: ${meta.cacheRead.toLocaleString("id-ID")} token`}
        >
          <span aria-hidden>R</span>
          <span>{formatTokens(meta.cacheRead)}</span>
        </span>
      ) : null}

      {meta?.cacheWrite ? (
        <span
          className="inline-flex items-center gap-0.5 tabular-nums text-fuchsia-300/55"
          title={`Cache write: ${meta.cacheWrite.toLocaleString("id-ID")} token`}
        >
          <span aria-hidden>W</span>
          <span>{formatTokens(meta.cacheWrite)}</span>
        </span>
      ) : null}

      {ctxPct != null ? (
        <span
          className={cn("tabular-nums", ctxCls)}
          title={`Context window terpakai: ${ctxPct}%`}
        >
          {ctxPct}% ctx
        </span>
      ) : null}

      {meta?.model ? (
        <span
          className="inline-flex items-center rounded-full border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-[1px] text-[9.5px] text-cyan-200/70"
          title={`Model: ${meta.model}`}
        >
          {shortenModel(meta.model)}
        </span>
      ) : null}

      {/* BYOK PHASE (Chief 2026-06-02): chip "energy per balasan" dihapus —
          belum ada energy currency (user pakai key sendiri). Token + model di
          atas sudah cukup informatif & jujur untuk BYOK. */}
    </div>
  );
}
