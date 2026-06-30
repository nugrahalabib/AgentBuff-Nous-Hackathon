"use client";

/**
 * Discord-style consolidated bubble action toolbar.
 *
 * Replaces the previous "stack of individual buttons with their own borders"
 * pattern (chief feedback: "banyak banget tombol aku jadi ngerasa ga nyaman").
 *
 * Design rationale, sourced from Discord / Slack / iMessage / WhatsApp UX:
 *
 *   1. SINGLE PILL CONTAINER. One shared border + background instead of 5
 *      individual bordered buttons. Visually reads as ONE component, not
 *      five competing for attention.
 *
 *   2. INLINE ICONS, NO PER-BUTTON BORDERS. Icons share the container and
 *      separate via subtle 1px vertical dividers. Hover affects only the
 *      icon's cell, not the whole toolbar.
 *
 *   3. PRIMARY ≤ 3 ACTIONS + OVERFLOW MENU. Anything beyond the 3 most-used
 *      actions hides behind a ⋯ "More" menu. Telegram does this on long-
 *      press; Discord does this on hover with a 3-dot. We follow the
 *      Discord pattern because we're hover-first (desktop).
 *
 *   4. APPEARS ON BUBBLE HOVER, FADES ON LEAVE. 150 ms transition. Stays
 *      visible if any child has focus (so keyboard nav doesn't blink it
 *      out mid-tab). Always-visible toolbars (Twitter/X style) compete
 *      with reading flow — hover-reveal keeps the transcript scannable.
 *
 *   5. POSITIONED ABOVE BUBBLE EDGE. `-top-3` offsets so the pill clears
 *      the bubble corner radius. Side mirrors the bubble's chat-edge:
 *      assistant bubble (left-aligned) → right edge; user bubble (right-
 *      aligned) → left edge. Always lands on the inside-of-conversation
 *      side, never overlapping the page chrome.
 *
 * Components exported:
 *   - <BubbleActions>   container pill (rounded, shared border + bg)
 *   - <ActionIcon>      single icon button (inline, no border, hover bg)
 *   - <MoreMenu>        ⋯ trigger + flyout panel
 *   - <MoreMenuItem>    item in the flyout (icon + label + danger variant)
 *
 * Usage:
 *     <BubbleActions side="right">
 *       <ActionIcon icon={<Smile />} label="Reaksi" onClick={...} />
 *       <ActionIcon icon={<Reply />} label="Balas" onClick={...} />
 *       <ActionIcon icon={<Copy />} label="Salin" onClick={...} />
 *       <MoreMenu side="right">
 *         <MoreMenuItem icon={<Bookmark />} label="Catatan" onClick={...} />
 *         <MoreMenuItem icon={<Trash2 />} label="Hapus" onClick={...} danger />
 *       </MoreMenu>
 *     </BubbleActions>
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

// Context lets MoreMenuItem auto-close the parent menu after click without
// each item caller having to wire it up explicitly.
const MoreMenuContext = createContext<{ close: () => void } | null>(null);

export function BubbleActions({
  side,
  children,
  className,
}: {
  side: "right" | "left";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Position: FULLY below the bubble — pill's top edge sits at the
        // bubble's bottom edge + a 4px gap (mt-1). Without `top-full`,
        // negative-bottom offsets (`-bottom-3` etc.) keep part of the
        // pill INSIDE the bubble area because the pill's intrinsic 28px
        // height extends downward from the offset point.
        //
        // chief feedback 2026-05-24: previous top-placement overlapped
        // bubble text — "kadang suka bikin nimpa tulisan di bubble nya".
        // Bottom placement matches Discord-on-mobile + Slack thread reply
        // patterns and never collides with the message above.
        //
        // For assistant bubble (left-aligned) → side="right" → right-2:
        // anchors to bubble's bottom-right corner.
        // For user bubble (right-aligned) → side="left" → left-2:
        // anchors to bubble's bottom-left corner.
        //
        // `top-full mt-1` — pill FULLY below the bubble with a 4px gap.
        // The 28px pill height extends 32px past the bubble bottom. The
        // chat transcript has gap-y-5 (20px) between turns, so the pill
        // overlaps ~12px into the next bubble's TOP PADDING area. Next
        // bubble's content is `py-3` (12px top padding) so the pill
        // never reaches the next bubble's TEXT. z-10 keeps the pill on
        // top during the brief hover overlap.
        "absolute top-full mt-1 z-10 inline-flex items-stretch overflow-visible rounded-lg border border-white/[0.08] bg-[#0B0E14]/95 shadow-[0_4px_14px_rgba(0,0,0,0.45)] backdrop-blur-md",
        // Hover-reveal: bubble's `group/bubble` controls visibility.
        // `group-focus-within` keeps the toolbar visible while keyboard
        // navigating between icons or while the More menu is open.
        "opacity-0 transition-opacity duration-150 group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100",
        side === "right" ? "right-2" : "left-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ActionIcon({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
  busy = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: (e: MouseEvent) => void;
  active?: boolean;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 items-center justify-center px-2 text-white/55 transition",
        "first:rounded-l-lg last:rounded-r-lg",
        "[&:not(:last-child)]:border-r [&:not(:last-child)]:border-white/[0.05]",
        "hover:bg-white/[0.07] hover:text-white",
        active && "bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/20",
        danger && "hover:bg-red-500/15 hover:text-red-200",
        busy && "cursor-wait opacity-70",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-white/55",
      )}
    >
      <span className={cn("inline-flex", busy && "animate-pulse")}>{icon}</span>
    </button>
  );
}

/**
 * ⋯ More menu — a trigger ActionIcon + a flyout panel with secondary
 * actions. Closes on outside click, Esc, and after item selection.
 */
export function MoreMenu({
  side,
  children,
}: {
  side: "right" | "left";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside click + Esc closes the menu.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: globalThis.MouseEvent) {
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

  const handleTrigger = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setOpen((o) => !o);
  }, []);

  // Children get a wrapper that auto-closes the menu on item click.
  const childrenWithClose = (
    <MoreMenuContext.Provider value={{ close: () => setOpen(false) }}>
      {children}
    </MoreMenuContext.Provider>
  );

  return (
    <div ref={rootRef} className="relative inline-flex">
      <ActionIcon
        icon={<MoreHorizontal className="size-3.5" />}
        label="Lainnya"
        onClick={handleTrigger}
        active={open}
      />
      {open ? (
        <div
          role="menu"
          className={cn(
            // Open DOWNWARD — toolbar sits BELOW the bubble; opening the
            // menu upward would push the panel into the bubble's text
            // area (the very thing chief wanted to avoid). Downward is
            // safe because the next message has visual breathing room
            // via the transcript's gap-y, and the panel is short (max
            // ~120px for 3 items).
            "absolute top-full z-20 mt-1.5 flex min-w-[170px] flex-col gap-0.5 rounded-lg border border-white/[0.08] bg-[#0B0E14]/97 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.55)] backdrop-blur-md",
            side === "right" ? "right-0" : "left-0",
          )}
        >
          {childrenWithClose}
        </div>
      ) : null}
    </div>
  );
}

export function MoreMenuItem({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const ctx = useContext(MoreMenuContext);
  const handleClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (disabled) return;
      onClick();
      ctx?.close();
    },
    [onClick, ctx, disabled],
  );
  return (
    <button
      type="button"
      role="menuitem"
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium text-white/85 transition",
        "hover:bg-white/[0.08]",
        danger && "text-red-200/90 hover:bg-red-500/15 hover:text-red-100",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-white/65">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
