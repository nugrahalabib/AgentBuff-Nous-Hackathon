"use client";

/**
 * MessageReactions — chip row below a bubble showing aggregate reactions
 * for a single message. Each chip is `<emoji> <count>` with cyan accent
 * when the current user has reacted with that emoji. Click to toggle.
 *
 * + ReactionPicker — popover with the 12 default emoji + a smile button
 * that triggers the popover. Mounted on bubble hover.
 *
 * Telegram/Discord parity:
 *   - Telegram: long-press → emoji picker, tap chip to toggle
 *   - Discord: hover → reaction icon → emoji picker, click chip toggles
 *   /app uses hover + click; mobile is touch-friendly via tap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Smile } from "lucide-react";
import {
  applyReaction,
  DEFAULT_REACTION_EMOJI,
  loadReactions,
  subscribeReactions,
  type ReactionMap,
} from "@/lib/app/reactions";
import { ActionIcon } from "./message-actions";
import { cn } from "@/lib/utils";

const USER_ID_FALLBACK = "chief";

export function MessageReactions({
  sessionKey,
  messageId,
}: {
  sessionKey: string;
  messageId: string;
}) {
  const [map, setMap] = useState<ReactionMap>(() => loadReactions(sessionKey));
  useEffect(() => {
    setMap(loadReactions(sessionKey));
    return subscribeReactions(sessionKey, setMap);
  }, [sessionKey]);

  const reactions = map[messageId] ?? {};
  const entries = useMemo(() => Object.entries(reactions), [reactions]);

  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {entries.map(([emoji, users]) => {
        const reactedByMe = users.includes(USER_ID_FALLBACK);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() =>
              applyReaction(sessionKey, messageId, emoji, USER_ID_FALLBACK)
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
              reactedByMe
                ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-100"
                : "border-white/10 bg-white/[0.04] text-white/65 hover:border-white/20 hover:bg-white/[0.08]",
            )}
            title={`${users.length} reaksi`}
          >
            <span aria-hidden className="text-[13px] leading-none">
              {emoji}
            </span>
            <span className="font-mono tabular-nums">{users.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Inline emoji reaction trigger — designed to live INSIDE a
 *  `<BubbleActions>` toolbar (Discord-style consolidated action pill).
 *
 *  Renders as a single `<ActionIcon>` whose click toggles a popover
 *  with the default emoji grid. The popover is anchored to this
 *  component's own wrapper div, so it pops out from the toolbar pill
 *  (above or below depending on side).
 *
 *  Migrated from the older absolute-corner-button design (chief feedback:
 *  "banyak banget tombol" — old pattern had 5 separately-bordered icons
 *  at the bubble corner). All actions now share one pill container.
 */
export function ReactionPicker({
  sessionKey,
  messageId,
  side = "right",
}: {
  sessionKey: string;
  messageId: string;
  side?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onPick = useCallback(
    (emoji: string) => {
      applyReaction(sessionKey, messageId, emoji, USER_ID_FALLBACK);
      setOpen(false);
    },
    [sessionKey, messageId],
  );

  // Outside click + Esc closes the popover.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target || !rootRef.current) return;
      if (!rootRef.current.contains(target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <ActionIcon
        icon={<Smile className="size-3.5" />}
        label="Tambah reaksi"
        active={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {open ? (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            // Open DOWNWARD — toolbar is below the bubble; downward keeps
            // the emoji grid clear of the bubble text. Single-row picker
            // is short so it won't reach into the next message.
            "absolute top-full z-20 mt-1.5 flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#0B0E14]/97 px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.55)] backdrop-blur-md",
            side === "right" ? "right-0" : "left-0",
          )}
        >
          {DEFAULT_REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPick(emoji);
              }}
              className="flex size-7 items-center justify-center rounded-md text-[16px] transition hover:bg-white/[0.08]"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
