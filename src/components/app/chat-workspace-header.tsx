"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Download, Search, X, Zap } from "lucide-react";
import { useAppStore, type ChatMessage } from "@/lib/app/store";
import { SessionSourceBadge } from "@/components/app/chat-source-badge";

// Stable empty-array reference so useAppStore selectors that fall back to
// `[]` when the active session has no messages don't return a fresh array
// every render (which would trigger the Zustand subscriber to mark the
// value as changed, causing an infinite render loop).
const EMPTY_MESSAGES: ChatMessage[] = [];
import {
  copyMarkdownToClipboard,
  downloadBlob,
  exportSessionAsJson,
  exportSessionAsMarkdown,
  makeExportFilename,
} from "@/lib/app/export";
import { useAgentsList } from "./agents/use-agents-data";
import { getAgentDisplayName } from "./agents/helpers";
import { useActiveAgentProfile } from "./agents/agent-profile";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// Mirrors /basecamp workspace header (workspace.tsx lines 141–193):
// agent avatar with gradient halo · "Routed ke @Buff" eyebrow · role or
// session title · Standby/Executing status pill on the right. No back arrow:
// /app uses a persistent-session model with sidebar-driven navigation, so
// "close workspace" semantics don't apply. Data-source is the real store —
// status derives from streaming/sending flags, role text derives from the
// active session title.
//
// Single-agent /app model: there's no routing to N agents like /basecamp.
// We show the AgentBuff house persona "Buff" with the i18n default role
// fallback — overridden per-session when the user labels it.

const BUFF = {
  name: "Buff",
  color: "from-cyan-400 to-fuchsia-500",
} as const;

// Deterministic per-agent avatar gradient. useGatewayAgents only exposes
// {id, name}, so we pick a stable gradient from the agent-id hash — every
// agent gets a distinct-but-consistent color without needing theme data.
const AGENT_GRADIENTS: string[] = [
  "from-cyan-400 to-blue-500",
  "from-indigo-400 to-violet-500",
  "from-violet-400 to-purple-500",
  "from-fuchsia-400 to-pink-500",
  "from-rose-400 to-pink-500",
  "from-emerald-400 to-teal-500",
  "from-amber-400 to-orange-500",
  "from-sky-400 to-cyan-500",
];

function gradientForAgent(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_GRADIENTS[h % AGENT_GRADIENTS.length];
}

// Parse the agent id from a canonical session key `agent:<id>:<rest>` (wire
// gotcha G3). Returns "main" for default / empty / unprefixed keys.
function agentIdFromKey(key: string | null | undefined): string {
  if (!key || !key.startsWith("agent:")) return "main";
  return key.split(":")[1] || "main";
}

// Default placeholder titles that should be ignored when displaying.
// "Thread baru" / "New thread" both map to "unlabelled" so we show the
// role instead of the raw placeholder.
const DEFAULT_TITLES = new Set(["Thread baru", "New thread"]);

type ActiveAgent = { id: string; name: string; color: string };

// Resolve the agent bound to the CURRENTLY ACTIVE session — parsed from the
// session key, NOT a global picker value. This is what makes the header
// truthful: a kiwi session shows "@Kiwi", a default session shows "@Buff".
// Display name comes from the live agents.list (useGatewayAgents -> {id,name}).
function useActiveAgent(): ActiveAgent {
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const { data } = useAgentsList();
  const agents = data?.agents;
  return useMemo(() => {
    const id = agentIdFromKey(activeKey);
    if (id === "main" || id === "default") {
      return { id: "main", name: BUFF.name, color: BUFF.color };
    }
    const found = (agents ?? []).find((a) => a.id === id);
    return {
      id,
      name: found ? getAgentDisplayName(found) : id,
      color: gradientForAgent(id),
    };
  }, [activeKey, agents]);
}

