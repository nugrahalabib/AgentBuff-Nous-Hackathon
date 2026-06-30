"use client";

/**
 * SessionDetailDrawer — slide-in panel dengan 3 tab full-functional:
 *  1. Ringkasan — overview + token stats + model + inline rename
 *  2. Snapshot — fetch sessions.compaction.list + branch/restore actions
 *  3. Lanjutan — editable AI behavior settings (sessions.patch) + reset + compact
 *
 * Semua RPC wired via useSessionActions hook.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  Coins,
  Cpu,
  ExternalLink,
  Fingerprint,
  Loader2,
  MapPin,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/app/store";
import { useSessionActions } from "@/hooks/use-session-actions";
import {
  contextPercent,
  formatModel,
  formatRelative,
  formatRuntime,
  formatTokens,
  kindLabel,
  kindTone,
  modelProviderBadge,
  statusLabel,
  statusTone,
  thinkingLevelLabel,
} from "./helpers";
import {
  humanChannel,
  humanSurfaceName,
} from "@/components/app/usage/helpers";

export type DrawerTab = "summary" | "advanced";
// NOTE: "snapshots" tab removed 2026-05-24 — Hermes engine doesn't expose
// session-level compaction checkpoints (OpenClaw concept). Bridge stubs
// sessions.compaction.* RPCs but the UI tab is hidden to avoid a dead-end.

export function SessionDetailDrawer({
  open,
  session,
  now,
  onClose,
  onOpen,
  onDelete,
}: {
  open: boolean;
  session: SessionSummary | null;
  now: number;
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const asideRef = useRef<HTMLElement>(null);
  // Dialog a11y: Esc-close + Tab focus-trap + initial focus + focus restore,
  // wired only while open (the drawer stays mounted via AnimatePresence).
  useEffect(() => {
    if (!(open && session)) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const FOCUSABLE =
      'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = asideRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => asideRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [open, session, onClose]);

  return (
    <AnimatePresence>
      {open && session ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[100] flex justify-end bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.aside
            ref={asideRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="relative h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-[#0B0E14] shadow-[-30px_0_60px_-20px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-drawer-title"
          >
            <Body
              session={session}
              now={now}
              onClose={onClose}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Body({
  session,
  now,
  onClose,
  onOpen,
  onDelete,
}: {
  session: SessionSummary;
  now: number;
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const s = t.app.sessions;
  const [tab, setTab] = useState<DrawerTab>("summary");
  const [toast, setToast] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const tone = kindTone(session.kind);
  const model = formatModel(session.model, session.modelProvider);
  const providerBadge = modelProviderBadge(session.modelProvider);
  const sLabel = statusLabel(session.status, session.abortedLastRun);
  const statusToneColor = statusTone(session.status);
  const ctxPct = contextPercent(session);

  // Auto-dismiss toast after 3s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <>
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-white/[0.06] bg-[#0B0E14]/95 backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
                  tone === "cyan"
                    ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
                    : tone === "indigo"
                      ? "border-indigo-400/30 bg-indigo-400/10 text-indigo-100"
                      : tone === "fuchsia"
                        ? "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100"
                        : "border-white/15 bg-white/[0.04] text-white/70",
                )}
              >
                {kindLabel(session.kind)}
              </span>
              {session.status === "running" || session.abortedLastRun ? (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
                    statusToneColor === "emerald"
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                      : statusToneColor === "amber"
                        ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
                        : "border-red-500/30 bg-red-500/10 text-red-100",
                  )}
                >
                  {sLabel}
                </span>
              ) : null}
            </div>
            <TitleEditor
              session={session}
              onSaved={(text) =>
                setToast({ kind: "success", text })
              }
              onError={(text) => setToast({ kind: "error", text })}
            />
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
              {session.key}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={s.drawerClose}
            className="rounded-md p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
        {/* Tab bar — Snapshots tab hidden (engine limitation, see DrawerTab note) */}
        <div className="flex border-t border-white/[0.04]">
          <TabBtn active={tab === "summary"} onClick={() => setTab("summary")}>
            {s.drawerTabSummary}
          </TabBtn>
          <TabBtn active={tab === "advanced"} onClick={() => setTab("advanced")}>
            {s.drawerTabAdvanced}
          </TabBtn>
        </div>
      </header>

      {/* Toast */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={cn(
              "fixed left-1/2 top-20 z-[200] -translate-x-1/2 rounded-lg border px-4 py-2 text-[12px] shadow-lg backdrop-blur-xl",
              toast.kind === "success"
                ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                : "border-red-500/40 bg-red-500/15 text-red-100",
            )}
            role="status"
            aria-live="polite"
          >
            {toast.text}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Tab body */}
      <div className="space-y-4 px-5 py-5">
        {tab === "summary" ? (
          <SummaryTab
            session={session}
            now={now}
            sLabel={sLabel}
            model={model}
            providerBadge={providerBadge}
            ctxPct={ctxPct}
            i={s}
          />
        ) : null}
        {tab === "advanced" ? (
          <AdvancedTab
            session={session}
            onDelete={onDelete}
            onActionToast={(kind, text) => setToast({ kind, text })}
            i={s}
          />
        ) : null}
      </div>

      {/* Sticky footer */}
      <footer className="sticky bottom-0 flex gap-2 border-t border-white/[0.06] bg-[#0B0E14]/95 px-5 py-3.5 backdrop-blur-xl">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/20 hover:bg-white/[0.08]"
        >
          {s.drawerClose}
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-1.5 text-xs font-bold text-[#0B0E14] hover:brightness-110"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {s.open}
        </button>
      </footer>
    </>
  );
}

