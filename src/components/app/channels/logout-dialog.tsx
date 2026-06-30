"use client";

/**
 * LogoutDialog — destructive confirm dialog untuk putuskan koneksi channel.
 *
 * Production rationale: pakai modal explicit (bukan 2-click confirm inline)
 * karena untuk mass-market user, side effect logout = customer chat ga
 * kebalas otomatis. Friction sehat. Pattern Stripe/Linear/GitHub destructive
 * confirm.
 *
 * State machine (mirror PairingDialog supaya UX konsisten):
 *   idle → submitting → restarting → verifying → success
 *                                              → timeout
 *                                  → error
 *
 * Per state:
 * - idle:        body context + tombol "Ya, Putuskan"
 * - submitting:  spinner "Memutuskan..." (RPC channels.logout + config.patch)
 * - restarting:  progress bar + "Engine sedang restart..." countdown
 * - verifying:   "Memverifikasi pemutusan..." sambil polling dashboard
 * - success:     "✓ Berhasil terputus" + auto-close 2.5s
 * - timeout:     warning "Engine belum sync — refresh halaman atau cek ulang"
 * - error:       inline error + tombol retry
 *
 * Aksi backend yang dilakukan (composite, satu config.patch):
 * 1. RPC `channels.logout` per account (gateway clear auth state)
 * 2. Filter binding[] entries untuk channel ini → patch
 * 3. SET `channels.<id>` to null → wipe entire namespace (RFC 7396 merge-patch
 *    null semantics, verified di engine/config/merge-patch.ts:77).
 *
 * Plus invalidate cache lokal lewat queryClient + tanstack `refetchOnReconnect`
 * di useChannelsDashboard catch reconnect setelah engine restart.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { getClient } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import {
  useChannelsDashboard,
  type ChannelDashboardEntryResponse,
} from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { formatChannelRelative } from "./helpers";
import { getConfigSnapshot, patchConfigPath } from "./config-patch";
import { removeRouteBinding, type AnyBinding } from "./bindings";

export type LogoutTarget =
  | { kind: "channel-all"; entry: ChannelDashboardEntryResponse }
  | {
      kind: "single-account";
      entry: ChannelDashboardEntryResponse;
      accountId: string;
      accountLabel: string;
    };

type LogoutState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "restarting"; elapsedMs: number }
  | { kind: "verifying"; elapsedMs: number }
  | { kind: "success" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

/**
 * Engine restart artifacts — error class yang expected setelah config.patch
 * yang trigger SIGUSR1. WS hang up sebelum response delivered = patch
 * persisted, lanjut polling untuk konfirmasi.
 */
function isExpectedRestartError(msg: string): boolean {
  return /socket hang up|ws closed|gateway closed|gateway timeout|gateway connect timeout|gateway is shutting down|ECONNRESET|service restart/i.test(
    msg,
  );
}

const VERIFICATION_TIMEOUT_MS = 180_000; // 3 menit — accommodate slow engine restart
const POLL_INTERVAL_MS = 3_000;

