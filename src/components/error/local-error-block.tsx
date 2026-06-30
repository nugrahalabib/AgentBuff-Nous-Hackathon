"use client";

import { useState, useCallback } from "react";
import { useI18n } from "@/lib/i18n/context";

export function LocalErrorBlock({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const le = t.errorPages.localError;
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(() => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setTimeout(() => {
      onRetry();
      setRetrying(false);
    }, 1500);
  }, [onRetry, retrying]);

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-red-500/30 bg-red-500/[0.04] px-6 py-8">
      <span className="text-2xl">⚠️</span>
      <p className="text-sm font-medium text-red-300/80">
        {message ?? le.text}
      </p>
      {onRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={handleRetry}
          className="inline-flex items-center gap-2 rounded-lg bg-red-500/[0.1] px-4 py-2 text-xs font-bold text-red-300/80 transition-colors hover:bg-red-500/[0.18] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retrying && (
            <span className="size-3 animate-spin rounded-full border-2 border-red-400/20 border-t-red-400/60" />
          )}
          {le.retryCta}
        </button>
      )}
    </div>
  );
}
