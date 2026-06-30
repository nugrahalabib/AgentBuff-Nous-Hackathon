"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/app error boundary]", error);
    // O3 — Best-effort client error reporting. POST a minimal sketch of the
    // error to the server log endpoint so we have a trail when users
    // encounter a route-level crash. Best-effort: failures are swallowed.
    if (typeof window !== "undefined") {
      try {
        fetch("/api/log/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            kind: "react-error-boundary",
            scope: "/app",
            name: error.name,
            message: error.message,
            stack: error.stack?.slice(0, 4000),
            digest: error.digest,
            url: window.location.pathname + window.location.search,
            userAgent: navigator.userAgent,
            at: new Date().toISOString(),
          }),
          keepalive: true,
        }).catch(() => {
          /* server endpoint may not exist yet — silent */
        });
      } catch {
        /* JSON shape or fetch unavailable — silent */
      }
    }
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Ada yang error di /app</h1>
        <p className="text-sm text-muted-foreground">
          Jangan panik — coba refresh atau tekan tombol di bawah. Kalau masih
          error, balik ke <a href="/loby" className="underline">/loby</a>.
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">digest: {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Coba lagi
        </button>
      </div>
    </div>
  );
}