export function ChatWorkspaceHeader() {
  const { t } = useI18n();
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const streaming = useAppStore(
    (s) => Boolean(s.streaming[s.activeSessionKey]),
  );
  const sending = useAppStore(
    (s) => s.sending[s.activeSessionKey] ?? false,
  );
  const sessions = useAppStore((s) => s.sessions);

  const activeSession = sessions.find((row) => row.key === activeKey);
  const executing = streaming || sending;
  const agent = useActiveAgent();

  const label =
    activeSession?.title && !DEFAULT_TITLES.has(activeSession.title)
      ? activeSession.title
      : t.app.chat.header.defaultRole;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <AgentAvatar />
        <div className="min-w-0">
          {/* Use <div> here, not <p> — AgentPicker renders a <div> dropdown
              which is invalid HTML inside <p> (block in inline). */}
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-white/45">
            <span>{t.app.chat.header.routedTo}</span>
            <AgentPicker current={agent} />
          </div>
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-white/90">
              {label}
            </p>
            <SessionSourceBadge
              source={activeSession?.source}
              peerLabel={activeSession?.peerLabel}
              showLock
              showPeer
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <UsageBadge />
        <FastModeToggle />
        <ChatSearchControl />
        <ExportMenu sessionTitle={label} />
        <StatusPill executing={executing} />
      </div>
    </div>
  );
}

/** Usage badge — surfaces the LATEST assistant message's `meta` (token
 *  counts + cost) in the chat header. Hermes Desktop parity from
 *  ChatHeader.tsx:23-37.
 *
 *  We pull "last turn" semantics (not cumulative across the whole session)
 *  because chief's expectation is "berapa cost balasan terakhir" rather
 *  than "total selama account aktif" (which would grow huge + meaningless).
 *
 *  Hidden on small viewports (< md) to avoid header overflow on mobile.
 *  Hidden entirely when no tokens recorded yet. */
function UsageBadge() {
  const lastMeta = useAppStore((s) => {
    const list = s.messages[s.activeSessionKey];
    if (!list || list.length === 0) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "assistant" && m.kind !== "tool" && m.meta) return m.meta;
    }
    return null;
  });
  if (!lastMeta) return null;
  const inputTokens = lastMeta.input ?? 0;
  const outputTokens = lastMeta.output ?? 0;
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) return null;
  const cost = lastMeta.cost ?? 0;
  const costStr = cost > 0 ? `$${cost.toFixed(4)}` : "";
  const formatted = totalTokens.toLocaleString("id-ID");
  return (
    <div
      className="hidden items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65 md:inline-flex"
      title={`Input: ${inputTokens.toLocaleString("id-ID")} · Output: ${outputTokens.toLocaleString("id-ID")}${costStr ? ` · Biaya: ${costStr}` : ""}`}
    >
      <span>{formatted} tok</span>
      {costStr ? (
        <>
          <span className="text-white/25">·</span>
          <span>{costStr}</span>
        </>
      ) : null}
    </div>
  );
}

/** Fast Mode (⚡) toggle — Hermes Desktop parity from ChatHeader.tsx:101-116.
 *
 *  Writes `agent.service_tier: "fast" | ""` to `config.yaml` via the
 *  bridge's `config.patch` RPC (RFC 7396 merge-patch). Hermes reads this
 *  at run-time when building chat completion requests (api_server passes
 *  it to provider as `service_tier` param). "fast"/"priority" = paid
 *  priority routing on supported providers (Anthropic Claude, OpenAI),
 *  empty = standard.
 *
 *  Per-session UI state lives in localStorage (`agentbuff:app:fast-mode`)
 *  so the toggle position persists across refresh + session switch. The
 *  actual config write happens on every toggle, so even if localStorage
 *  drifts (e.g. another device toggled it via API), the next mutation
 *  brings both layers back in sync. */
const FAST_MODE_STORAGE_KEY = "agentbuff:app:fast-mode";
function FastModeToggle() {
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const patchSession = useAppStore((s) => s.patchSession);
  const [fastMode, setFastMode] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(FAST_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(async () => {
    if (pending) return;
    const next = !fastMode;
    setFastMode(next); // optimistic
    try {
      window.localStorage.setItem(FAST_MODE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* quota — best-effort */
    }
    setPending(true);
    try {
      await patchSession(activeKey, { serviceTier: next ? "fast" : "" });
    } catch {
      // Revert on failure — keep UI in sync with bridge truth.
      setFastMode(!next);
      try {
        window.localStorage.setItem(FAST_MODE_STORAGE_KEY, next ? "0" : "1");
      } catch {
        /* ignore */
      }
    } finally {
      setPending(false);
    }
  }, [pending, fastMode, patchSession, activeKey]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={pending}
      aria-pressed={fastMode}
      aria-label={fastMode ? "Mode cepat aktif" : "Mode cepat (mati)"}
      title={
        fastMode
          ? "Mode Cepat: AKTIF — provider akan prioritas (paid tier)"
          : "Mode Cepat: MATI — diproses normal. Klik untuk aktifkan."
      }
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border transition",
        fastMode
          ? "border-amber-400/55 bg-amber-400/15 text-amber-200 shadow-[0_0_10px_rgba(252,211,77,0.35)]"
          : "border-white/10 bg-white/[0.03] text-white/55 hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-200",
        pending && "cursor-wait opacity-70",
      )}
    >
      <Zap className={cn("size-3.5", fastMode && "fill-current")} />
    </button>
  );
}

