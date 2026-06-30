"use client";

import { useEffect, useState } from "react";

type Status =
  | "queued"
  | "starting"
  | "awaiting-health"
  | "running"
  | "failed"
  | "stopped"
  | "destroyed"
  | string;

type Props = {
  initialStatus: Status;
  errorMessage?: string;
};

const LABEL: Record<string, string> = {
  queued: "Antre di gerbang Forge…",
  starting: "Nge-spin container-mu…",
  "awaiting-health": "Ngecek denyut nadi engine…",
  running: "Siap, gaskeun!",
  failed: "Forge-nya meledak, Chief.",
  stopped: "Engine lagi tidur.",
  destroyed: "Engine udah dibongkar.",
};

export function LobyWaiting({ initialStatus, errorMessage }: Props) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [err, setErr] = useState<string | undefined>(errorMessage);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (status === "running") {
      window.location.reload();
      return;
    }
    if (status === "failed" || status === "destroyed") return;

    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/users/me/container", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setStatus(data.status ?? "queued");
        setErr(data.errorMessage ?? undefined);
      } catch {
        /* transient network, keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [status]);

  const onRetry = async () => {
    setRetrying(true);
    setErr(undefined);
    try {
      const res = await fetch("/api/users/me/container/retry", { method: "POST" });
      if (res.ok) setStatus("queued");
      else {
        const data = await res.json().catch(() => ({}));
        setErr(data.error ?? "retry failed");
      }
    } finally {
      setRetrying(false);
    }
  };

  const label = LABEL[status] ?? "Menyiapkan engine…";
  const isFailed = status === "failed" || status === "destroyed";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#030014] px-6 text-center text-white">
      <div className="max-w-md space-y-4">
        {!isFailed && (
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
        )}
        <h1 className="font-display text-2xl">{label}</h1>
        <p className="text-sm text-white/60">
          {!isFailed
            ? "Sebentar ya Chief, Buff-mu lagi di-provision. Ga sampai semenit biasanya."
            : "Kita coba ulang aja, atau hubungin support."}
        </p>
        {err && (
          <pre className="mx-auto max-w-full overflow-x-auto rounded border border-red-500/30 bg-red-500/5 p-3 text-left text-xs text-red-300">
            {err}
          </pre>
        )}
        {isFailed && (
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={onRetry}
              disabled={retrying}
              className="rounded bg-cyan-500 px-4 py-2 text-sm font-medium text-black hover:bg-cyan-400 disabled:opacity-50"
            >
              {retrying ? "Memulai ulang…" : "Coba lagi"}
            </button>
            <a
              href="/bantuan"
              className="text-xs text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
            >
              Masih bermasalah? Hubungi support
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
