"use client";

/**
 * AgentModalShell — centered modal primitive untuk semua agen flows.
 * Mirror of CronModalShell (cron tab) supaya pattern modal di seluruh app
 * konsisten: animated gradient border, Esc-close, backdrop click, body
 * scroll lock, focus trap.
 */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ModalWidth = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";

const WIDTH_CLASS: Record<ModalWidth, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
};

export function AgentModalShell({
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
  headerExtras?: React.ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEsc) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    queueMicrotask(() => {
      const root = dialogRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])',
      );
      first?.focus();
    });
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
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
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onClick={closeOnBackdrop ? onClose : undefined}
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-modal-title"
            initial={{ scale: 0.96, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className={cn(
              "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7),0_0_0_1px_rgba(34,211,238,0.06)]",
              WIDTH_CLASS[width],
            )}
          >
            <motion.span
              aria-hidden
              className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500"
              animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
              transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
              style={{ backgroundSize: "200% 100%" }}
            />

            <header className="shrink-0 border-b border-white/[0.06] bg-[#0B0E14]/95 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {eyebrow ? (
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
                      ✦ {eyebrow}
                    </div>
                  ) : null}
                  <h2
                    id="agent-modal-title"
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
                    aria-label="Close"
                    className="rounded-md p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
            </header>

            <div
              ref={bodyRef}
              className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-5"
            >
              {children}
            </div>

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
