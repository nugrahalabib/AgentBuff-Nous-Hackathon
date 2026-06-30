"use client";

/**
 * PairingDialog — modal popup untuk channel pairing flow.
 *
 * Pairing strategies (lihat channel-catalog.ts PairingStrategy):
 * - "qr"                    → WhatsApp QR scan (web.login.start + web.login.wait)
 * - "single-token"          → Telegram/Discord (paste token via config.patch)
 * - "slack-tokens"          → Slack 3-field (botToken/appToken/signingSecret)
 * - "service-account-json"  → Google Chat (paste service account JSON)
 * - "bridge-cli"            → Signal/iMessage (link to docs, manual setup)
 * - "manual"                → Nostr (manual key import)
 *
 * IMPORTANT — engine behavior:
 * 1. Channel config writes (`channels.<id>.*`) trigger gateway SIGUSR1 →
 *    full process restart (~30-100s on Docker Desktop Windows). State machine
 *    handles this with progressive states (restarting → verifying → success).
 * 2. WhatsApp QR pairing tidak restart engine kalau user pilih default agent
 *    — auth disk write only. Kalau user pilih non-default agent, post-scan
 *    binding patch akan trigger restart.
 * 3. Agent assignment via `bindings[]` array config — channel→agent route.
 *    UI tampilkan AgentPicker di tiap body pairing. Submit batched bareng
 *    channel config untuk single restart.
 *
 * Pairing state machine:
 *   idle → submitting → restarting → verifying → success
 *                                              → timeout (with pollAgain recovery)
 *                     → error (validation/network)
 *
 * Timeout=180s. pollAgain() re-runs verification without re-patching, untuk
 * recovery kalau engine masih lambat balik.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, X, ExternalLink, Bot, AlertTriangle } from "lucide-react";
import { getClient } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import { useI18n } from "@/lib/i18n/context";
import { useChannelsDashboard } from "@/hooks/use-api";
import { patchConfigPath, getConfigSnapshot } from "./config-patch";
import { useChannelAccessControl, AccessControlPanel } from "./access-control";
import { upsertRouteBinding, type AnyBinding } from "./bindings";
import { AgentPicker } from "./agent-picker";
import { useAgentsList, formatAgentLabel } from "./use-agents-list";
import { type ChannelCatalogEntry } from "./channel-catalog";

export type PairingSuccessInfo = {
  channelId: string;
  channelLabel: string;
  agentId: string;
  agentLabel: string;
};

export type PairingDialogProps = {
  open: boolean;
  entry: ChannelCatalogEntry;
  onClose: () => void;
  /**
   * Triggered saat pairing succeed (channel terhubung + agent ter-bind).
   * Caller pakai untuk show persistent toast di page level.
   */
  onSuccess?: (info: PairingSuccessInfo) => void;
  /**
   * Daftar accountId yang sudah ter-pair untuk channel ini. Empty array =
   * first pair → patch ke top-level `channels.<id>.<fields>` (default account
   * semantics). Non-empty = add account → patch ke `channels.<id>.accounts.<id>.<fields>`
   * dengan Account ID yang user input/generate.
   */
  existingAccountIds?: string[];
  /**
   * Pre-select this agent ID in the agent picker. Used by wizard step 5
   * to default-route the new channel to the agent the user just created
   * (instead of falling back to "default"). Falls through to default
   * agent if the prop is empty/undefined or the agent doesn't exist.
   */
  defaultAgentId?: string;
};

/** Agent-scoped, globally-unique account id. Synthetic platform names are
 *  keyed by account_id alone, so prefixing with the agent id keeps each
 *  agent's accounts separate (no cross-agent collision) and avoids the
 *  engine-blocked bare "default". Backward-compat: a named agent's FIRST
 *  account keeps the bare agent id (matches existing whatsapp__<agent>). */
function nextAgentAccountId(agentId: string, existing: string[]): string {
  const used = new Set(existing.map((s) => s.toLowerCase()));
  const base = (agentId || "default").toLowerCase();
  if (base !== "default" && !used.has(base)) return base;
  for (let n = 1; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!used.has(cand)) return cand;
  }
  return `${base}-x`;
}

/**
 * Validate Account ID slug: lowercase, alphanumeric + hyphen, 2-32 char,
 * tidak "default" (reserved untuk top-level), unique di channel ini.
 */
function validateAccountId(
  raw: string,
  existing: string[],
): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "Account ID tidak boleh kosong" };
  if (trimmed === "default") {
    return {
      ok: false,
      reason: "'default' adalah ID reserved — pilih nama lain",
    };
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(trimmed)) {
    return {
      ok: false,
      reason:
        "Format: huruf kecil, angka, dan tanda hubung. 2-32 karakter, mulai dengan huruf.",
    };
  }
  if (existing.map((s) => s.toLowerCase()).includes(trimmed)) {
    return {
      ok: false,
      reason: `Account "${trimmed}" sudah ada — pilih nama lain`,
    };
  }
  return { ok: true, value: trimmed };
}

// ── Shell ─────────────────────────────────────────────────────────────

