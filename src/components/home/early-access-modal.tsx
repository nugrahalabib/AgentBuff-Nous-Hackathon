"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, Loader2, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

type Props = {
  open: boolean;
  onClose: () => void;
  // Which offering the lead is interested in. Sent to the API for segmentation.
  tier?: string;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Early-access waitlist form. Opens from the landing pricing "Get Early Access"
 * CTA, posts to /api/early-access (which writes an `early_access_lead` row the
 * Admin page reads later). Replaces the old WhatsApp redirect — the data is
 * captured server-side, not bounced to a chat.
 */
export function EarlyAccessModal({ open, onClose, tier = "full-managed" }: Props) {
  const { t } = useI18n();
  const e = t.itemShop.earlyAccess;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape-to-close + body scroll lock + autofocus first field + FOCUS TRAP +
  // focus restoration (WCAG 2.4.3 / 2.1.2). While open, Tab / Shift+Tab cycle
  // within the dialog; on close, focus returns to the element that opened it.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
        return;
      }
      if (ev.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusId = setTimeout(() => firstFieldRef.current?.focus(), 80);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(focusId);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [open, onClose]);

  // Reset success/error a moment after close so the exit animation stays clean.
  useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setDone(false);
      setError("");
    }, 250);
    return () => clearTimeout(id);
  }, [open]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError("");
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) {
      setError(e.errorRequired);
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError(e.errorEmail);
      return;
    }
    setSubmitting(true);
    // UTM attribution (D10): capture utm_* from the landing URL so the admin can
    // see where a lead came from. Only the 5 standard keys; omitted if none.
    const sp = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    for (const k of ["source", "medium", "campaign", "term", "content"]) {
      const v = sp.get(`utm_${k}`);
      if (v) utm[k] = v.slice(0, 120);
    }
    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          whatsapp: whatsapp.trim() || undefined,
          note: note.trim() || undefined,
          tier,
          utm: Object.keys(utm).length > 0 ? utm : undefined,
        }),
      });
      if (res.ok) {
        setDone(true);
        setName("");
        setEmail("");
        setWhatsapp("");
        setNote("");
        return;
      }
      setError(res.status === 429 ? e.errorRateLimited : e.errorGeneric);
    } catch {
      setError(e.errorGeneric);
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    "h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-sm text-white placeholder:text-white/30 transition-colors focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <button
            type="button"
            aria-label={e.close}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-[#030014]/80 backdrop-blur-sm"
          />

          {/* Dialog */}
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="early-access-title"
            className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900/95 to-[#0B0E14]/95 p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl sm:p-7"
            initial={{ y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ y: 24, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Glow accent */}
            <div className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-cyan-500/15 blur-3xl" />

            <button
              type="button"
              onClick={onClose}
              aria-label={e.close}
              className="absolute right-4 top-4 z-10 flex size-8 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"
            >
              <X className="size-4" aria-hidden="true" />
            </button>

            {done ? (
              <div className="relative flex flex-col items-center py-4 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-[0_0_30px_rgba(16,185,129,0.4)]">
                  <Check className="size-7 text-white" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-white">{e.successTitle}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{e.successBody}</p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/[0.1] hover:text-white"
                >
                  {e.close}
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="relative">
                <div className="flex items-center gap-2">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500">
                    <Sparkles className="size-4 text-white" aria-hidden="true" />
                  </div>
                  <h3
                    id="early-access-title"
                    className="text-lg font-bold text-white"
                    style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
                  >
                    {e.title}
                  </h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{e.subtitle}</p>

                <div className="mt-5 flex flex-col gap-3.5">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-white/60">{e.nameLabel}</span>
                    <input
                      ref={firstFieldRef}
                      id="ea-name"
                      name="name"
                      type="text"
                      value={name}
                      onChange={(ev) => setName(ev.target.value)}
                      placeholder={e.namePlaceholder}
                      maxLength={120}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? "early-access-error" : undefined}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-white/60">{e.emailLabel}</span>
                    <input
                      id="ea-email"
                      name="email"
                      type="email"
                      value={email}
                      onChange={(ev) => setEmail(ev.target.value)}
                      placeholder={e.emailPlaceholder}
                      maxLength={254}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? "early-access-error" : undefined}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-white/60">{e.whatsappLabel}</span>
                    <input
                      type="tel"
                      value={whatsapp}
                      onChange={(ev) => setWhatsapp(ev.target.value)}
                      placeholder={e.whatsappPlaceholder}
                      maxLength={40}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-white/60">{e.noteLabel}</span>
                    <textarea
                      value={note}
                      onChange={(ev) => setNote(ev.target.value)}
                      placeholder={e.notePlaceholder}
                      maxLength={1000}
                      rows={3}
                      className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 transition-colors focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
                    />
                  </label>
                </div>

                {error && (
                  <p
                    id="early-access-error"
                    role="alert"
                    className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 via-indigo-500 to-violet-500 px-4 py-3 text-sm font-bold text-white shadow-[0_0_25px_-5px_rgba(6,182,212,0.5)] transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  {submitting ? e.submitting : e.submit}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
