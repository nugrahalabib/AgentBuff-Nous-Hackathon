"use client";

/**
 * Styled, on-brand replacements for window.confirm / window.prompt on the
 * kanban surface — native dialogs render OS chrome (English buttons) that
 * breaks the deep-space Bahasa UI. Both use useDialogA11y (Esc + focus trap +
 * restore) and match the other kanban overlays.
 */
import { useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useDialogA11y } from "./use-dialog-a11y";

export type ConfirmState = {
  title: string;
  body?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useDialogA11y(panelRef, onClose, busy);
  if (!state) return null;
  const destructive = state.destructive !== false;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kanban-confirm-title"
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border ${destructive ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-cyan-400/30 bg-cyan-400/10 text-cyan-300"}`}>
            <AlertTriangle className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 id="kanban-confirm-title" className="text-sm font-semibold text-white/90">{state.title}</h2>
            {state.body ? <p className="mt-1 text-xs leading-relaxed text-white/55">{state.body}</p> : null}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50">
            Batal
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${destructive ? "bg-red-500 text-white hover:brightness-110" : "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] hover:brightness-110"}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {state.confirmLabel ?? (destructive ? "Hapus" : "Lanjut")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PromptDialog({
  open,
  title,
  label,
  placeholder,
  confirmLabel,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error string to block submit, or null when valid. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useDialogA11y(panelRef, onClose, busy);
  if (!open) return null;

  const submit = async () => {
    const v = value.trim();
    const problem = validate ? validate(v) : v ? null : "Wajib diisi.";
    if (problem) {
      setErr(problem);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(v);
      setValue("");
      setErr(null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-prompt-title"
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl"
      >
        <div className="px-5 pt-5">
          <h2 id="kanban-prompt-title" className="text-sm font-semibold text-white/90">{title}</h2>
          <label htmlFor="kanban-prompt-input" className="mt-3 mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">{label}</label>
          <input
            id="kanban-prompt-input"
            value={value}
            onChange={(e) => { setValue(e.target.value); if (err) setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
            placeholder={placeholder}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
          {err ? <p role="alert" className="mt-1.5 text-xs text-red-300">{err}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50">
            Batal
          </button>
          <button type="button" onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {confirmLabel ?? "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
}
