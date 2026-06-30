"use client";

/**
 * CronModalShell — reusable centered modal primitive untuk semua cron flows.
 *
 * Accessibility:
 *  - Esc to close (kalau closeOnEsc tidak di-disable)
 *  - Backdrop click close (kalau closeOnBackdrop tidak di-disable)
 *  - Body scroll lock saat open
 *  - Focus trap basic (initial focus ke first focusable in body)
 *  - role="dialog" + aria-modal="true" + aria-labelledby
 *
 * Animation: framer-motion spring scale + opacity, ~280ms enter/exit.
 */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ModalWidth = "md" | "lg" | "xl" | "2xl" | "3xl";

const WIDTH_CLASS: Record<ModalWidth, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
};

export function CronModalShell({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  width = "2xl",
  children,
  footer,
  closeOnBackdrop = true,
  closeOnEsc = true,
  headerExtras,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  subtitle?: string;
  width?: ModalWidth;
  children: React.ReactNode;
  footer?: React.ReactNode;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  /** Extra controls rendered to the left of the close button. */
  headerExtras?: React.ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc + body scroll lock + initial focus + FOCUS TRAP + focus restore.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    // Restore focus to whatever was focused before the dialog opened. (Audit a11y.)
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const FOCUSABLE =
      'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEsc) {
        e.stopPropagation();
        onClose();
        return;
      }
      // Focus trap — keep Tab within the dialog (Tab must not escape to the
      // background page behind the modal). (Audit a11y SC 2.1.2.)
      if (e.key === "Tab") {
        const root = dialogRef.current;
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
      }
    };
    document.addEventListener("keydown", handleKey);
    // Initial focus — first focusable in body
    queueMicrotask(() => {
      const root = dialogRef.current;
      if (!root) return;
      root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose, closeOnEsc]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
        >
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Tutup"
            tabIndex={-1}
            onClick={closeOnBackdrop ? onClose : undefined}
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
          />

          {/* Dialog */}
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cron-modal-title"
            initial={{ scale: 0.96, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className={cn(
              "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7),0_0_0_1px_rgba(34,211,238,0.06)]",
              WIDTH_CLASS[width],
            )}
          >
            {/* Animated top gradient border */}
            <motion.span
              aria-hidden
              className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500"
              animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
              transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
              style={{ backgroundSize: "200% 100%" }}
            />

            {/* Header */}
            <header className="shrink-0 border-b border-white/[0.06] bg-[#0B0E14]/95 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {eyebrow ? (
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
                      ✦ {eyebrow}
                    </div>
                  ) : null}
                  <h2
                    id="cron-modal-title"
                    className="mt-0.5 truncate font-display text-lg font-bold text-white sm:text-xl"
                  >
                    {title}
                  </h2>
                  {subtitle ? (
                    <p className="mt-0.5 text-[12px] text-white/55">
                      {subtitle}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {headerExtras}
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Tutup"
                    className="rounded-md p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
            </header>

            {/* Body — scrollable */}
            <div
              ref={bodyRef}
              className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-5"
            >
              {children}
            </div>

            {/* Footer — sticky */}
            {footer ? (
              <footer className="shrink-0 border-t border-white/[0.06] bg-[#0B0E14]/95 px-5 py-3.5 backdrop-blur-xl">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