/* ─── Title with inline rename ─── */
function TitleEditor({
  session,
  onSaved,
  onError,
}: {
  session: SessionSummary;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const s = t.app.sessions;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title);
  const { rename, isBusy } = useSessionActions();

  // Reset fully only when switching to a different session.
  useEffect(() => {
    setValue(session.title);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  // Sync the field to an external title change ONLY when not editing — a 10s
  // background poll updating session.title must not wipe an in-progress rename.
  useEffect(() => {
    if (!editing) setValue(session.title);
  }, [session.title, editing]);

  const handleSave = async () => {
    const trimmed = value.trim();
    const result = await rename(session.key, trimmed);
    if (result.ok) {
      setEditing(false);
      onSaved(s.renameSuccess);
    } else {
      onError(`${s.renameFailed}: ${result.error}`);
    }
  };

  if (editing) {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") {
              setValue(session.title);
              setEditing(false);
            }
          }}
          autoFocus
          maxLength={512}
          className="min-w-0 flex-1 rounded-md border border-cyan-400/50 bg-black/40 px-2 py-1 font-display text-base font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
          placeholder={s.renamePlaceholder}
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isBusy}
          className="inline-flex items-center gap-1 rounded-md bg-cyan-400 px-2 py-1 text-[11px] font-bold text-[#0B0E14] hover:brightness-110 disabled:opacity-50"
        >
          {isBusy ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3" aria-hidden />
          )}
          {s.renameSave}
        </button>
        <button
          type="button"
          onClick={() => {
            setValue(session.title);
            setEditing(false);
          }}
          className="inline-flex items-center rounded-md border border-white/15 bg-white/[0.04] px-2 py-1 text-[11px] text-white/70 hover:text-white"
        >
          {s.renameCancel}
        </button>
      </div>
    );
  }

  return (
    <div className="group mt-1.5 flex items-start gap-1.5">
      <h2 id="session-drawer-title" className="min-w-0 flex-1 font-display text-lg font-bold text-white">
        {session.title}
      </h2>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Ganti nama"
        aria-label="Ganti nama"
        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/55 opacity-0 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200 group-hover:opacity-100"
      >
        <Pencil className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 border-b-2 px-3 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] transition",
        active
          ? "border-cyan-400 text-cyan-200"
          : "border-transparent text-white/55 hover:text-white/85",
      )}
    >
      {children}
    </button>
  );
}