export function PairingDialog(props: PairingDialogProps) {
  return (
    <AnimatePresence>
      {props.open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={props.onClose}
          role="presentation"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="relative mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.7)] max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pairing-dialog-title"
          >
            <DialogHeader entry={props.entry} onClose={props.onClose} />
            <DialogBody {...props} />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function DialogHeader({
  entry,
  onClose,
}: {
  entry: ChannelCatalogEntry;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4 sticky top-0 bg-[#0B0E14] z-10">
      <div className="flex items-center gap-3">
        <span
          className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-lg"
          aria-hidden
        >
          {entry.emoji}
        </span>
        <div>
          <h2
            id="pairing-dialog-title"
            className="text-base font-semibold text-white/95"
          >
            {entry.label}
          </h2>
          <p className="text-[12px] text-white/55">{entry.tagline}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Tutup dialog"
        className="rounded-md p-1.5 text-white/55 transition hover:bg-white/[0.05] hover:text-white"
      >
        <X className="size-4" />
      </button>
    </header>
  );
}

function DialogBody({
  entry,
  onClose,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: PairingDialogProps) {
  // Defense-in-depth: kalau dialog kebuka untuk channel coming-soon (semestinya
  // gak terjadi karena CatalogCard + channels-tab guard), tampilin pesan
  // friendly bukan render pairing flow yang akan fail/confusing.
  if (entry.comingSoon) {
    return <ComingSoonBody onClose={onClose} entry={entry} />;
  }
  const accounts = existingAccountIds ?? [];
  switch (entry.pairing) {
    case "qr":
      return (
        <QrPairingBody
          onClose={onClose}
          entry={entry}
          onSuccess={onSuccess}
          existingAccountIds={accounts}
          defaultAgentId={defaultAgentId}
        />
      );
    case "single-token":
      return (
        <SingleTokenPairingBody
          onClose={onClose}
          entry={entry}
          onSuccess={onSuccess}
          existingAccountIds={accounts}
          defaultAgentId={defaultAgentId}
        />
      );
    case "slack-tokens":
      return (
        <SlackTokensPairingBody
          onClose={onClose}
          entry={entry}
          onSuccess={onSuccess}
          existingAccountIds={accounts}
          defaultAgentId={defaultAgentId}
        />
      );
    case "service-account-json":
      return (
        <ServiceAccountJsonBody
          onClose={onClose}
          entry={entry}
          onSuccess={onSuccess}
          existingAccountIds={accounts}
          defaultAgentId={defaultAgentId}
        />
      );
    case "email-imap":
      return (
        <EmailPairingBody
          onClose={onClose}
          entry={entry}
          onSuccess={onSuccess}
          existingAccountIds={accounts}
          defaultAgentId={defaultAgentId}
        />
      );
    case "bridge-cli":
    case "manual":
    default:
      return <ManualSetupBody onClose={onClose} entry={entry} />;
  }
}

/**
 * ComingSoonBody — fallback ramah saat dialog kebuka untuk channel yang
 * belum siap. Mestinya gak akan ke-trigger karena CatalogCard + channels-tab
 * udah gate click, tapi defense-in-depth.
 */
function ComingSoonBody({
  onClose,
  entry,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
}) {
  return (
    <div className="px-5 py-6">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-5 text-center">
        <div className="mb-2 text-3xl" aria-hidden>
          ⏳
        </div>
        <h3 className="text-base font-semibold text-white/90">
          {entry.label} segera hadir
        </h3>
        <p className="mt-1.5 text-[12px] text-white/55">
          Saluran ini sedang dalam pengembangan. Pantau update kami atau coba
          saluran lain yang sudah aktif (WhatsApp, Telegram).
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
        >
          Tutup
        </button>
      </div>
    </div>
  );
}

// ── State machine + restart-aware hook ────────────────────────────────

type PairingState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "restarting"; elapsedMs: number }
  | { kind: "verifying"; elapsedMs: number }
  | {
      kind: "success";
      channelLabel: string;
      agentLabel: string;
    }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

const PAIRING_TIMEOUT_MS = 180_000; // 3 menit — engine restart Windows bisa lama
const POLL_INTERVAL_MS = 3_000;

function isExpectedRestartError(msg: string): boolean {
  return /socket hang up|ws closed|gateway closed|gateway timeout|gateway connect timeout|gateway is shutting down|ECONNRESET|service restart|Gateway belum terhubung|gateway not connected/i.test(
    msg,
  );
}

/**
 * Hook untuk channel pairing yang trigger engine restart (Telegram/Discord/
 * Slack/Google Chat). Patches `channels.<id>.<...>` + `bindings` array
 * dalam single config.patch supaya cuma satu kali restart.
 *
 * WhatsApp pakai variant terpisah (lihat useWhatsAppQrPairing) karena alur
 * QR scan + auth disk write berbeda.
 */
function useChannelPairingSubmit(
  channelId: string,
  channelLabel: string,
  onClose: () => void,
  onSuccess: ((info: PairingSuccessInfo) => void) | undefined,
) {
  const qc = useQueryClient();
  const dashboard = useChannelsDashboard();
  const agentsList = useAgentsList();
  const [state, setState] = useState<PairingState>({ kind: "idle" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const lookupAgentLabel = useCallback(
    (agentId: string): string => {
      const data = agentsList.data;
      if (!data) return agentId;
      const found = data.agents.find((a) => a.id === agentId);
      if (!found) return agentId;
      return formatAgentLabel(found, found.id === data.defaultId);
    },
    [agentsList.data],
  );

  /**
   * Polling loop: refetch dashboard sampai channel muncul di
   * connectedChannels. State berubah `restarting` → `verifying` saat engine
   * sudah respond, → `success` saat channel ready, → `timeout` saat 180s.
   */
  // Remembers the verification target so pollAgain() (which only passes
  // agentId) can replay against the correct native vs synthetic check.
  const verifyArgsRef = useRef<{
    isDefaultAgent: boolean;
    accountIdOverride?: string;
  }>({ isDefaultAgent: true });

  const runVerificationLoop = useCallback(
    async (
      agentId: string,
      isDefaultAgent?: boolean,
      accountIdOverride?: string,
    ) => {
      // pollAgain passes only agentId → reuse the last submit's target.
      if (isDefaultAgent === undefined) {
        isDefaultAgent = verifyArgsRef.current.isDefaultAgent;
        accountIdOverride = verifyArgsRef.current.accountIdOverride;
      } else {
        verifyArgsRef.current = { isDefaultAgent, accountIdOverride };
      }
      // Native primary account → connectedChannels. Synthetic (per-agen)
      // account → profiles[agentId].channels[channelId]. Account to confirm:
      // explicit override, else the agent's own id (synthetic), else native.
      const wantAccount =
        accountIdOverride ?? (isDefaultAgent ? null : agentId);

      const started = Date.now();
      const deadline = started + PAIRING_TIMEOUT_MS;
      setState({ kind: "restarting", elapsedMs: 0 });

      while (!cancelledRef.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;
        const elapsed = Date.now() - started;
        try {
          const result = await dashboard.refetch();
          if (cancelledRef.current) return;
          const data = result.data;
          if (!data) {
            setState({ kind: "restarting", elapsedMs: elapsed });
            continue;
          }
          let label: string | null = null;
          if (isDefaultAgent && !accountIdOverride) {
            const entry = data.connectedChannels.find(
              (c) => c.channelId === channelId,
            );
            if (entry) label = entry.label;
          } else {
            // `profiles` = per-agen synthetic accounts (now first-class on the
            // dashboard response type — no cast needed).
            const profiles = data.profiles;
            const prof = profiles?.[agentId];
            const entry = prof?.channels.find((c) => c.channelId === channelId);
            if (entry) {
              const acc = wantAccount
                ? entry.accounts.find((a) => a.accountId === wantAccount)
                : entry.accounts[0];
              if (acc) label = entry.label;
            }
          }
          if (label !== null) {
            const agentLabel = lookupAgentLabel(agentId);
            setState({ kind: "success", channelLabel: label, agentLabel });
            onSuccess?.({ channelId, channelLabel: label, agentId, agentLabel });
            void qc.invalidateQueries({ queryKey: ["dashboard-channels"] });
            void qc.invalidateQueries({ queryKey: ["gateway", "agents", "list"] });
            setTimeout(() => {
              if (!cancelledRef.current) onClose();
            }, 4_000);
            return;
          }
          // Engine responded but channel not yet present → verifying phase.
          if (data.engineLive) {
            setState({ kind: "verifying", elapsedMs: elapsed });
          } else {
            setState({ kind: "restarting", elapsedMs: elapsed });
          }
        } catch {
          if (cancelledRef.current) return;
          setState({ kind: "restarting", elapsedMs: elapsed });
        }
      }
      if (!cancelledRef.current) {
        setState({ kind: "timeout" });
      }
    },
    [channelId, dashboard, lookupAgentLabel, onClose, onSuccess, qc],
  );

  /**
   * Submit pair config.
   *
   * @param channelPartial - field-field channel (botToken, dmPolicy, dst).
   *   Tidak include `channels: {...}` wrap — itu di-handle di sini.
   * @param agentId - agent yang akan di-bind ke account ini.
   * @param accountIdOverride - kalau provided, patch ke `channels.<id>.accounts.<accountIdOverride>.<fields>`
   *   (multi-account mode). Kalau undefined, patch ke top-level
   *   `channels.<id>.<fields>` (first-pair mode, accountId="default" semantics).
   */
  const submit = useCallback(
    async (
      channelPartial: Record<string, unknown>,
      agentId: string,
      accountIdOverride?: string,
    ) => {
      setState({ kind: "submitting" });

      const defaultId = agentsList.data?.defaultId;
      const isDefaultAgent =
        !agentId || agentId === "default" || agentId === defaultId;

      // The `channels.pair` bridge RPC decides NATIVE vs SYNTHETIC:
      //  - default agent + no explicit account → `channels.<id>` (native primary)
      //  - named agent OR explicit account → `platforms.<base>__<account>`
      //    (per-agen synthetic platform, routed via extra.agent_id)
      // The bridge applies default policies + open-access + plugin-enable, so
      // the UI no longer hand-writes config + bindings (which was the OLD,
      // never-actually-multiplexing `channels.<id>.accounts.<id>` approach).
      const params: Record<string, unknown> = {
        channel: channelId,
        credentials: channelPartial,
      };
      if (!isDefaultAgent) params.agentId = agentId;
      if (accountIdOverride) params.accountId = accountIdOverride;

      const client = getClient();
      if (!client) {
        setState({ kind: "error", message: "Gateway belum terhubung" });
        return;
      }
      try {
        await client.request("channels.pair", params);
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
        // Else: WS hung up while the gateway restarted — pair already persisted,
        // proceed to verification.
      }

      await runVerificationLoop(agentId, isDefaultAgent, accountIdOverride);
    },
    [channelId, runVerificationLoop, agentsList.data],
  );

  /**
   * Recovery action — re-run polling tanpa re-patch. Useful kalau engine
   * masih restart saat 180s timeout fired.
   */
  const pollAgain = useCallback(async () => {
    // We don't know agentId at this point — caller responsible to pass.
    // The current implementation relies on the dialog body to remember
    // the last submitted agentId and pass it to the action button.
  }, []);

  return {
    state,
    submit,
    runVerificationLoop,
    pollAgain,
    setState,
    channelLabel,
    lookupAgentLabel,
  };
}

// ── Shared UI atoms ────────────────────────────────────────────────────

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 font-mono text-[10px] font-bold text-cyan-200"
      >
        {n}
      </span>
      <span className="text-[13px] text-white/75">{text}</span>
    </li>
  );
}

/**
 * RestartProgressBar — visual feedback selama engine restart + verifying.
 * Two phases:
 *   - restarting: engine down, gateway not responding (red→amber gradient)
 *   - verifying:  engine up, channel runtime loading (cyan→fuchsia)
 */
function RestartProgressBar({
  elapsedMs,
  phase,
}: {
  elapsedMs: number;
  phase: "restarting" | "verifying";
}) {
  const { t } = useI18n();
  const seconds = Math.floor(elapsedMs / 1000);
  // Engine biasanya 30-100s. Progress bar approximate 60s baseline.
  const pct = Math.min(95, Math.round((seconds / 60) * 100));
  const title =
    phase === "restarting"
      ? t.app.channels.pairing.restartingTitle
      : t.app.channels.pairing.verifyingTitle;
  const help =
    phase === "restarting"
      ? t.app.channels.pairing.restartingHelp
      : t.app.channels.pairing.verifyingHelp;
  const accentBar =
    phase === "restarting"
      ? "from-amber-400 via-orange-400 to-rose-400"
      : "from-cyan-400 via-indigo-400 to-fuchsia-400";

  return (
    <div className="mt-3 rounded-md border border-cyan-400/25 bg-cyan-400/[0.04] px-3 py-2.5 text-[12px] text-cyan-100">
      <div className="flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>{title}</span>
        <span className="ml-auto font-mono text-[10px] text-cyan-200/70">
          {seconds}s
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-cyan-400/10">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${accentBar} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-cyan-100/70">{help}</p>
    </div>
  );
}

function PairingFeedback({
  state,
  validationError,
}: {
  state: PairingState;
  validationError?: string | null;
}) {
  const { t } = useI18n();
  if (validationError && state.kind === "idle") {
    return (
      <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-100">
        {validationError}
      </div>
    );
  }
  if (state.kind === "restarting") {
    return <RestartProgressBar elapsedMs={state.elapsedMs} phase="restarting" />;
  }
  if (state.kind === "verifying") {
    return <RestartProgressBar elapsedMs={state.elapsedMs} phase="verifying" />;
  }
  if (state.kind === "success") {
    return (
      <div className="mt-3 rounded-md border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-3 text-[12px] text-emerald-100">
        <div className="text-base">
          🎉 {state.channelLabel} {t.app.channels.pairing.successConnected}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-emerald-200/85">
          <Bot className="size-3.5" aria-hidden />
          <span>{t.app.channels.pairing.successRoutedTo}:</span>
          <span className="font-semibold">{state.agentLabel}</span>
        </div>
      </div>
    );
  }
  if (state.kind === "timeout") {
    return (
      <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/[0.06] px-3 py-3 text-[12px] text-amber-100">
        <div className="font-semibold">
          ⏱ {t.app.channels.pairing.restartingTimeout}
        </div>
        <p className="mt-1 text-amber-200/80">
          {t.app.channels.pairing.restartingTimeoutHelp}
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-100">
        {state.message}
      </div>
    );
  }
  return null;
}

/**
 * PairingActions — state-aware button bar. Used by all token-based pairing
 * bodies (single-token, slack, service-account). Action button label +
 * onClick varies by state, supaya consistent + reduce duplication.
 */
function PairingActions({
  state,
  canSubmit,
  onSubmit,
  onClose,
  onPollAgain,
  submitLabel,
}: {
  state: PairingState;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  onPollAgain: () => void;
  submitLabel: string;
}) {
  const { t } = useI18n();

  const inFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const isSuccess = state.kind === "success";
  const isTimeout = state.kind === "timeout";

  return (
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      {isTimeout ? (
        <>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
          >
            {t.app.channels.pairing.refreshPage}
          </button>
          <button
            type="button"
            onClick={onPollAgain}
            className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] transition active:scale-[0.97] hover:brightness-110"
          >
            {t.app.channels.pairing.pollAgain}
          </button>
        </>
      ) : isSuccess ? (
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
        >
          {t.app.channels.pairing.close}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={inFlight}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.app.channels.pairing.cancel}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit || inFlight}
            className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] transition active:scale-[0.97] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * RestartHint — pre-pairing warning untuk channel yang trigger engine restart.
 * Set expectation di awal supaya user gak panic saat 1-2 menit wait.
 */
function RestartHint() {
  const { t } = useI18n();
  return (
    <div className="mb-3 rounded-md border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2 text-[11px] text-amber-100/90">
      ⏱ {t.app.channels.pairing.restartHint}
    </div>
  );
}

// ── QR Pairing (WhatsApp) ───────────────────────────────────────────────

type QrState =
  | { kind: "idle" }
  // bootstrap = first-time channel activation. Engine load plugin secara
  // lazy berdasar config.channels.<id> presence. Untuk WhatsApp QR pairing,
  // plugin BELUM loaded saat user pertama kali klik "Hubungkan" — `web.login.start`
  // bakal balikin "web login provider is not available". Solusinya: patch
  // `channels.whatsapp.enabled=true` dulu → engine restart + plugin load
  // (~60-100s di Docker Desktop Windows), baru web.login.start jalan.
  | { kind: "bootstrap"; elapsedMs: number }
  | { kind: "loading" }
  | { kind: "scan"; qrDataUrl: string }
  | { kind: "linking" } // QR scanned, finalizing
  | { kind: "binding-restart"; elapsedMs: number; phase: "restarting" | "verifying" }
  // qr-expired = QR udah generate tapi user telat scan (>2 menit). Engine
  // Baileys cache QR session selama 3 menit (ACTIVE_LOGIN_TTL_MS upstream).
  // Selama TTL aktif, retry web.login.start malah balikin cached error.
  // UI tampilin countdown atau button "Reset Sesi" untuk paksa engine reset.
  | { kind: "qr-expired"; resetting: boolean }
  | {
      kind: "success";
      channelLabel: string;
      agentLabel: string;
    }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

function QrPairingBody({
  onClose,
  entry,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
  onSuccess?: (info: PairingSuccessInfo) => void;
  existingAccountIds?: string[];
  defaultAgentId?: string;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const dashboard = useChannelsDashboard();
  const agentsList = useAgentsList();
  // Pre-select the wizard-provided agent (if any). Falls through to ""
  // which AgentPicker treats as "default agent". useEffect below
  // re-syncs if defaultAgentId arrives after first render.
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  useEffect(() => {
    if (defaultAgentId && !agentId) setAgentId(defaultAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgentId]);
  // Agent-scoped synthetic account id for this WhatsApp pairing. Keyed by
  // account id alone in the bridge, so it must be globally unique per channel
  // — prefixing with the agent id keeps each agent's WhatsApps separate.
  // Falls back agentId → defaultAgentId → "default" so the default agent (whose
  // agentId resolves to "default") still gets a non-"default" account id and
  // is therefore NOT blocked by the bridge.
  const waAccountId = useMemo(
    () =>
      nextAgentAccountId(
        agentId || defaultAgentId || "default",
        existingAccountIds ?? [],
      ),
    [agentId, defaultAgentId, existingAccountIds],
  );
  const [state, setState] = useState<QrState>({ kind: "idle" });
  // Access control — who may chat this WA number. Default allowlist (secure);
  // captured at "Hubungkan" click and passed to web.login.wait so the bridge
  // writes WHATSAPP_ALLOWED_USERS from the user's choice (not a forced "*").
  const accessControl = useChannelAccessControl("whatsapp");
  const allowFromRef = useRef<string[]>(["*"]);
  const [accessError, setAccessError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false); // dedup auto-start

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const lookupAgentLabel = useCallback(
    (id: string): string => {
      const data = agentsList.data;
      if (!data) return id;
      const found = data.agents.find((a) => a.id === id);
      if (!found) return id;
      return formatAgentLabel(found, found.id === data.defaultId);
    },
    [agentsList.data],
  );

  /**
   * After QR scan completes:
   * - Kalau agentId === defaultId, langsung success (no restart needed)
   * - Kalau non-default, patch bindings (akan trigger restart) + verifying loop
   */
  const finalizeAfterScan = useCallback(async () => {
    const data = agentsList.data;
    const defaultId = data?.defaultId ?? "main";
    const channelId = entry.id;

    // Agent label resolved at success time
    const agentLabel = lookupAgentLabel(agentId);

    // Refresh dashboard sebelum check — supaya engine yang baru link channel
    // ter-pickup (channels.status broadcast event juga akan fire).
    void qc.invalidateQueries({ queryKey: ["dashboard-channels"] });

    // AgentBuff WhatsApp: the bridge's web.login.wait already wrote the synthetic
    // platform config (platforms.whatsapp__<agent>) + restarted the gateway for
    // EVERY agent, so the channel is already coming up. No binding patch / extra
    // restart is needed here (a 2nd restart would interrupt the just-paired WA
    // adapter). Always show success. `defaultId` retained for label resolution.
    void defaultId;
    {
      setState({
        kind: "success",
        channelLabel: entry.label,
        agentLabel,
      });
      onSuccess?.({
        channelId,
        channelLabel: entry.label,
        agentId,
        agentLabel,
      });
      setTimeout(() => {
        if (!cancelledRef.current) onClose();
      }, 4_000);
      return;
    }
  }, [agentId, agentsList.data, entry.id, entry.label, lookupAgentLabel, onClose, onSuccess, qc]);

  /**
   * Bootstrap WhatsApp plugin loading via config patch.
   * Engine loads channel plugins lazily — `channels.whatsapp` must be
   * defined in config BEFORE plugin registers. We patch minimal
   * `{enabled: true}`, wait for engine restart, then verify channels.status
   * reports whatsapp in channelOrder.
   *
   * Returns true on success, false on timeout/error (caller surface error).
   */
  const bootstrapPluginIfNeeded = useCallback(async (): Promise<boolean> => {
    // AgentBuff per-agent WhatsApp: NO native channels.whatsapp bootstrap. The
    // bridge's web.login.start launches the per-agent Node WhatsApp bridge
    // directly — writing channels.whatsapp here would create a broken "ghost"
    // native WhatsApp channel alongside the per-agent synthetic ones. The
    // multichannel plugin + built-in WhatsAppAdapter are always available, so
    // there is nothing to pre-load.
    return true;
  }, []);

  const startQr = useCallback(
    async (force: boolean) => {
      if (!agentId && !waAccountId) return; // wait for agent to be selected
      cancelledRef.current = false;
      startedRef.current = true;
      try {
        // Step 1: ensure plugin is loaded (bootstrap if needed)
        const ready = await bootstrapPluginIfNeeded();
        if (!ready || cancelledRef.current) return;

        setState({ kind: "loading" });
        const client = getClient();
        if (!client) throw new Error("Gateway belum terhubung");

        const qrResp = await client.request<{
          message?: string;
          qrDataUrl?: string;
          alreadyPaired?: boolean;
          connected?: boolean;
        }>("web.login.start", {
          force,
          agentId,
          accountId: waAccountId,
          timeoutMs: 30_000,
        });

        if (cancelledRef.current) return;

        if (!qrResp?.qrDataUrl) {
          setState({
            kind: "error",
            message: qrResp?.message ?? "Engine tidak mengirim QR",
          });
          return;
        }

        setState({ kind: "scan", qrDataUrl: qrResp.qrDataUrl });

        try {
          const waitResp = await client.request<{
            message?: string;
            connected?: boolean;
          }>("web.login.wait", {
            agentId,
            accountId: waAccountId,
            timeoutMs: 120_000,
            allowFrom: allowFromRef.current,
          });
          if (cancelledRef.current) return;
          if (waitResp?.connected) {
            setState({ kind: "linking" });
            await finalizeAfterScan();
          } else {
            // Engine returns failure messages here too. 408 / QR refs ended
            // = QR session timed out without scan → user needs fresh QR.
            const waitMsg = waitResp?.message ?? "Pairing tidak selesai";
            if (
              /qr refs|request time-?out|408|QR expired|generate a new one/i.test(
                waitMsg,
              )
            ) {
              setState({ kind: "qr-expired", resetting: false });
            } else {
              setState({ kind: "error", message: waitMsg });
            }
          }
        } catch (waitErr) {
          if (cancelledRef.current) return;
          const msg =
            waitErr instanceof GatewayError
              ? waitErr.message
              : waitErr instanceof Error
                ? waitErr.message
                : "Timeout";
          if (isExpectedRestartError(msg)) {
            // Engine restarted unexpectedly mid-wait — proceed to finalize
            // because the connection state is unknown but auth dir might
            // have been written.
            await finalizeAfterScan();
          } else if (
            /qr refs|request time-?out|408|QR expired|generate a new one/i.test(
              msg,
            )
          ) {
            setState({ kind: "qr-expired", resetting: false });
          } else {
            setState({ kind: "timeout" });
          }
        }
      } catch (err) {
        if (cancelledRef.current) return;
        const raw =
          err instanceof GatewayError
            ? err.message
            : err instanceof Error
              ? err.message
              : t.app.channels.pairing.genericError;
        // 408 / QR refs ended detected at outer catch too (in case web.login.start
        // returns cached error from previous failed session).
        if (
          /qr refs|request time-?out|408|QR expired|generate a new one/i.test(
            raw,
          )
        ) {
          setState({ kind: "qr-expired", resetting: false });
          return;
        }
        // Translate technical engine errors → user-friendly Bahasa.
        let msg = raw;
        if (/web login provider is not available/i.test(raw)) {
          msg =
            "Plugin WhatsApp belum aktif. Klik Coba Lagi — sistem akan otomatis aktifkan plugin (butuh ~1 menit pertama kali).";
        } else if (/rate limit/i.test(raw)) {
          const match = raw.match(/retry after (\d+)s/i);
          msg = match
            ? `Terlalu cepat — engine sedang sibuk. Tunggu ${match[1]} detik lalu Coba Lagi.`
            : "Terlalu cepat — tunggu beberapa detik lalu Coba Lagi.";
        }
        setState({ kind: "error", message: msg });
      }
    },
    [agentId, waAccountId, bootstrapPluginIfNeeded, finalizeAfterScan, t],
  );

  /**
   * Hard reset WhatsApp session by patching `channels.whatsapp = null`
   * (engine unloads plugin + clears activeLogins). Then startQr will trigger
   * bootstrap → re-enable → fresh QR. ~1-2 menit total.
   */
  const resetSession = useCallback(async () => {
    setState({ kind: "qr-expired", resetting: true });
    try {
      await patchConfigPath(["channels"], { whatsapp: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isExpectedRestartError(msg)) {
        setState({ kind: "error", message: `Gagal reset: ${msg}` });
        return;
      }
      // Expected: engine restarting after patch.
    }
    // Wait for engine to come back. Reuse bootstrap path which polls
    // channels.status until whatsapp appears in channelOrder.
    startedRef.current = false; // allow startQr re-trigger
    await new Promise((r) => setTimeout(r, 2_000)); // small grace
    if (cancelledRef.current) return;
    void startQr(true);
  }, [startQr]);

  // Connect handler — validate access THEN start QR. Replaces auto-start so
  // the user sets the allowlist (who may chat) before pairing begins; the
  // chosen list is captured into allowFromRef and flows to web.login.wait.
  const handleConnect = useCallback(() => {
    const built = accessControl.buildAccess();
    if (!built.ok) {
      setAccessError(built.error);
      return;
    }
    setAccessError(null);
    allowFromRef.current = (built.access.allowFrom as string[]) ?? ["*"];
    void startQr(false);
  }, [accessControl, startQr]);

  const inFlight =
    state.kind === "bootstrap" ||
    state.kind === "loading" ||
    state.kind === "scan" ||
    state.kind === "linking" ||
    state.kind === "binding-restart" ||
    (state.kind === "qr-expired" && state.resetting);

  return (
    <div className="px-5 py-5">
      {/* Steps */}
      <ol className="mb-4 space-y-2">
        <Step n={1} text={t.app.channels.pairing.whatsappStep1} />
        <Step n={2} text={t.app.channels.pairing.whatsappStep2} />
        <Step n={3} text={t.app.channels.pairing.whatsappStep3} />
      </ol>

      {/* Dedicated-number warning — read before scanning. The scanned number
          becomes the agent's identity; the AI replies FROM it, so it must NOT
          be the user's personal WhatsApp. */}
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-400/40 bg-amber-400/[0.08] px-3 py-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        <p className="text-[12px] leading-relaxed text-amber-100/90">
          {t.app.channels.pairing.whatsappWarning}
        </p>
      </div>

      {/* Agent picker (rendered di atas QR) */}
      <AgentPicker
        value={agentId}
        onChange={setAgentId}
        disabled={inFlight}
      />

      {state.kind === "idle" ? (
        <>
          <AccessControlPanel channelId="whatsapp" control={accessControl} />
          {accessError ? (
            <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-100">
              {accessError}
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleConnect}
            className="mt-4 w-full rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-2 text-sm font-bold text-[#0B0E14] transition hover:brightness-110 active:scale-[0.99]"
          >
            Hubungkan WhatsApp
          </button>
        </>
      ) : (
        /* QR display zone */
        <div className="mt-4 flex flex-col items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 min-h-[260px]">
          <QrInner state={state} />
        </div>
      )}

      {/* Footer: actions */}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {state.kind === "scan" ? (
          <button
            type="button"
            onClick={() => void startQr(true)}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
          >
            {t.app.channels.pairing.whatsappRefreshQr}
          </button>
        ) : null}
        {state.kind === "timeout" ? (
          <>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
            >
              {t.app.channels.pairing.refreshPage}
            </button>
            <button
              type="button"
              onClick={() => void startQr(true)}
              className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
            >
              {t.app.channels.pairing.whatsappRetry}
            </button>
          </>
        ) : null}
        {state.kind === "qr-expired" && !state.resetting ? (
          <button
            type="button"
            onClick={() => void resetSession()}
            className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
          >
            Reset Sesi
          </button>
        ) : null}
        {state.kind === "error" ? (
          <button
            type="button"
            onClick={() => void startQr(true)}
            className="rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
          >
            {t.app.channels.pairing.whatsappRetry}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          disabled={state.kind === "binding-restart"}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.kind === "success"
            ? t.app.channels.pairing.close
            : t.app.channels.pairing.cancel}
        </button>
      </div>

      {/* Note: post-success info already inside QrInner */}
    </div>
  );
}

function QrInner({ state }: { state: QrState }) {
  const { t } = useI18n();
  if (state.kind === "idle") {
    return (
      <p className="text-center text-sm text-white/55">
        {t.app.channels.pairing.whatsappPickAgentFirst}
      </p>
    );
  }
  if (state.kind === "bootstrap") {
    const seconds = Math.floor(state.elapsedMs / 1000);
    const pct = Math.min(95, Math.round((seconds / 90) * 100));
    return (
      <div className="w-full">
        <div className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.04] px-3 py-3 text-[12px] text-cyan-100">
          <div className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span className="font-semibold">
              Mengaktifkan WhatsApp di engine kamu…
            </span>
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
          <p className="mt-2 text-[11px] text-cyan-100/70">
            Pertama kali setup WhatsApp butuh ~1 menit. Engine sedang load plugin
            dan siapin Web client. QR akan muncul setelah selesai.
          </p>
        </div>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 text-white/55">
        <Loader2 className="size-7 animate-spin" />
        <p className="text-sm">{t.app.channels.pairing.whatsappQrLoading}</p>
      </div>
    );
  }
  if (state.kind === "scan") {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="rounded-lg border border-white/10 bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.qrDataUrl}
            alt="WhatsApp pairing QR"
            className="size-48 select-none"
            draggable={false}
          />
        </div>
        <p className="text-center text-sm text-white/75">
          {t.app.channels.pairing.whatsappQrInstruction}
        </p>
        <p className="text-[11px] text-white/40">
          {t.app.channels.pairing.whatsappWaiting}
        </p>
      </div>
    );
  }
  if (state.kind === "linking") {
    return (
      <div className="flex flex-col items-center gap-3 text-emerald-200">
        <Loader2 className="size-7 animate-spin" />
        <p className="text-sm">{t.app.channels.pairing.whatsappLinking}</p>
      </div>
    );
  }
  if (state.kind === "binding-restart") {
    return (
      <div className="w-full">
        <RestartProgressBar
          elapsedMs={state.elapsedMs}
          phase={state.phase}
        />
      </div>
    );
  }
  if (state.kind === "qr-expired") {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-3xl">⏱</span>
        <p className="text-sm font-semibold text-amber-200">
          QR kadaluwarsa
        </p>
        <p className="text-[12px] text-amber-100/80 max-w-xs">
          {state.resetting
            ? "Sedang reset sesi WhatsApp. Ini butuh ~1-2 menit. Jangan tutup dialog…"
            : "QR tidak di-scan dalam 2 menit. Klik 'Reset Sesi' untuk dapat QR baru — sistem akan refresh plugin WhatsApp di engine kamu."}
        </p>
        {state.resetting ? (
          <Loader2 className="size-5 animate-spin text-amber-200" aria-hidden />
        ) : null}
      </div>
    );
  }
  if (state.kind === "success") {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-4xl">🎉</span>
        <p className="text-base font-semibold text-emerald-200">
          {state.channelLabel} {t.app.channels.pairing.successConnected}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-emerald-100/85">
          <Bot className="size-3.5" aria-hidden />
          {t.app.channels.pairing.successRoutedTo}:{" "}
          <span className="font-semibold">{state.agentLabel}</span>
        </p>
      </div>
    );
  }
  if (state.kind === "timeout") {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-3xl">⏱</span>
        <p className="text-sm text-amber-200">
          {t.app.channels.pairing.whatsappTimeout}
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-3xl">⚠️</span>
        <p className="text-sm text-red-200">
          {t.app.channels.pairing.genericError}
        </p>
        <p className="text-[11px] text-white/45">{state.message}</p>
      </div>
    );
  }
  return null;
}

// ── Single-token Pairing (Telegram, Discord) ────────────────────────────

function SingleTokenPairingBody({
  onClose,
  entry,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
  onSuccess?: (info: PairingSuccessInfo) => void;
  existingAccountIds: string[];
  defaultAgentId?: string;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  // Access control (who may chat this bot). Default allowlist (secure), user
  // can switch to "all". Shared hook maps the choice onto engine policy fields.
  const accessControl = useChannelAccessControl(entry.id);
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  useEffect(() => {
    if (defaultAgentId && !agentId) setAgentId(defaultAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgentId]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const lastSubmittedAgentRef = useRef<string>("");
  // Multi-account mode kalau channel sudah punya account terkonfigurasi.
  const isAddAccountMode = existingAccountIds.length > 0;
  const [accountId, setAccountId] = useState<string>(() =>
    isAddAccountMode ? nextAgentAccountId(agentId, existingAccountIds) : "",
  );
  const { state, submit, runVerificationLoop } = useChannelPairingSubmit(
    entry.id,
    entry.label,
    onClose,
    onSuccess,
  );

  const tokenField = entry.tokenField;
  const isTelegram = entry.id === "telegram";
  const isDiscord = entry.id === "discord";

  const handleSubmit = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    if (!tokenField) {
      setValidationError(t.app.channels.pairing.genericError);
      return;
    }
    let accountIdOverride: string | undefined = undefined;
    if (isAddAccountMode) {
      const validated = validateAccountId(accountId, existingAccountIds);
      if (!validated.ok) {
        setValidationError(validated.reason);
        return;
      }
      accountIdOverride = validated.value;
    }
    // Resolve access policy from the chosen mode (shared hook).
    const built = accessControl.buildAccess();
    if (!built.ok) {
      setValidationError(built.error);
      return;
    }
    setValidationError(null);
    lastSubmittedAgentRef.current = agentId;
    await submit(
      { [tokenField]: trimmed, enabled: true, ...built.access },
      agentId,
      accountIdOverride,
    );
  }, [
    token,
    tokenField,
    agentId,
    submit,
    t,
    isAddAccountMode,
    accountId,
    existingAccountIds,
    accessControl,
  ]);

  const handlePollAgain = useCallback(async () => {
    if (!lastSubmittedAgentRef.current) return;
    await runVerificationLoop(lastSubmittedAgentRef.current);
  }, [runVerificationLoop]);

  const inFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const submitting = state.kind === "submitting";
  const restarting = state.kind === "restarting";
  const verifying = state.kind === "verifying";

  // Per-channel copy
  const stepOne = isTelegram
    ? t.app.channels.pairing.telegramStep1
    : isDiscord
      ? t.app.channels.pairing.discordStep1
      : t.app.channels.pairing.singleTokenStep1;
  const stepTwo = isTelegram
    ? t.app.channels.pairing.telegramStep2
    : isDiscord
      ? t.app.channels.pairing.discordStep2
      : t.app.channels.pairing.singleTokenStep2;
  const tokenLabel = isTelegram
    ? t.app.channels.pairing.telegramTokenLabel
    : isDiscord
      ? t.app.channels.pairing.discordTokenLabel
      : t.app.channels.pairing.singleTokenLabel;
  const tokenPlaceholder = isTelegram
    ? t.app.channels.pairing.telegramTokenPlaceholder
    : isDiscord
      ? t.app.channels.pairing.discordTokenPlaceholder
      : t.app.channels.pairing.singleTokenPlaceholder;
  const helpText = isTelegram
    ? t.app.channels.pairing.telegramHelp
    : isDiscord
      ? t.app.channels.pairing.discordHelp
      : t.app.channels.pairing.singleTokenHelp;
  const submitLabel = submitting
    ? t.app.channels.pairing.telegramSubmitting
    : restarting
      ? t.app.channels.pairing.restartingTitle
      : verifying
        ? t.app.channels.pairing.verifyingTitle
        : t.app.channels.pairing.telegramSubmit;

  return (
    <div className="px-5 py-5">
      <RestartHint />

      {isAddAccountMode ? (
        <div className="mb-4 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.04] px-4 py-2.5 text-[12px] text-cyan-100">
          <strong>Tambah akun baru</strong> — channel ini sudah punya{" "}
          {existingAccountIds.length} akun. Setiap akun bisa di-bind ke agent
          berbeda.
        </div>
      ) : null}

      <ol className="mb-4 space-y-2">
        <Step n={1} text={stepOne} />
        <Step n={2} text={stepTwo} />
      </ol>

      <AgentPicker value={agentId} onChange={setAgentId} disabled={inFlight} />

      {isAddAccountMode ? (
        <label className="mt-4 block">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
            Account ID (label akun)
          </span>
          <input
            type="text"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="mis. sales-bot, cs-humas"
            autoComplete="off"
            spellCheck={false}
            disabled={inFlight}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-1.5 text-[11px] text-white/40">
            Slug unique untuk identifikasi akun. Huruf kecil, angka, tanda
            hubung. Default: <code className="text-cyan-200/80">{nextAgentAccountId(agentId, existingAccountIds)}</code>.
          </p>
        </label>
      ) : null}

      <label className="mt-4 block">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
          {tokenLabel}
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={tokenPlaceholder}
          autoComplete="off"
          spellCheck={false}
          disabled={inFlight}
          className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>
      <p className="mt-1.5 text-[11px] text-white/40">{helpText}</p>

      <AccessControlPanel
        channelId={entry.id}
        control={accessControl}
        disabled={inFlight}
      />

      {entry.docsHref ? (
        <a
          href={entry.docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-cyan-200/70 hover:text-cyan-200"
        >
          <ExternalLink className="size-3" />
          {t.app.channels.pairing.openDocs}
        </a>
      ) : null}

      <PairingFeedback state={state} validationError={validationError} />

      <PairingActions
        state={state}
        canSubmit={Boolean(
          token.trim() &&
            agentId &&
            (!isAddAccountMode || accountId.trim()),
        )}
        onSubmit={() => void handleSubmit()}
        onClose={onClose}
        onPollAgain={() => void handlePollAgain()}
        submitLabel={submitLabel}
      />
    </div>
  );
}

// ── Slack 3-token Pairing ───────────────────────────────────────────────

function EmailPairingBody({
  onClose,
  entry,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
  onSuccess?: (info: PairingSuccessInfo) => void;
  existingAccountIds: string[];
  defaultAgentId?: string;
}) {
  const { t } = useI18n();
  const [emailAddress, setEmailAddress] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  useEffect(() => {
    if (defaultAgentId && !agentId) setAgentId(defaultAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgentId]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const lastSubmittedAgentRef = useRef<string>("");
  const isAddAccountMode = existingAccountIds.length > 0;
  const [accountId] = useState<string>(() =>
    isAddAccountMode ? nextAgentAccountId(agentId, existingAccountIds) : "",
  );
  const { state, submit, runVerificationLoop } = useChannelPairingSubmit(
    entry.id,
    entry.label,
    onClose,
    onSuccess,
  );

  const inFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const submitting = state.kind === "submitting";
  const restarting = state.kind === "restarting";
  const verifying = state.kind === "verifying";

  const ready =
    emailAddress.trim().includes("@") &&
    emailPassword.trim().length > 0 &&
    imapHost.trim().length > 0 &&
    smtpHost.trim().length > 0 &&
    Boolean(agentId) &&
    !inFlight;

  const handleSubmit = useCallback(async () => {
    if (!emailAddress.trim().includes("@")) {
      setValidationError("Alamat email tidak valid.");
      return;
    }
    let accountIdOverride: string | undefined = undefined;
    if (isAddAccountMode) {
      const validated = validateAccountId(accountId, existingAccountIds);
      if (!validated.ok) {
        setValidationError(validated.reason);
        return;
      }
      accountIdOverride = validated.value;
    }
    setValidationError(null);
    lastSubmittedAgentRef.current = agentId;
    await submit(
      {
        emailAddress: emailAddress.trim(),
        emailPassword: emailPassword.trim(),
        imapHost: imapHost.trim(),
        ...(imapPort.trim() ? { imapPort: imapPort.trim() } : {}),
        smtpHost: smtpHost.trim(),
        ...(smtpPort.trim() ? { smtpPort: smtpPort.trim() } : {}),
        enabled: true,
      },
      agentId,
      accountIdOverride,
    );
  }, [
    emailAddress,
    emailPassword,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    agentId,
    submit,
    isAddAccountMode,
    accountId,
    existingAccountIds,
  ]);

  const handlePollAgain = useCallback(async () => {
    if (!lastSubmittedAgentRef.current) return;
    await runVerificationLoop(lastSubmittedAgentRef.current);
  }, [runVerificationLoop]);

  const submitLabel = submitting
    ? t.app.channels.pairing.telegramSubmitting
    : restarting
      ? t.app.channels.pairing.restartingTitle
      : verifying
        ? t.app.channels.pairing.verifyingTitle
        : t.app.channels.pairing.telegramSubmit;

  return (
    <div className="px-5 py-5">
      <RestartHint />
      <p className="mb-4 text-[13px] text-white/70">
        Hubungkan akun email (IMAP/SMTP) — agen ini akan membaca &amp; membalas
        email masuk otomatis. Untuk Gmail/Outlook, pakai{" "}
        <span className="font-semibold text-white/85">App Password</span> (bukan
        password biasa).
      </p>

      <AgentPicker value={agentId} onChange={setAgentId} disabled={inFlight} />

      <div className="mt-4 space-y-3">
        <SlackInput
          label="Alamat Email"
          help="Email yang akan dipakai agen ini"
          placeholder="cs@tokokamu.com"
          value={emailAddress}
          onChange={setEmailAddress}
          disabled={inFlight}
        />
        <SlackInput
          label="Password / App Password"
          help="Gmail/Outlook: wajib App Password"
          placeholder="••••••••••••••••"
          value={emailPassword}
          onChange={setEmailPassword}
          disabled={inFlight}
        />
        <SlackInput
          label="IMAP Host (server masuk)"
          help="mis. imap.gmail.com / outlook.office365.com"
          placeholder="imap.gmail.com"
          value={imapHost}
          onChange={setImapHost}
          disabled={inFlight}
        />
        <SlackInput
          label="IMAP Port"
          help="default 993 (SSL)"
          placeholder="993"
          value={imapPort}
          onChange={setImapPort}
          disabled={inFlight}
        />
        <SlackInput
          label="SMTP Host (server keluar)"
          help="mis. smtp.gmail.com / smtp.office365.com"
          placeholder="smtp.gmail.com"
          value={smtpHost}
          onChange={setSmtpHost}
          disabled={inFlight}
        />
        <SlackInput
          label="SMTP Port"
          help="default 587 (STARTTLS)"
          placeholder="587"
          value={smtpPort}
          onChange={setSmtpPort}
          disabled={inFlight}
        />
      </div>

      {entry.docsHref ? (
        <a
          href={entry.docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-[11px] text-cyan-200/70 hover:text-cyan-200"
        >
          <ExternalLink className="size-3" />
          {t.app.channels.pairing.openDocs}
        </a>
      ) : null}

      <PairingFeedback state={state} validationError={validationError} />

      <PairingActions
        state={state}
        canSubmit={ready}
        onSubmit={() => void handleSubmit()}
        onClose={onClose}
        onPollAgain={() => void handlePollAgain()}
        submitLabel={submitLabel}
      />
    </div>
  );
}

function SlackTokensPairingBody({
  onClose,
  entry,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
  onSuccess?: (info: PairingSuccessInfo) => void;
  existingAccountIds: string[];
  defaultAgentId?: string;
}) {
  const { t } = useI18n();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const accessControl = useChannelAccessControl(entry.id);
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  useEffect(() => {
    if (defaultAgentId && !agentId) setAgentId(defaultAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgentId]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const lastSubmittedAgentRef = useRef<string>("");
  const isAddAccountMode = existingAccountIds.length > 0;
  const [accountId, setAccountId] = useState<string>(() =>
    isAddAccountMode ? nextAgentAccountId(agentId, existingAccountIds) : "",
  );
  const { state, submit, runVerificationLoop } = useChannelPairingSubmit(
    entry.id,
    entry.label,
    onClose,
    onSuccess,
  );

  const inFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const submitting = state.kind === "submitting";
  const restarting = state.kind === "restarting";
  const verifying = state.kind === "verifying";

  const ready =
    botToken.trim().startsWith("xoxb-") &&
    appToken.trim().startsWith("xapp-") &&
    Boolean(agentId) &&
    (!isAddAccountMode || accountId.trim().length > 0) &&
    !inFlight;

  const handleSubmit = useCallback(async () => {
    const bt = botToken.trim();
    const at = appToken.trim();
    const ss = signingSecret.trim();
    if (!bt.startsWith("xoxb-")) {
      setValidationError(t.app.channels.pairing.slackBotTokenInvalid);
      return;
    }
    if (!at.startsWith("xapp-")) {
      setValidationError(t.app.channels.pairing.slackAppTokenInvalid);
      return;
    }
    let accountIdOverride: string | undefined = undefined;
    if (isAddAccountMode) {
      const validated = validateAccountId(accountId, existingAccountIds);
      if (!validated.ok) {
        setValidationError(validated.reason);
        return;
      }
      accountIdOverride = validated.value;
    }
    const built = accessControl.buildAccess();
    if (!built.ok) {
      setValidationError(built.error);
      return;
    }
    setValidationError(null);
    lastSubmittedAgentRef.current = agentId;
    await submit(
      {
        mode: "socket",
        botToken: bt,
        appToken: at,
        ...(ss ? { signingSecret: ss } : {}),
        enabled: true,
        ...built.access,
      },
      agentId,
      accountIdOverride,
    );
  }, [
    botToken,
    appToken,
    signingSecret,
    agentId,
    submit,
    t,
    isAddAccountMode,
    accountId,
    existingAccountIds,
    accessControl,
  ]);

  const handlePollAgain = useCallback(async () => {
    if (!lastSubmittedAgentRef.current) return;
    await runVerificationLoop(lastSubmittedAgentRef.current);
  }, [runVerificationLoop]);

  const submitLabel = submitting
    ? t.app.channels.pairing.telegramSubmitting
    : restarting
      ? t.app.channels.pairing.restartingTitle
      : verifying
        ? t.app.channels.pairing.verifyingTitle
        : t.app.channels.pairing.telegramSubmit;

  return (
    <div className="px-5 py-5">
      <RestartHint />

      <ol className="mb-4 space-y-2">
        <Step n={1} text={t.app.channels.pairing.slackStep1} />
        <Step n={2} text={t.app.channels.pairing.slackStep2} />
        <Step n={3} text={t.app.channels.pairing.slackStep3} />
      </ol>

      <AgentPicker value={agentId} onChange={setAgentId} disabled={inFlight} />

      <div className="mt-4 space-y-3">
        <SlackInput
          label={t.app.channels.pairing.slackBotTokenLabel}
          help={t.app.channels.pairing.slackBotTokenHelp}
          placeholder="xoxb-..."
          value={botToken}
          onChange={setBotToken}
          disabled={inFlight}
        />
        <SlackInput
          label={t.app.channels.pairing.slackAppTokenLabel}
          help={t.app.channels.pairing.slackAppTokenHelp}
          placeholder="xapp-..."
          value={appToken}
          onChange={setAppToken}
          disabled={inFlight}
        />
        <SlackInput
          label={t.app.channels.pairing.slackSigningSecretLabel}
          help={t.app.channels.pairing.slackSigningSecretHelp}
          placeholder={t.app.channels.pairing.slackSigningSecretPlaceholder}
          value={signingSecret}
          onChange={setSigningSecret}
          disabled={inFlight}
        />
      </div>

      <AccessControlPanel
        channelId={entry.id}
        control={accessControl}
        disabled={inFlight}
      />

      {entry.docsHref ? (
        <a
          href={entry.docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-[11px] text-cyan-200/70 hover:text-cyan-200"
        >
          <ExternalLink className="size-3" />
          {t.app.channels.pairing.openDocs}
        </a>
      ) : null}

      <PairingFeedback state={state} validationError={validationError} />

      <PairingActions
        state={state}
        canSubmit={ready}
        onSubmit={() => void handleSubmit()}
        onClose={onClose}
        onPollAgain={() => void handlePollAgain()}
        submitLabel={submitLabel}
      />
    </div>
  );
}

function SlackInput({
  label,
  help,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
        {label}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="mt-1 block text-[11px] text-white/40">{help}</span>
    </label>
  );
}

// ── Service Account JSON (Google Chat) ──────────────────────────────────

function ServiceAccountJsonBody({
  onClose,
  entry,
  onSuccess,
  existingAccountIds,
  defaultAgentId,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
  onSuccess?: (info: PairingSuccessInfo) => void;
  existingAccountIds: string[];
  defaultAgentId?: string;
}) {
  const { t } = useI18n();
  const [json, setJson] = useState("");
  const [subscriptionName, setSubscriptionName] = useState("");
  const accessControl = useChannelAccessControl(entry.id);
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  useEffect(() => {
    if (defaultAgentId && !agentId) setAgentId(defaultAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgentId]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const lastSubmittedAgentRef = useRef<string>("");
  const isAddAccountMode = existingAccountIds.length > 0;
  const [accountId, setAccountId] = useState<string>(() =>
    isAddAccountMode ? nextAgentAccountId(agentId, existingAccountIds) : "",
  );
  const { state, submit, runVerificationLoop } = useChannelPairingSubmit(
    entry.id,
    entry.label,
    onClose,
    onSuccess,
  );

  const inFlight =
    state.kind === "submitting" ||
    state.kind === "restarting" ||
    state.kind === "verifying";
  const submitting = state.kind === "submitting";
  const restarting = state.kind === "restarting";
  const verifying = state.kind === "verifying";

  const handleSubmit = useCallback(async () => {
    const trimmed = json.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      setValidationError(t.app.channels.pairing.googlechatJsonInvalid);
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { type?: string }).type !== "service_account"
    ) {
      setValidationError(t.app.channels.pairing.googlechatNotServiceAccount);
      return;
    }
    // Derive project_id from the SA JSON (every service account carries it) so
    // the chief doesn't have to type it again.
    const saProjectId = (parsed as { project_id?: unknown }).project_id;
    if (typeof saProjectId !== "string" || !saProjectId) {
      setValidationError(t.app.channels.pairing.googlechatNoProjectId);
      return;
    }
    // Google Chat receives messages via a Pub/Sub PULL subscription. The
    // adapter requires the full path + it must belong to the SA's project.
    const sub = subscriptionName.trim();
    const subMatch = /^projects\/([^/]+)\/subscriptions\/([^/]+)$/.exec(sub);
    if (!subMatch) {
      setValidationError(t.app.channels.pairing.googlechatSubscriptionInvalid);
      return;
    }
    if (subMatch[1] !== saProjectId) {
      setValidationError(t.app.channels.pairing.googlechatProjectMismatch);
      return;
    }
    let accountIdOverride: string | undefined = undefined;
    if (isAddAccountMode) {
      const validated = validateAccountId(accountId, existingAccountIds);
      if (!validated.ok) {
        setValidationError(validated.reason);
        return;
      }
      accountIdOverride = validated.value;
    }
    const built = accessControl.buildAccess();
    if (!built.ok) {
      setValidationError(built.error);
      return;
    }
    setValidationError(null);
    lastSubmittedAgentRef.current = agentId;
    await submit(
      {
        // RAW JSON string — the bridge synthetic path only copies STRING creds
        // into platforms.<x>.extra (isinstance str); a parsed object would be
        // silently dropped. GoogleChatAdapter accepts inline JSON here.
        serviceAccountJson: trimmed,
        projectId: saProjectId,
        subscriptionName: sub,
        enabled: true,
        ...built.access,
      },
      agentId,
      accountIdOverride,
    );
  }, [
    json,
    subscriptionName,
    agentId,
    submit,
    t,
    isAddAccountMode,
    accountId,
    existingAccountIds,
    accessControl,
  ]);

  const handlePollAgain = useCallback(async () => {
    if (!lastSubmittedAgentRef.current) return;
    await runVerificationLoop(lastSubmittedAgentRef.current);
  }, [runVerificationLoop]);

  const submitLabel = submitting
    ? t.app.channels.pairing.telegramSubmitting
    : restarting
      ? t.app.channels.pairing.restartingTitle
      : verifying
        ? t.app.channels.pairing.verifyingTitle
        : t.app.channels.pairing.telegramSubmit;

  return (
    <div className="px-5 py-5">
      <RestartHint />

      {isAddAccountMode ? (
        <div className="mb-4 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.04] px-4 py-2.5 text-[12px] text-cyan-100">
          <strong>Tambah akun baru</strong> — channel ini sudah punya{" "}
          {existingAccountIds.length} akun. Setiap akun bisa di-bind ke agent
          berbeda.
        </div>
      ) : null}

      <p className="mb-3 text-sm text-white/75">
        {t.app.channels.pairing.googlechatInstruction}
      </p>

      <AgentPicker value={agentId} onChange={setAgentId} disabled={inFlight} />

      {isAddAccountMode ? (
        <label className="mt-4 block">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
            Account ID (label akun)
          </span>
          <input
            type="text"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="mis. sales-bot, cs-humas"
            autoComplete="off"
            spellCheck={false}
            disabled={inFlight}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-1.5 text-[11px] text-white/40">
            Slug unique untuk identifikasi akun. Huruf kecil, angka, tanda
            hubung. Default:{" "}
            <code className="text-cyan-200/80">
              {nextAgentAccountId(agentId, existingAccountIds)}
            </code>
            .
          </p>
        </label>
      ) : null}

      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder='{"type":"service_account",...}'
        rows={8}
        autoComplete="off"
        spellCheck={false}
        disabled={inFlight}
        className="mt-4 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />

      <label className="mt-4 block">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
          {t.app.channels.pairing.googlechatSubscriptionLabel}
        </span>
        <input
          type="text"
          value={subscriptionName}
          onChange={(e) => setSubscriptionName(e.target.value)}
          placeholder={t.app.channels.pairing.googlechatSubscriptionPlaceholder}
          autoComplete="off"
          spellCheck={false}
          disabled={inFlight}
          className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-1.5 text-[11px] text-white/40">
          {t.app.channels.pairing.googlechatSubscriptionHelp}
        </p>
      </label>

      <AccessControlPanel
        channelId={entry.id}
        control={accessControl}
        disabled={inFlight}
      />

      {entry.docsHref ? (
        <a
          href={entry.docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-cyan-200/70 hover:text-cyan-200"
        >
          <ExternalLink className="size-3" />
          {t.app.channels.pairing.openDocs}
        </a>
      ) : null}

      <PairingFeedback state={state} validationError={validationError} />

      <PairingActions
        state={state}
        canSubmit={Boolean(
          json.trim() &&
            subscriptionName.trim() &&
            agentId &&
            (!isAddAccountMode || accountId.trim()),
        )}
        onSubmit={() => void handleSubmit()}
        onClose={onClose}
        onPollAgain={() => void handlePollAgain()}
        submitLabel={submitLabel}
      />
    </div>
  );
}

// ── Manual setup (Signal/iMessage/Nostr) ────────────────────────────────

function ManualSetupBody({
  onClose,
  entry,
}: {
  onClose: () => void;
  entry: ChannelCatalogEntry;
}) {
  const { t } = useI18n();
  return (
    <div className="px-5 py-5">
      <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-4 py-3 text-sm text-amber-100">
        Setup {entry.label} membutuhkan langkah tambahan di luar dashboard
        ini. Kontak support kami untuk panduan setup, atau cek dokumentasi
        resmi.
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
        >
          {t.app.channels.pairing.close}
        </button>
        {entry.docsHref ? (
          <a
            href={entry.docsHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
          >
            <ExternalLink className="size-3.5" />
            Buka Dokumentasi
          </a>
        ) : null}
      </div>
    </div>
  );
}

// Suppress unused-import warnings for ReactNode. ReactNode reserved untuk
// future composition when adapter bodies pass children.
export type { ReactNode };
