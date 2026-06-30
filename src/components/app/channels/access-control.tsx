"use client";

/**
 * access-control.tsx — shared "who may chat this bot" UI + state for channel
 * pairing. Sender-gated channels (Telegram, Discord, Slack, WhatsApp) map a
 * per-account allowlist onto the engine's *_ALLOWED_USERS env via the bridge
 * (channels_handler._allowlist_env_updates / _synthetic_allow_env).
 *
 * Default mode = "allowlist" (secure: a freshly paired bot is NOT world-open).
 * The user can opt into "all" for a public bot. The engine semantics:
 *   - allowlist → dmPolicy "allowlist" + allowFrom = explicit ids
 *   - all       → dmPolicy "open" + allowFrom ["*"] (wildcard companion is
 *                 REQUIRED by engine validation when dmPolicy is open)
 */

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { getClient } from "@/lib/app/store";
import { validateAllowlistEntry, splitAllowlistPaste } from "./helpers";

export type DmMode = "allowlist" | "all";

export type BuildAccessResult =
  | { ok: true; access: Record<string, unknown> }
  | { ok: false; error: string };

export interface ChannelAccessControl {
  dmMode: DmMode;
  setDmMode: (m: DmMode) => void;
  allowlist: string[];
  setAllowlist: React.Dispatch<React.SetStateAction<string[]>>;
  allowInput: string;
  setAllowInput: (v: string) => void;
  commitAllow: (raw: string) => void;
  /** Resolve the chosen mode into engine policy fields. Commits any pending
   *  text in the input box first so a typed-but-not-Enter id isn't dropped. */
  buildAccess: () => BuildAccessResult;
}

export function useChannelAccessControl(channelId: string): ChannelAccessControl {
  const [dmMode, setDmMode] = useState<DmMode>("allowlist");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [allowInput, setAllowInput] = useState("");

  const commitAllow = useCallback(
    (raw: string) => {
      const next: string[] = [];
      for (const part of splitAllowlistPaste(raw)) {
        const v = validateAllowlistEntry(channelId, part);
        if (v.ok && v.normalized) next.push(v.normalized);
      }
      if (next.length) {
        setAllowlist((prev) => Array.from(new Set([...prev, ...next])));
        setAllowInput("");
      }
    },
    [channelId],
  );

  const buildAccess = useCallback((): BuildAccessResult => {
    if (dmMode === "all") {
      return {
        ok: true,
        access: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groupAllowFrom: ["*"],
        },
      };
    }
    const finalAllow = [...allowlist];
    if (allowInput.trim()) {
      for (const part of splitAllowlistPaste(allowInput)) {
        const v = validateAllowlistEntry(channelId, part);
        if (v.ok && v.normalized && !finalAllow.includes(v.normalized)) {
          finalAllow.push(v.normalized);
        }
      }
    }
    if (finalAllow.length === 0) {
      return {
        ok: false,
        error: "Tambah minimal 1 ID/nomor yang boleh chat, atau pilih “Semua orang”.",
      };
    }
    return {
      ok: true,
      access: {
        dmPolicy: "allowlist",
        allowFrom: finalAllow,
        groupPolicy: "allowlist",
        groupAllowFrom: finalAllow,
      },
    };
  }, [dmMode, allowlist, allowInput, channelId]);

  return {
    dmMode,
    setDmMode,
    allowlist,
    setAllowlist,
    allowInput,
    setAllowInput,
    commitAllow,
    buildAccess,
  };
}

/**
 * AccessControlDialog — edit who-may-chat for an ALREADY-paired account.
 * Loads current allowlist via channels.getAccess (reads the engine env, the
 * real gate), saves via channels.setAccess (rewrites the env + restarts).
 * Works for native (account_id default) and synthetic (per-agent) accounts.
 */
