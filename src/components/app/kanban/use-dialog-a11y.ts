"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

/**
 * useDialogA11y — shared modal accessibility for the kanban overlays.
 *
 * Wires, against the panel element `ref`:
 *  - Escape closes the dialog (unless `disabled` is true — e.g. a mutation is
 *    in flight, matching the old per-overlay `!busy` guard).
 *  - Tab / Shift+Tab focus trap kept inside the panel (WCAG 2.1.2).
 *  - Initial focus moved to the first focusable element on open.
 *  - Focus restored to whatever was focused before the dialog opened, on unmount.
 *
 * The panel element itself should carry role="dialog" aria-modal="true"
 * aria-labelledby=<title id>. Pair this hook with those attributes.
 */
export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  disabled = false,
): void {
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!disabled) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    // Initial focus — first focusable inside the panel.
    queueMicrotask(() => {
      ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [ref, onClose, disabled]);
}