function SummaryTab({
  session,
  now,
  sLabel,
  model,
  providerBadge,
  ctxPct,
  i,
}: {
  session: SessionSummary;
  now: number;
  sLabel: string;
  model: string | null;
  providerBadge: string | null;
  ctxPct: number | null;
  i: ReturnType<typeof useI18n>["t"]["app"]["sessions"];
}) {
  return (
    <>
      <Section icon={Activity} title={i.drawerSectionStats}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat label="Status" value={sLabel} />
          <Stat
            label={i.columnUpdated}
            value={formatRelative(session.updatedAt, now)}
          />
          {session.startedAt ? (
            <Stat label="Mulai" value={formatRelative(session.startedAt, now)} />
          ) : null}
          {session.runtimeMs ? (
            <Stat label="Durasi" value={formatRuntime(session.runtimeMs)} />
          ) : null}
        </div>
      </Section>

      <Section icon={Coins} title="Penggunaan Token">
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat
            label="Input"
            value={formatTokens(session.inputTokens)}
            mono
            highlight="cyan"
          />
          <Stat
            label="Output"
            value={formatTokens(session.outputTokens)}
            mono
            highlight="fuchsia"
          />
          <Stat
            label="Total"
            value={formatTokens(session.totalTokens)}
            mono
            highlight="amber"
          />
        </div>
        {ctxPct != null ? (
          <div className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-[11px] text-white/55">
              <span>{i.contextLabel} window</span>
              <span
                className={cn(
                  "font-mono font-semibold",
                  ctxPct >= 85
                    ? "text-red-300"
                    : ctxPct >= 60
                      ? "text-amber-300"
                      : "text-emerald-300",
                )}
              >
                {ctxPct}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  ctxPct >= 85
                    ? "bg-gradient-to-r from-amber-400 to-red-500"
                    : ctxPct >= 60
                      ? "bg-gradient-to-r from-emerald-400 to-amber-400"
                      : "bg-gradient-to-r from-cyan-400 to-emerald-400",
                )}
                style={{ width: `${ctxPct}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-white/45">
              {formatTokens(session.totalTokens)} dari{" "}
              {formatTokens(session.contextTokens)} token
            </p>
          </div>
        ) : null}
      </Section>

      {model ? (
        <Section icon={Bot} title={i.drawerSectionModel}>
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl border border-indigo-400/30 bg-indigo-400/10">
              <Cpu className="size-5 text-indigo-300" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="font-mono text-sm font-semibold text-white">{model}</div>
              {providerBadge ? (
                <div className="text-[11px] text-white/55">{providerBadge}</div>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      {/* Origin / scope — only surface (channel format like "telegram:bot:123").
       *  subject/room/space/elevatedLevel removed (Hermes engine doesn't track them). */}
      {session.surface ? (
        <Section icon={MapPin} title="Asal Sesi">
          <ScopeRows session={session} />
        </Section>
      ) : null}
    </>
  );
}

function ScopeRows({ session }: { session: SessionSummary }) {
  const surfaceHuman = session.surface ? humanSurfaceName(session.surface) : null;
  const surfaceChannel = session.surface ? humanChannel(session.surface.split(":")[0]) : null;
  return (
    <dl className="space-y-1.5 text-[12px]">
      {session.surface ? (
        <MetaRow
          label="Channel"
          value={
            surfaceChannel && surfaceChannel !== "—"
              ? `${surfaceChannel}${surfaceHuman && surfaceHuman !== surfaceChannel ? ` · ${surfaceHuman}` : ""}`
              : session.surface
          }
        />
      ) : null}
    </dl>
  );
}

/* ─── Advanced tab — WIRED behavior settings + reset + compact + delete ─── */
function AdvancedTab({
  session,
  onDelete,
  onActionToast,
  i,
}: {
  session: SessionSummary;
  onDelete: () => void;
  onActionToast: (kind: "success" | "error", text: string) => void;
  i: ReturnType<typeof useI18n>["t"]["app"]["sessions"];
}) {
  const { patch, reset, compact, busyAction } = useSessionActions();
  const [confirmReset, setConfirmReset] = useState(false);

  // Local state for behavior settings (editable selectors)
  // PERILAKU AI settings are AGENT-WIDE in Hermes (persisted di
  // ~/.hermes/config.yaml via slash commands /reasoning, /fast, /verbose).
  // Bridge surface current values di sessions.list response, jadi
  // dropdown selalu show actual engine state. localStorage extra layer
  // (defensive — fallback kalau bridge timeout atau gak send field).
  const lsKey = `agentbuff:app:session-behavior:${session.key}`;
  const readLocal = (): {
    thinking: string;
    fastMode: "" | "on" | "off";
    verbose: string;
    reasoning: string;
  } | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(lsKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || !parsed) return null;
      return {
        thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
        fastMode:
          parsed.fastMode === "on" || parsed.fastMode === "off"
            ? parsed.fastMode
            : "",
        verbose: typeof parsed.verbose === "string" ? parsed.verbose : "",
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    } catch {
      return null;
    }
  };

  const initial = readLocal();
  const [thinking, setThinking] = useState<string>(
    initial?.thinking ?? session.thinkingLevel ?? "",
  );
  const [fastMode, setFastMode] = useState<"" | "on" | "off">(
    initial?.fastMode ??
      (session.fastMode === true ? "on" : session.fastMode === false ? "off" : ""),
  );
  const [verbose, setVerbose] = useState<string>(
    initial?.verbose ?? session.verboseLevel ?? "",
  );
  const [reasoning, setReasoning] = useState<string>(
    initial?.reasoning ?? session.reasoningLevel ?? "",
  );

  // Last-saved snapshot for dirty-tracking. Updated after successful save.
  const [savedSnapshot, setSavedSnapshot] = useState({
    thinking: initial?.thinking ?? session.thinkingLevel ?? "",
    fastMode:
      initial?.fastMode ??
      (session.fastMode === true ? "on" : session.fastMode === false ? "off" : ""),
    verbose: initial?.verbose ?? session.verboseLevel ?? "",
    reasoning: initial?.reasoning ?? session.reasoningLevel ?? "",
  });

  // Re-hydrate from localStorage when session changes
  useEffect(() => {
    const fresh = readLocal();
    const t = fresh?.thinking ?? session.thinkingLevel ?? "";
    const f = (fresh?.fastMode ??
      (session.fastMode === true
        ? "on"
        : session.fastMode === false
          ? "off"
          : "")) as "" | "on" | "off";
    const v = fresh?.verbose ?? session.verboseLevel ?? "";
    const r = fresh?.reasoning ?? session.reasoningLevel ?? "";
    setThinking(t);
    setFastMode(f);
    setVerbose(v);
    setReasoning(r);
    setSavedSnapshot({ thinking: t, fastMode: f, verbose: v, reasoning: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  const dirty =
    thinking !== savedSnapshot.thinking ||
    fastMode !== savedSnapshot.fastMode ||
    verbose !== savedSnapshot.verbose ||
    reasoning !== savedSnapshot.reasoning;

  const handleSaveBehavior = async () => {
    const result = await patch(session.key, {
      thinkingLevel: thinking || null,
      fastMode: fastMode === "on" ? true : fastMode === "off" ? false : null,
      verboseLevel: verbose || null,
      reasoningLevel: reasoning || null,
    });
    if (result.ok) {
      // Persist to localStorage so dropdowns remember choice on reopen
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            lsKey,
            JSON.stringify({ thinking, fastMode, verbose, reasoning }),
          );
        }
      } catch {
        // localStorage quota / disabled — silent; functional save already done
      }
      setSavedSnapshot({ thinking, fastMode, verbose, reasoning });
      onActionToast("success", i.behaviorSaveSuccess);
    } else {
      onActionToast("error", `${i.behaviorSaveFailed}: ${result.error}`);
    }
  };

  const handleReset = async () => {
    const result = await reset(session.key, "reset");
    setConfirmReset(false);
    if (result.ok) {
      onActionToast("success", i.actionResetSuccess);
    } else {
      onActionToast("error", `${i.actionResetFailed}: ${result.error}`);
    }
  };

  const handleCompact = async () => {
    const result = await compact(session.key);
    if (result.ok) {
      onActionToast("success", i.actionCompactSuccess);
    } else {
      onActionToast("error", `${i.actionCompactFailed}: ${result.error}`);
    }
  };

  return (
    <>
      {/* Behavior settings — NOW EDITABLE */}
      <Section icon={Zap} title={i.drawerSectionBehavior}>
        <div className="space-y-3">
          <BehaviorSelect
            label={i.behaviorThinking}
            hint={i.behaviorThinkingHint}
            value={thinking}
            onChange={setThinking}
            options={[
              { value: "", label: "Default (ikutin agen)" },
              { value: "off", label: "Mati" },
              { value: "minimal", label: "Minimal" },
              { value: "low", label: "Rendah" },
              { value: "medium", label: "Sedang" },
              { value: "high", label: "Tinggi" },
              { value: "xhigh", label: "Sangat Tinggi" },
            ]}
          />
          <BehaviorSelect
            label={i.behaviorFastMode}
            hint={i.behaviorFastModeHint}
            value={fastMode}
            onChange={(v) => setFastMode(v as "" | "on" | "off")}
            options={[
              { value: "", label: "Default (ikutin agen)" },
              { value: "on", label: "Aktif" },
              { value: "off", label: "Mati" },
            ]}
          />
          <BehaviorSelect
            label={i.behaviorVerbose}
            hint={i.behaviorVerboseHint}
            value={verbose}
            onChange={setVerbose}
            options={[
              { value: "", label: "Default (ikutin agen)" },
              { value: "off", label: "Mati (explicit)" },
              { value: "on", label: "Aktif" },
              { value: "full", label: "Full" },
            ]}
          />
          <BehaviorSelect
            label={i.behaviorReasoning}
            hint={i.behaviorReasoningHint}
            value={reasoning}
            onChange={setReasoning}
            options={[
              { value: "", label: "Default (ikutin agen)" },
              { value: "off", label: "Mati" },
              { value: "on", label: "Aktif" },
              { value: "stream", label: "Stream" },
            ]}
          />
        </div>
        {dirty ? (
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                // Revert unsaved edits to last-saved snapshot (NOT session
                // row, since session row never carries these fields).
                setThinking(savedSnapshot.thinking);
                setFastMode(savedSnapshot.fastMode);
                setVerbose(savedSnapshot.verbose);
                setReasoning(savedSnapshot.reasoning);
              }}
              className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/70 hover:text-white"
            >
              Reset perubahan
            </button>
            <button
              type="button"
              onClick={() => void handleSaveBehavior()}
              disabled={busyAction === "patch"}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3 py-1.5 text-[11px] font-bold text-[#0B0E14] hover:brightness-110 disabled:opacity-50"
            >
              {busyAction === "patch" ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <Check className="size-3" aria-hidden />
              )}
              {i.behaviorSave}
            </button>
          </div>
        ) : null}
      </Section>

      {/* Actions — Reset + Compact + Delete */}
      <Section icon={RotateCcw} title={i.drawerSectionActions}>
        <div className="space-y-2">
          {/* Compact */}
          <ActionRow
            icon={Sparkles}
            tone="indigo"
            label={i.actionCompact}
            hint={i.actionCompactHint}
            busy={busyAction === "compact"}
            onClick={() => void handleCompact()}
          />

          {/* Reset (with 2-click confirm) */}
          {confirmReset ? (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-4 py-3">
              <p className="mb-2 text-[12px] text-amber-100">
                {i.actionResetConfirm}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleReset()}
                  disabled={busyAction === "reset"}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-3 py-1.5 text-[11px] font-bold text-[#0B0E14] hover:brightness-110 disabled:opacity-50"
                >
                  {busyAction === "reset" ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : (
                    <Check className="size-3" aria-hidden />
                  )}
                  Ya, reset
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="rounded-md border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/70 hover:text-white"
                >
                  Batal
                </button>
              </div>
            </div>
          ) : (
            <ActionRow
              icon={RotateCcw}
              tone="amber"
              label={i.actionReset}
              busy={false}
              onClick={() => setConfirmReset(true)}
            />
          )}

          {/* Delete */}
          <ActionRow
            icon={Trash2}
            tone="red"
            label={i.delete}
            busy={false}
            onClick={onDelete}
          />
        </div>
      </Section>

      {/* Meta — semua engine identifiers + child sessions list */}
      <Section icon={ChevronRight} title={i.drawerSectionMeta}>
        <dl className="space-y-1.5 text-[12px]">
          <MetaRow label="Session key" value={session.key} mono />
          {session.sessionId && session.sessionId !== session.key ? (
            <MetaRow label="Session ID" value={session.sessionId} mono />
          ) : null}
          <MetaRow label="Kind" value={session.kind} mono />
          {/* Current behavior settings (read-only summary) */}
          <MetaRow
            label="Thinking"
            value={thinkingLevelLabel(session.thinkingLevel)}
          />
        </dl>
        {session.childSessions?.length ? (
          <div className="mt-3 border-t border-white/[0.06] pt-3">
            <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              <Fingerprint className="size-3 text-fuchsia-300/85" aria-hidden />
              Subagent ({session.childSessions.length})
            </div>
            <ul className="space-y-1">
              {session.childSessions.slice(0, 6).map((child) => (
                <li
                  key={child}
                  className="truncate rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 font-mono text-[10px] text-white/70"
                >
                  {child}
                </li>
              ))}
              {session.childSessions.length > 6 ? (
                <li className="text-[10px] text-white/45">
                  + {session.childSessions.length - 6} subagent lainnya
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </Section>
    </>
  );
}

function BehaviorSelect({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label className="text-[12px] font-medium text-white/85">
            {label}
          </label>
          {hint ? (
            <p className="mt-0.5 text-[10px] leading-snug text-white/45">{hint}</p>
          ) : null}
        </div>
        <select
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          className="shrink-0 rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-[11px] text-white/85 focus:border-cyan-400/50 focus:outline-none"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-[#0B0E14]">
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  tone,
  label,
  hint,
  busy,
  onClick,
}: {
  icon: typeof Sparkles;
  tone: "indigo" | "amber" | "red";
  label: string;
  hint?: string;
  busy: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "indigo"
      ? "border-indigo-400/30 bg-indigo-400/10 text-indigo-100 hover:bg-indigo-400/15"
      : tone === "amber"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
        : "border-red-500/30 bg-red-500/10 text-red-100 hover:bg-red-500/15";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition disabled:opacity-50",
        toneClass,
      )}
    >
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Icon className="size-4 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-[10px] opacity-75">{hint}</div>
        ) : null}
      </div>
    </button>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Activity;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">
        <Icon className="size-3.5 text-cyan-300/85" aria-hidden />
        {title}
      </h3>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        {children}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: "cyan" | "fuchsia" | "amber" | "emerald";
}) {
  const valueClass = highlight
    ? highlight === "cyan"
      ? "text-cyan-100"
      : highlight === "fuchsia"
        ? "text-fuchsia-100"
        : highlight === "amber"
          ? "text-amber-100"
          : "text-emerald-100"
    : "text-white/90";
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-semibold", valueClass, mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 flex-1 break-words text-white/85",
          mono && "font-mono text-[11px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