export function LogoutDialog({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: LogoutTarget | null;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open && target ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="relative mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-red-500/30 bg-[#0B0E14]"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-dialog-title"
          >
            <DialogContent target={target} onClose={onClose} />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function DialogContent({
  target,
  onClose,
}: {
  target: LogoutTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const dashboard = useChannelsDashboard();
  const [state, setState] = useState<LogoutState>({ kind: "idle" });
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // A11Y: place initial focus inside the dialog on open + Esc-to-close (guarded
  // by idle so an in-flight logout isn't dismissed). stateRef gives the handler
  // live state without re-binding the listener. (Audit A11Y-5.)
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    queueMicrotask(() => {
      containerRef.current
        ?.querySelector<HTMLElement>(
          "button:not([disabled]),input:not([disabled])",
        )
        ?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stateRef.current.kind === "idle") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: focus once + bind Esc once

  /**
   * Polling loop pasca config.patch: tunggu engine restart, lalu poll
   * dashboard sampai channel target hilang dari connectedChannels.
   */
  const runVerificationLoop = useCallback(async () => {
    const targetChannelId = target.entry.channelId;
    const started = Date.now();
    const deadline = started + VERIFICATION_TIMEOUT_MS;

    setState({ kind: "restarting", elapsedMs: 0 });

    while (!cancelledRef.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (cancelledRef.current) return;
      const elapsedMs = Date.now() - started;

      try {
        const result = await dashboard.refetch();
        // engineLive=false → gateway masih restart, lanjut tunggu
        if (!result.data?.engineLive) {
          setState({ kind: "restarting", elapsedMs });
          continue;
        }
        // engineLive=true tapi target masih ada → engine running tapi
        // belum sync filter (mungkin race antara gateway boot + UI proxy
        // refetch). Fase verifying.
        const channelStill = result.data.connectedChannels.find(
          (c) => c.channelId === targetChannelId,
        );
        // Per-account logout on a multi-account channel: the channel itself
        // REMAINS (other accounts still linked), so success = the SPECIFIC
        // account disappeared, not the whole channel. Channel-all logout: the
        // channel must vanish entirely.
        const stillThere =
          target.kind === "single-account"
            ? channelStill?.accounts.some(
                (a) => a.accountId === target.accountId,
              ) ?? false
            : !!channelStill;
        if (stillThere) {
          setState({ kind: "verifying", elapsedMs });
          continue;
        }
        // Target hilang (channel atau account) → success.
        if (cancelledRef.current) return;
        setState({ kind: "success" });
        // Belt & suspenders: invalidate again supaya komponen lain juga refetch.
        void qc.invalidateQueries({ queryKey: ["dashboard-channels"] });
        setTimeout(() => {
          if (!cancelledRef.current) onClose();
        }, 2_000);
        return;
      } catch {
        // Refetch error saat engine masih restart — keep polling.
        setState({ kind: "restarting", elapsedMs });
      }
    }
    if (!cancelledRef.current) {
      setState({ kind: "timeout" });
    }
  }, [target.entry.channelId, dashboard, qc, onClose]);

  const handleConfirm = useCallback(async () => {
    setState({ kind: "submitting" });
    const channelId = target.entry.channelId;

    try {
      const client = getClient();
      if (!client) throw new Error("Gateway belum terhubung");

      // Step 1 — Logout per akun. Best-effort: kalau satu fail, lanjut
      // sisanya. Engine biasanya self-clean credential walaupun RPC error.
      const accountIds =
        target.kind === "single-account"
          ? [target.accountId]
          : target.entry.accounts.map((a) => a.accountId);

      for (const accountId of accountIds) {
        await client
          .request("channels.logout", {
            channel: channelId,
            accountId,
          })
          .catch(() => {
            // Best-effort: the engine self-cleans credentials even on RPC
            // error, and the config.patch below is the authoritative cleanup.
            // Don't log — channel + account IDs would leak to DevTools
            // (no-console rule). (Audit 2026-06-10.)
          });
      }

      // Step 2 — Build composite config.patch:
      //   - bindings[] = current minus entries untuk channel+accounts target
      //   - channels.<id> = null (wipe entire namespace via merge-patch null)
      //
      // Dilakukan dalam SATU patch supaya engine cuma restart sekali, bukan
      // dua kali (mis. `channels.logout` triggers restart, lalu binding
      // patch triggers restart lagi).
      let cleanedBindings: AnyBinding[] | null = null;
      try {
        const snapshot = await getConfigSnapshot();
        const raw = snapshot.config?.bindings;
        if (Array.isArray(raw)) {
          let next = raw as AnyBinding[];
          if (target.kind === "single-account") {
            next = removeRouteBinding(next, channelId, target.accountId);
          } else {
            for (const acc of target.entry.accounts) {
              next = removeRouteBinding(next, channelId, acc.accountId);
            }
          }
          // Hanya patch kalau berubah — hindari trigger redundant restart.
          if (next.length !== raw.length) {
            cleanedBindings = next;
          }
        }
      } catch {
        // Snapshot read failed — fall through; the channels.logout RPC above
        // is the primary cleanup. Don't log (avoid leaking config to DevTools).
      }

      // Untuk single-account logout di multi-account channel: jangan wipe
      // seluruh namespace channels.<id> — masih ada akun lain. Cukup logout
      // RPC + bersihkan binding entry-nya saja.
      const wipeWholeChannel =
        target.kind === "channel-all" || target.entry.accounts.length === 1;

      const composite: Record<string, unknown> = {};
      if (cleanedBindings !== null) composite.bindings = cleanedBindings;
      if (wipeWholeChannel) {
        // RFC 7396 merge-patch: null = delete the field entirely.
        // Verified di engine src/config/merge-patch.ts:77.
        composite.channels = { [channelId]: null };
      }

      // Kalau composite kosong (no bindings change + tidak wipe channel),
      // skip config.patch — channels.logout RPC sudah cukup di engine.
      if (Object.keys(composite).length > 0) {
        try {
          await patchConfigPath([], composite);
        } catch (err) {
          const msg =
            err instanceof GatewayError
              ? err.message
              : err instanceof Error
                ? err.message
                : "unknown";
          if (!isExpectedRestartError(msg)) {
            setState({ kind: "error", message: msg });
            return;
          }
          // WS hang up = expected; engine sudah accept patch sebelum restart.
        }
      } else {
        // Tidak ada config.patch → tidak ada engine restart. Anggap
        // channels.logout sudah enough, langsung verifikasi.
      }

      await runVerificationLoop();
    } catch (err) {
      const msg =
        err instanceof GatewayError
          ? err.message
          : err instanceof Error
            ? err.message
            : t.app.channels.logoutFailed;
      setState({ kind: "error", message: msg });
    }
  }, [target, runVerificationLoop, t]);

  const handleRetryVerify = useCallback(async () => {
    await runVerificationLoop();
  }, [runVerificationLoop]);

  const isInFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const isTerminal =
    state.kind === "success" ||
    state.kind === "timeout" ||
    state.kind === "error";

  const channelLabel = target.entry.label;
  const last = (() => {
    let max: number | null = null;
    for (const acc of target.entry.accounts) {
      for (const ts of [acc.lastInboundAt, acc.lastOutboundAt]) {
        if (ts && (max === null || ts > max)) max = ts;
      }
    }
    return max;
  })();

  return (
    <div ref={containerRef}>
      <header className="flex items-start gap-3 border-b border-red-500/[0.18] px-5 py-4">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-red-500/40 bg-red-500/15 text-red-200"
        >
          <AlertTriangle className="size-4" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="logout-dialog-title"
            className="text-base font-semibold text-white/95"
          >
            {target.kind === "single-account"
              ? `Putuskan ${target.accountLabel}?`
              : `Putuskan ${channelLabel}?`}
          </h2>
          <p className="mt-0.5 text-[12px] text-white/55">
            {target.kind === "single-account"
              ? `Akun ini akan terputus dari ${channelLabel}.`
              : `Semua ${target.entry.accounts.length} akun di ${channelLabel} akan terputus.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={isInFlight}
          aria-label="Tutup"
          className="rounded-md p-1.5 text-white/55 transition hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="px-5 py-4">
        {state.kind === "idle" || state.kind === "error" ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/[0.04] px-4 py-3 text-[13px] leading-relaxed text-red-50/90">
            <p className="font-semibold">Yang akan terjadi:</p>
            <ul className="mt-1.5 space-y-1 text-[12px] text-red-100/85">
              <li>• AI tidak akan balas chat baru di {channelLabel}</li>
              <li>• Token / kredensial akan dihapus dari sistem</li>
              <li>
                • Pairing ulang akan butuh QR baru atau token baru
              </li>
              {target.entry.usage.totalToday > 0 ? (
                <li>
                  • Hari ini sudah {target.entry.usage.totalToday} pesan
                  terbalas — flow akan berhenti
                </li>
              ) : null}
              {last ? (
                <li>• Aktivitas terakhir: {formatChannelRelative(last)}</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {state.kind === "submitting" ? (
          <ProgressNote
            label="Memutuskan..."
            help="Membersihkan kredensial dan menyimpan konfigurasi."
            elapsedMs={0}
          />
        ) : null}
        {state.kind === "restarting" ? (
          <ProgressNote
            label="Engine sedang restart..."
            help="Sistem sedang memuat ulang konfigurasi (~30–100 detik). Tunggu sebentar."
            elapsedMs={state.elapsedMs}
          />
        ) : null}
        {state.kind === "verifying" ? (
          <ProgressNote
            label="Memverifikasi pemutusan..."
            help="Engine sudah kembali. Mengonfirmasi saluran sudah benar-benar terputus."
            elapsedMs={state.elapsedMs}
          />
        ) : null}
        {state.kind === "success" ? (
          <div className="rounded-md border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-3 text-[13px] text-emerald-100">
            ✓ {channelLabel} berhasil diputuskan. Saluran ini sudah tidak
            akan menerima atau membalas pesan.
          </div>
        ) : null}
        {state.kind === "timeout" ? (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/[0.06] px-3 py-3 text-[13px] text-amber-100">
            ⏱ Engine belum konfirmasi setelah 3 menit. Konfigurasi sudah
            tersimpan, tapi UI belum sync. Coba <strong>Cek ulang</strong>{" "}
            atau <strong>Refresh halaman</strong>.
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">
            {state.message}
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] px-5 py-3.5">
        {state.kind === "timeout" ? (
          <>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
            >
              Refresh halaman
            </button>
            <button
              type="button"
              onClick={() => void handleRetryVerify()}
              className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
            >
              Cek ulang
            </button>
          </>
        ) : state.kind === "success" ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
          >
            Tutup
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={isInFlight}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.app.channels.logoutCancel}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={isInFlight || isTerminal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-red-500 to-orange-500 px-4 py-1.5 text-xs font-bold text-white shadow-[0_8px_24px_-6px_rgba(239,68,68,0.5)] transition active:scale-[0.97] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.kind === "submitting" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t.app.channels.loggingOut}
                </>
              ) : state.kind === "restarting" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Restart...
                </>
              ) : state.kind === "verifying" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Verifikasi...
                </>
              ) : (
                <>
                  {target.kind === "single-account"
                    ? "Ya, Putuskan Akun"
                    : `Ya, Putuskan ${channelLabel}`}
                </>
              )}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

function ProgressNote({
  label,
  help,
  elapsedMs,
}: {
  label: string;
  help: string;
  elapsedMs: number;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const pct = Math.min(95, Math.round((seconds / 50) * 100));
  return (
    <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.04] px-3 py-2.5 text-[12px] text-cyan-100">
      <div className="flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>{label}</span>
        <span className="ml-auto font-mono text-[10px] text-cyan-200/70">
          {seconds}s
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-cyan-400/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-cyan-100/70">{help}</p>
    </div>
  );
}
