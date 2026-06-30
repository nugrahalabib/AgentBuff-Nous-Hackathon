"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "radix-ui";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "./enums";
import { TONE_DOT } from "./enums";

// ---------------------------------------------------------------------------
// Toast (self-contained — no sonner dependency)
// ---------------------------------------------------------------------------

type ToastTone = "ok" | "bad" | "info";
type ToastItem = { id: number; message: string; tone: ToastTone; action?: { label: string; onClick: () => void } };

type ToastApi = {
  toast: (message: string, opts?: { tone?: ToastTone; action?: { label: string; onClick: () => void } }) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? { toast: (m) => console.warn("[toast:no-provider]", m) };
}

let toastSeq = 1;

const TOAST_ICON: Record<ToastTone, ReactNode> = {
  ok: <CheckCircle2 className="size-4 text-emerald-400" />,
  bad: <XCircle className="size-4 text-red-400" />,
  info: <Info className="size-4 text-cyan-400" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastApi["toast"]>(
    (message, opts) => {
      const id = toastSeq++;
      setItems((xs) => [...xs, { id, message, tone: opts?.tone ?? "ok", action: opts?.action }]);
      setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-xl"
          >
            <span className="mt-0.5 shrink-0">{TOAST_ICON[t.tone]}</span>
            <p className="flex-1 text-sm text-zinc-200">{t.message}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  remove(t.id);
                }}
                className="shrink-0 text-xs font-medium text-cyan-400 hover:text-cyan-300"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" onClick={() => remove(t.id)} aria-label="Tutup" className="shrink-0">
              <X className="size-3.5 text-zinc-500 hover:text-zinc-200" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Drawer (radix Dialog, slides from the right)
// ---------------------------------------------------------------------------

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl outline-none",
            width,
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold text-zinc-100">{title}</Dialog.Title>
              {subtitle && <div className="truncate text-xs text-zinc-500">{subtitle}</div>}
            </div>
            <Dialog.Close
              aria-label="Tutup"
              className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDialog (radix Dialog, optional type-to-confirm + summary)
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  body,
  confirmLabel = "Lanjutkan",
  cancelLabel = "Batal",
  danger,
  loading,
  typeToConfirm,
  summary,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  typeToConfirm?: string;
  summary?: { label: string; value: ReactNode; tone?: Tone }[];
}) {
  const [typed, setTyped] = useState("");
  // Reset the type-to-confirm field each time the dialog opens, without an
  // effect (adjust-state-during-render pattern React recommends).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped("");
  }
  const canConfirm = !loading && (!typeToConfirm || typed === typeToConfirm);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl outline-none">
          <div className="flex items-start gap-3">
            {danger && (
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400">
                <AlertTriangle className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-zinc-100">{title}</Dialog.Title>
              {body && (
                <Dialog.Description asChild>
                  <div className="mt-1.5 text-sm text-zinc-400">{body}</div>
                </Dialog.Description>
              )}
            </div>
          </div>

          {summary && summary.length > 0 && (
            <dl className="mt-3 space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
              {summary.map((s, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="text-zinc-500">{s.label}</dt>
                  <dd className="text-right font-medium text-zinc-200">
                    {s.tone && (
                      <span className={cn("mr-1 inline-block size-1.5 rounded-full align-middle", TONE_DOT[s.tone])} />
                    )}
                    {s.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {typeToConfirm && (
            <div className="mt-3">
              <label className="text-xs text-zinc-400">
                Ketik <span className="font-mono font-semibold text-zinc-100">{typeToConfirm}</span> untuk konfirmasi:
              </label>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-red-500/50 focus:ring-2 focus:ring-red-500/30"
              />
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40",
                danger ? "bg-red-500 text-white hover:bg-red-600" : "bg-cyan-500 text-zinc-950 hover:bg-cyan-400",
              )}
            >
              {loading ? "Memproses…" : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