/** H5 — Export menu. Two formats (markdown + JSON). Uses the currently-
 *  rendered active session's messages from the store. */
function ExportMenu({ sessionTitle }: { sessionTitle: string }) {
  const { t } = useI18n();
  const messages = useAppStore(
    (s) => s.messages[s.activeSessionKey] ?? EMPTY_MESSAGES,
  );
  const [open, setOpen] = useState(false);
  // B6 — Track the copy-to-clipboard result so the menu item shows a
  // "Tersalin" confirmation pill for 1.5s after success.
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Auto-reset the copy state pill back to idle after a short tick so the
  // user sees the confirmation but the menu doesn't lock visually.
  useEffect(() => {
    if (copyState === "idle") return;
    const id = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(id);
  }, [copyState]);

  const handleExport = useCallback(
    (format: "md" | "json") => {
      const exportable = messages.filter((m) => m.role !== "system");
      if (exportable.length === 0) {
        setOpen(false);
        return;
      }
      const blob =
        format === "md"
          ? exportSessionAsMarkdown(exportable, sessionTitle)
          : exportSessionAsJson(exportable, sessionTitle);
      downloadBlob(blob, makeExportFilename(sessionTitle, format));
      setOpen(false);
    },
    [messages, sessionTitle],
  );

  const handleCopyMd = useCallback(async () => {
    const exportable = messages.filter((m) => m.role !== "system");
    if (exportable.length === 0) {
      setOpen(false);
      return;
    }
    const ok = await copyMarkdownToClipboard(exportable, sessionTitle);
    setCopyState(ok ? "ok" : "fail");
    if (ok) {
      // Close after a short tick so the user can see the confirmation flash.
      window.setTimeout(() => setOpen(false), 900);
    }
  }, [messages, sessionTitle]);

  const empty = messages.filter((m) => m.role !== "system").length === 0;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t.app.chat.header.exportLabel}
        aria-expanded={open}
        title={t.app.chat.header.exportLabel}
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
      >
        <Download className="size-3.5" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t.app.chat.header.exportLabel}
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
        >
          <div className="border-b border-white/[0.06] px-3 py-2">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/45">
              {t.app.chat.header.exportLabel}
            </p>
          </div>
          {empty ? (
            <p className="px-3 py-3 text-[10.5px] leading-snug text-white/40">
              {t.app.chat.header.exportEmpty}
            </p>
          ) : (
            <ul className="p-1">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyMd()}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-xs transition",
                    copyState === "ok"
                      ? "bg-emerald-400/10 text-emerald-200"
                      : copyState === "fail"
                        ? "bg-red-500/10 text-red-200"
                        : "text-white/70 hover:bg-cyan-400/10 hover:text-cyan-200",
                  )}
                >
                  <span>
                    {copyState === "ok"
                      ? t.app.chat.header.exportCopyCopied
                      : copyState === "fail"
                        ? t.app.chat.header.exportCopyFailed
                        : t.app.chat.header.exportCopyMarkdown}
                  </span>
                  {copyState === "ok" ? (
                    <Check className="size-3.5 shrink-0" aria-hidden />
                  ) : null}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleExport("md")}
                  className="w-full rounded-md px-3 py-2 text-left text-xs text-white/70 transition hover:bg-cyan-400/10 hover:text-cyan-200"
                >
                  {t.app.chat.header.exportMarkdown}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleExport("json")}
                  className="w-full rounded-md px-3 py-2 text-left text-xs text-white/70 transition hover:bg-cyan-400/10 hover:text-cyan-200"
                >
                  {t.app.chat.header.exportJson}
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** H3 — Inline search control with WhatsApp/Telegram-style navigation.
 *
 *  UX (matches Telegram + WhatsApp message-find muscle memory):
 *    1. Click search icon → input expands.
 *    2. Type query → matches highlight via `<mark>`, count chip shows
 *       "current / total" (e.g. "3 / 12").
 *    3. Click ↑ or ↓ (or press Enter / Shift+Enter) → jumps to next /
 *       previous match. The transcript auto-scrolls so the matched
 *       bubble is centered in view + flashes a brief cyan ring.
 *    4. Esc closes the input + clears the query.
 *
 *  Match semantics: per-MESSAGE (not per-occurrence). One bubble with
 *  3 instances of the query = 1 result. Mirrors how Telegram/WA count
 *  search hits — chief is going to mentally count "5 bubbles match"
 *  not "12 individual 'halo' words". Cleaner UX, also avoids the
 *  complexity of per-occurrence DOM anchoring.
 *
 *  The highlight/dim logic lives in ChatThread; this component owns
 *  the input, count chip, navigation arrows, and the scroll-to-active
 *  side effect.
 */
