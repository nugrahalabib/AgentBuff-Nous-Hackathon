"use client";

import { useCallback } from "react";
import { useAppStore } from "@/lib/app/store";
import {
  classifyErrorMessage,
  openEnergyVaultPopup,
  openUpgradePopup,
  type ErrorAction,
} from "@/lib/app/errors";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** Renders the classified session-level error with action buttons.
 *  Used inline at the bottom of the chat thread, anchored to the active
 *  session. Separate from per-message `state === "error"` bubbles (those
 *  carry their own context and are rendered by ChatThread). */
export function ErrorBanner({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss: () => void;
  className?: string;
}) {
  const classified = classifyErrorMessage(message);

  const handleAction = useCallback(
    (action: ErrorAction) => {
      switch (action.kind) {
        case "topup": {
          openEnergyVaultPopup();
          return;
        }
        case "upgrade": {
          openUpgradePopup();
          return;
        }
        case "login": {
          // Hard redirect so NextAuth rehydrates fresh; preserve the current
          // path so user lands back here after login.
          const next =
            typeof window !== "undefined"
              ? encodeURIComponent(window.location.pathname)
              : "/app";
          if (typeof window !== "undefined") {
            window.location.href = `/login?next=${next}`;
          }
          return;
        }
        case "reload": {
          if (typeof window !== "undefined") window.location.reload();
          return;
        }
        case "dismiss":
        default: {
          onDismiss();
          return;
        }
      }
    },
    [onDismiss],
  );

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100 backdrop-blur-md",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-[3px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/40 bg-red-500/20 text-[11px] font-bold text-red-100"
        >
          !
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight">{classified.title}</p>
          <p className="mt-0.5 break-words text-xs text-red-200/90">
            {classified.body}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-8">
        {classified.actions.map((action, idx) => (
          <ActionButton
            key={`${action.kind}-${idx}`}
            action={action}
            primary={idx === 0}
            onClick={() => handleAction(action)}
          />
        ))}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  primary,
  onClick,
}: {
  action: ErrorAction;
  primary: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const LABELS: Record<ErrorAction["kind"], string> = {
    topup: t.app.chat.banners.errTopup,
    upgrade: t.app.chat.banners.errUpgrade,
    login: t.app.chat.banners.errLogin,
    reload: t.app.chat.banners.errReload,
    dismiss: t.app.chat.banners.errDismiss,
  };
  const label = LABELS[action.kind];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1 text-xs font-medium transition",
        primary
          ? "border border-red-500/50 bg-red-500/80 text-white hover:bg-red-500"
          : "border border-red-500/40 bg-transparent text-red-100 hover:bg-red-500/15",
      )}
    >
      {label}
    </button>
  );
}