export function AccessControlDialog({
  open,
  channelId,
  channelLabel,
  accountId,
  agentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  channelId: string;
  channelLabel: string;
  accountId?: string;
  agentId?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <AccessDialogBody
              channelId={channelId}
              channelLabel={channelLabel}
              accountId={accountId}
              agentId={agentId}
              onClose={onClose}
              onSaved={onSaved}
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function AccessDialogBody({
  channelId,
  channelLabel,
  accountId,
  agentId,
  onClose,
  onSaved,
}: {
  channelId: string;
  channelLabel: string;
  accountId?: string;
  agentId?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const control = useChannelAccessControl(channelId);
  const { setDmMode, setAllowlist } = control;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadState("loading");
        const client = getClient();
        if (!client) throw new Error("Gateway belum terhubung");
        const res = (await client.request("channels.getAccess", {
          channel: channelId,
          accountId,
          agentId,
        })) as { dmMode?: string; allowlist?: string[] };
        if (cancelled) return;
        setDmMode(res?.dmMode === "all" ? "all" : "allowlist");
        setAllowlist(Array.isArray(res?.allowlist) ? res.allowlist : []);
        setLoadState("ready");
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : "Gagal memuat akses");
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, accountId, agentId]);

  const handleSave = useCallback(async () => {
    const built = control.buildAccess();
    if (!built.ok) {
      setErrorMsg(built.error);
      setSaveState("error");
      return;
    }
    setSaveState("saving");
    setErrorMsg(null);
    try {
      const client = getClient();
      if (!client) throw new Error("Gateway belum terhubung");
      await client.request("channels.setAccess", {
        channel: channelId,
        accountId,
        agentId,
        allowFrom: built.access.allowFrom,
        groupAllowFrom: built.access.groupAllowFrom,
      });
      setSaveState("saved");
      onSaved?.();
      setTimeout(onClose, 1200);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Gagal menyimpan");
      setSaveState("error");
    }
  }, [control, channelId, accountId, agentId, onClose, onSaved]);

  const busy = saveState === "saving";

  return (
    <div>
      <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-white/95">
            Atur akses chat
          </h2>
          <p className="text-[12px] text-white/55">
            {channelLabel}
            {accountId && accountId !== "default" ? ` · ${accountId}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup"
          className="rounded-md p-1.5 text-white/55 transition hover:bg-white/[0.05] hover:text-white"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="px-5 py-4">
        {loadState === "loading" ? (
          <div className="flex items-center justify-center py-8 text-white/45">
            <Loader2 className="mr-2 size-4 animate-spin" />
            <span className="text-sm">Memuat akses…</span>
          </div>
        ) : loadState === "error" ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-100">
            {errorMsg ?? "Gagal memuat"}
          </div>
        ) : (
          <>
            <AccessControlPanel
              channelId={channelId}
              control={control}
              disabled={busy}
            />
            {errorMsg && saveState === "error" ? (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-100">
                {errorMsg}
              </div>
            ) : null}
            {saveState === "saved" ? (
              <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2 text-[12px] text-emerald-100">
                <CheckCircle2 className="size-3.5" />
                Tersimpan. Bot direstart sebentar…
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t border-white/[0.06] px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08] disabled:opacity-50"
        >
          Batal
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={loadState !== "ready" || busy || saveState === "saved"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] transition hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Simpan
        </button>
      </footer>
    </div>
  );
}

export function AccessControlPanel({
  channelId,
  control,
  disabled,
}: {
  channelId: string;
  control: ChannelAccessControl;
  disabled?: boolean;
}) {
  const {
    dmMode,
    setDmMode,
    allowlist,
    setAllowlist,
    allowInput,
    setAllowInput,
    commitAllow,
  } = control;

  const placeholder =
    channelId === "telegram"
      ? "user id angka, mis. 123456789"
      : channelId === "whatsapp"
        ? "+628123… (nomor)"
        : channelId === "discord"
          ? "user id (angka)"
          : channelId === "google_chat"
            ? "nama@domain.com (email)"
            : "id / username — pisah koma";

  // Telegram gates ONLY by numeric user id (from_user.id). @username is never
  // matched by the engine, so we require the numeric id outright.
  const idHint =
    channelId === "telegram"
      ? "Wajib user ID angka — minta user kirim /start ke @userinfobot. @username tidak diterima."
      : null;

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
        Siapa yang boleh chat bot ini?
      </span>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => setDmMode("allowlist")}
          disabled={disabled}
          className={
            "flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition " +
            (dmMode === "allowlist"
              ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100"
              : "border-white/10 bg-black/30 text-white/55 hover:text-white")
          }
        >
          Hanya orang tertentu
        </button>
        <button
          type="button"
          onClick={() => setDmMode("all")}
          disabled={disabled}
          className={
            "flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition " +
            (dmMode === "all"
              ? "border-amber-400/50 bg-amber-500/15 text-amber-100"
              : "border-white/10 bg-black/30 text-white/55 hover:text-white")
          }
        >
          Semua orang
        </button>
      </div>
      {dmMode === "all" ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200/70">
          ⚠️ Bot publik — siapa pun yang nemu bot ini bisa chat + pakai akunmu.
          Pilih ini cuma kalau memang mau bot terbuka untuk umum.
        </p>
      ) : (
        <div className="mt-2">
          <div className="flex gap-2">
            <input
              value={allowInput}
              onChange={(e) => setAllowInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitAllow(allowInput);
                }
              }}
              onBlur={() => commitAllow(allowInput)}
              placeholder={placeholder}
              disabled={disabled}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => commitAllow(allowInput)}
              disabled={disabled || !allowInput.trim()}
              className="shrink-0 rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
            >
              Tambah
            </button>
          </div>
          {allowlist.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {allowlist.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-white/80"
                >
                  {a}
                  <button
                    type="button"
                    onClick={() => setAllowlist((p) => p.filter((x) => x !== a))}
                    disabled={disabled}
                    className="text-white/40 hover:text-red-300"
                    aria-label={`Hapus ${a}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-white/40">
              Masukin ID/username/nomor yang boleh chat — cuma mereka yang bakal
              dibales bot. (Bisa banyak, pisah koma.)
            </p>
          )}
          {idHint ? (
            <p className="mt-1.5 text-[11px] text-amber-200/60">{idHint}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