function ChatSearchControl() {
  const { t } = useI18n();
  const query = useAppStore((s) => s.chatSearchQuery);
  const setQuery = useAppStore((s) => s.setChatSearchQuery);
  const activeIndex = useAppStore((s) => s.chatSearchActiveIndex);
  const setActiveIndex = useAppStore((s) => s.setChatSearchActiveIndex);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const messages = useAppStore(
    (s) => s.messages[s.activeSessionKey] ?? EMPTY_MESSAGES,
  );

  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset when switching sessions so the prior thread's filter doesn't
  // leak into the new one.
  useEffect(() => {
    setQuery("");
    setOpen(false);
  }, [activeKey, setQuery]);

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // A2 — Ctrl/Cmd+F opens the search input. Mirrors the browser's
  // "find in page" muscle memory but scoped to the chat.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || e.key.toLowerCase() !== "f") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Compute the ORDERED list of message ids that contain the query.
  // Per-MESSAGE matching (one bubble = one result). Tool bubbles are
  // skipped because they're dev-noise — `kind === "tool"` rows hold
  // function-call traces, not user-facing prose.
  const q = query.trim().toLowerCase();
  const matchedMessageIds = useMemo<string[]>(() => {
    if (!q) return [];
    const out: string[] = [];
    for (const m of messages) {
      if (m.kind === "tool") continue;
      const text = (m.content || "").toLowerCase();
      if (text.includes(q)) out.push(m.id);
    }
    return out;
  }, [q, messages]);
  const total = matchedMessageIds.length;
  // Clamp activeIndex into bounds whenever the match list changes (typing
  // shrinks/grows results).
  useEffect(() => {
    if (total === 0) {
      if (activeIndex !== -1) setActiveIndex(-1);
      return;
    }
    if (activeIndex < 0 || activeIndex >= total) {
      setActiveIndex(0);
    }
  }, [total, activeIndex, setActiveIndex]);

  // Scroll-to-active effect. Whenever `activeIndex` moves to a valid
  // match, find the corresponding DOM node via `[data-message-id]` and
  // scroll it into view (centered) with a brief cyan ring flash. The
  // ChatThread renders each bubble's wrapper with `data-message-id`
  // attribute already (used by the legacy reply-chip jump), so we just
  // re-use that anchor here.
  useEffect(() => {
    if (activeIndex < 0 || activeIndex >= matchedMessageIds.length) return;
    const targetId = matchedMessageIds[activeIndex];
    if (!targetId) return;
    // Defer one frame so React commits the dim/highlight before we
    // measure scroll position — avoids landing on the wrong vertical
    // anchor when the DOM is mid-paint.
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(targetId)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(
        "ring-2",
        "ring-cyan-400/70",
        "ring-offset-2",
        "ring-offset-[#0B0E14]",
        "rounded-2xl",
      );
      window.setTimeout(() => {
        el.classList.remove(
          "ring-2",
          "ring-cyan-400/70",
          "ring-offset-2",
          "ring-offset-[#0B0E14]",
          "rounded-2xl",
        );
      }, 1600);
    });
    return () => cancelAnimationFrame(raf);
  }, [activeIndex, matchedMessageIds]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, [setQuery]);

  const stepActive = useCallback(
    (delta: 1 | -1) => {
      if (total === 0) return;
      const next = (activeIndex + delta + total) % total;
      setActiveIndex(next);
    },
    [activeIndex, total, setActiveIndex],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      // Enter = next, Shift+Enter = previous. Matches browser Find +
      // Telegram/WA. Wrap-around via stepActive's modulo.
      if (e.key === "Enter") {
        e.preventDefault();
        stepActive(e.shiftKey ? -1 : 1);
      }
    },
    [handleClose, stepActive],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.app.chat.header.searchOpenLabel}
        title={t.app.chat.header.searchOpenLabel}
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
      >
        <Search className="size-3.5" />
      </button>
    );
  }

  const hasMatches = total > 0;
  const navDisabled = !hasMatches;
  // 1-based display for humans, even though storage is 0-based.
  const displayActive = hasMatches ? activeIndex + 1 : 0;

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-[#0B0E14]/80 px-2 py-1 shadow-[0_0_12px_rgba(34,211,238,0.25)]">
      <Search className="size-3.5 shrink-0 text-cyan-300/70" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKey}
        placeholder={t.app.chat.header.searchPlaceholder}
        aria-label={t.app.chat.header.searchAriaLabel}
        className="w-44 bg-transparent text-xs text-white outline-none placeholder:text-white/30"
      />
      {q ? (
        <>
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em]",
              hasMatches
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/10 bg-white/[0.04] text-white/45",
            )}
          >
            {hasMatches
              ? `${displayActive} / ${total}`
              : t.app.chat.header.searchNoMatch}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => stepActive(-1)}
              disabled={navDisabled}
              aria-label="Hasil sebelumnya"
              title="Hasil sebelumnya (Shift+Enter)"
              className={cn(
                "flex size-5 items-center justify-center rounded-full transition",
                navDisabled
                  ? "cursor-not-allowed text-white/25"
                  : "text-white/65 hover:bg-cyan-400/15 hover:text-cyan-200",
              )}
            >
              <ChevronUp className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => stepActive(1)}
              disabled={navDisabled}
              aria-label="Hasil berikutnya"
              title="Hasil berikutnya (Enter)"
              className={cn(
                "flex size-5 items-center justify-center rounded-full transition",
                navDisabled
                  ? "cursor-not-allowed text-white/25"
                  : "text-white/65 hover:bg-cyan-400/15 hover:text-cyan-200",
              )}
            >
              <ChevronDown className="size-3" />
            </button>
          </div>
        </>
      ) : null}
      <button
        type="button"
        onClick={handleClose}
        aria-label={t.app.chat.header.searchCloseLabel}
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** H4 — Agent picker. The trigger shows the CURRENT session's agent (truthful:
 *  a kiwi session reads "@Kiwi", not the house default). Picking a DIFFERENT
 *  agent opens a brand-new thread bound to that agent — matching the channel
 *  mental model the chief asked for ("pilih dropdown -> sesi baru sama agen
 *  itu"). Existing sessions keep their agent because Hermes routes off the
 *  session key, never a mutable header value. */
function AgentPicker({ current }: { current: ActiveAgent }) {
  const { t } = useI18n();
  const createSession = useAppStore((s) => s.createSession);
  const { data, loading: isLoading } = useAgentsList();
  const agents = data?.agents;
  const defaultId = data?.defaultId ?? "default";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Build list: always include "main" as the default agent. Server-side
  // agents.list may or may not echo the implicit main row.
  const list = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    out.push({ id: "main", name: "Buff" });
    seen.add("main");
    (agents ?? []).forEach((a) => {
      // Skip the default agent — it's already shown as "Buff" above. Every
      // other (specialist) agent gets its own row.
      if (!a?.id || seen.has(a.id) || a.id === defaultId || a.default) return;
      out.push({ id: a.id, name: getAgentDisplayName(a) });
      seen.add(a.id);
    });
    return out;
  }, [agents, defaultId]);

  const selected = { id: current.id, name: current.name };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t.app.chat.header.agentPickerLabel}
        aria-expanded={open}
        title={t.app.chat.header.agentPickerHelp}
        className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5 font-mono text-cyan-300/85 transition hover:border-cyan-400/30 hover:bg-cyan-400/5 hover:text-cyan-200"
      >
        <span>@{selected.name}</span>
        <ChevronDown
          className={cn(
            "size-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={t.app.chat.header.agentPickerLabel}
          className="absolute left-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14]/95 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
        >
          <div className="border-b border-white/[0.06] px-3 py-2">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/45">
              {t.app.chat.header.agentPickerLabel}
            </p>
            <p className="mt-0.5 text-[10.5px] leading-snug text-white/40">
              {t.app.chat.header.agentPickerHelp}
            </p>
          </div>
          <ul className="max-h-72 overflow-y-auto p-1">
            {isLoading ? (
              <li className="px-3 py-2 text-[11px] text-white/40">
                {t.app.chat.header.agentPickerLoading}
              </li>
            ) : list.length === 1 ? (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs text-white"
                >
                  <span>@Buff</span>
                  <Check className="size-3 text-cyan-300" />
                </button>
                <p className="px-3 pb-2 text-[10px] text-white/35">
                  {t.app.chat.header.agentPickerEmpty}
                </p>
              </li>
            ) : (
              list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={a.id === current.id}
                    onClick={() => {
                      setOpen(false);
                      if (a.id === current.id) return;
                      // Switching agent = open a fresh thread bound to it.
                      // createSession gets the explicit id; we do NOT mutate the
                      // global defaultAgentId (that leaked into Ctrl+K / fresh
                      // Command Center → silent wrong-agent, fixed 2026-05-30).
                      void createSession(undefined, a.id);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition",
                      a.id === current.id
                        ? "bg-cyan-400/10 text-cyan-100"
                        : "text-white/70 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <span className="truncate">@{a.name}</span>
                    {a.id === current.id ? (
                      <Check className="size-3 text-cyan-300" />
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function AgentAvatar() {
  // Real per-session agent identity (emoji + theme gradient), shared with the
  // thread avatars and the "Tim Aktif" panel so the persona looks identical
  // everywhere.
  const profile = useActiveAgentProfile();
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full bg-gradient-to-br opacity-70 blur-md",
          profile.gradient,
        )}
      />
      <div
        className={cn(
          "relative flex size-9 items-center justify-center overflow-hidden rounded-full border border-white/10 font-display text-sm font-bold text-[#0B0E14]",
          profile.avatarUrl ? "bg-[#0B0E14]" : "bg-gradient-to-br " + profile.gradient,
        )}
      >
        {profile.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatarUrl}
            alt={profile.name}
            className="size-full object-cover"
          />
        ) : profile.emoji ? (
          <span className="text-base leading-none">{profile.emoji}</span>
        ) : (
          (profile.name[0]?.toUpperCase() ?? "B")
        )}
      </div>
    </div>
  );
}

function StatusPill({ executing }: { executing: boolean }) {
  // Wave 6-4J — bot presence pill. Derived from session state +
  // explicit store flag. Mood maps to color + label.
  const sending = useAppStore(
    (s) => Boolean(s.sending[s.activeSessionKey]),
  );
  const streaming = useAppStore(
    (s) => Boolean(s.streaming[s.activeSessionKey]),
  );
  const presence: "online" | "thinking" | "typing" | "working" =
    streaming ? "typing" : sending ? "working" : executing ? "thinking" : "online";
  const presenceMeta: Record<
    "online" | "thinking" | "typing" | "working",
    { label: string; border: string; bg: string; text: string; dot: string }
  > = {
    online: {
      label: "Online",
      border: "border-emerald-400/30",
      bg: "bg-emerald-400/10",
      text: "text-emerald-200",
      dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]",
    },
    thinking: {
      label: "Mikir",
      border: "border-fuchsia-400/40",
      bg: "bg-fuchsia-500/10",
      text: "text-fuchsia-200",
      dot: "bg-fuchsia-400 shadow-[0_0_8px_rgba(217,70,239,0.8)] animate-pulse",
    },
    typing: {
      label: "Ngetik...",
      border: "border-cyan-400/40",
      bg: "bg-cyan-400/10",
      text: "text-cyan-200",
      dot: "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)] animate-pulse",
    },
    working: {
      label: "Lagi kerja",
      border: "border-amber-400/40",
      bg: "bg-amber-400/10",
      text: "text-amber-200",
      dot: "bg-amber-400 shadow-[0_0_8px_rgba(252,211,77,0.8)] animate-pulse",
    },
  };
  const meta = presenceMeta[presence];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium",
        meta.border,
        meta.bg,
        meta.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}
