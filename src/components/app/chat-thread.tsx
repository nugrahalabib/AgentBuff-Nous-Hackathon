"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  Copy,
  EyeOff,
  Pencil,
  Reply,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
  Volume2,
} from "lucide-react";
import { useAppStore, type ChatMessage } from "@/lib/app/store";
import {
  MessageReactions,
  ReactionPicker,
} from "./message-reactions";
import type { ContentBlock, ThinkingBlock } from "@/lib/hermes/rpc-types";
import {
  blocksToText,
  filterHeartbeatPairs,
  formatClockTime,
  formatDayDivider,
  localDayKey,
} from "@/lib/app/session-utils";
import {
  NOTE_MAX,
  deleteAnnotation,
  getAnnotation,
  setAnnotation,
  subscribeAnnotations,
  type Annotation,
} from "@/lib/app/annotations";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { MessageMarkdown } from "./message-markdown";
import { MessageBlocks } from "./message-blocks";
import { MessageMeta } from "./message-meta";
import { ErrorBanner } from "./error-banner";
import {
  ActionIcon,
  BubbleActions,
  MoreMenu,
  MoreMenuItem,
} from "./message-actions";
import { MessageAttachments } from "./message-attachments";
import { MediaSummaryList } from "./media-summary-card";
import {
  AgentProfileProvider,
  useActiveAgentProfile,
  useAgentProfile,
} from "./agents/agent-profile";

// Turn-grouped chat thread — consecutive agent-side messages share ONE
// persona header + a vertical left rail, mirroring openclaw ui-agentbuff's
// grouped-render idiom where tool activity and the reply bubble live under
// a single avatar. Mass-market UX win: tool trace no longer looks like
// "system events ngambang" between chat bubbles.
//
// Grouping rules:
//   · system message     → DROPPED (gateway chatter — restart-sentinel,
//                          dreaming updates, doctor hints — is dev-tool
//                          noise the end user shouldn't see per §2.5)
//   · user chat          → own UserBubble row (right-aligned)
//   · assistant | tool   → append to current agent turn (or start one)
//
// Within an agent turn:
//   · avatar + "Buff · Asisten Pribadi" header render ONCE at top
//   · vertical rail (cyan→white→transparent fade) ties the turn together
//   · sibling rows use gap-1.5 (tight) instead of thread's gap-5 (across-turn)
//   · thinking blocks inside chat messages are HOISTED OUT above the bubble
//     so reasoning reads as trace, not as reply body (parity with openclaw)
//   · Copy action hover-reveals on the last chat bubble — clutter-free at rest
//   · meta footer only on the LAST chat bubble of a turn

/** Approval bar trigger regex — ported verbatim from Hermes Desktop's
 *  MessageRow.tsx:8-9. When an assistant message matches this pattern (and
 *  is the LAST final message), we render inline Approve/Deny buttons so
 *  the user doesn't have to type `/approve` or `/deny` manually.
 *
 *  Matches:
 *    - "⚠️ this is dangerous"
 *    - "requires your approval", "require approval"
 *    - "/approve … /deny" (literal slash-command hint)
 *    - "do you want me to proceed/continue/run/execute"
 *
 *  Tool safety: agent often emits a warning like "⚠️ I'm about to run
 *  `rm -rf /tmp/foo` — do you want me to proceed?" and the inline bar
 *  lets the chief approve in one click instead of typing the command. */
export const APPROVAL_RE =
  /⚠️.*dangerous|requires? (your )?approval|\/approve.*\/deny|do you want (me )?to (proceed|continue|run|execute)/i;

/** Inline Approve/Deny bar rendered below the last assistant bubble when
 *  its content matches APPROVAL_RE. Clicks dispatch `/approve` or `/deny`
 *  as a regular user message — same wire path as if the chief typed it
 *  manually, so no extra RPC routing needed. */
function ApprovalBar() {
  const sendMessage = useAppStore((s) => s.sendMessage);
  const busy = useAppStore(
    (s) =>
      Boolean(s.streaming[s.activeSessionKey]) ||
      Boolean(s.sending[s.activeSessionKey]),
  );
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  const fire = useCallback(
    async (decision: "approve" | "deny") => {
      if (busy || pending) return;
      setPending(decision);
      try {
        await sendMessage(`/${decision}`);
      } finally {
        setPending(null);
      }
    },
    [busy, pending, sendMessage],
  );

  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-2 backdrop-blur-md">
      <span aria-hidden className="text-[14px]">
        ⚠️
      </span>
      <span className="flex-1 text-[12px] text-amber-100/85">
        Menunggu persetujuan kamu untuk lanjut.
      </span>
      <button
        type="button"
        onClick={() => fire("approve")}
        disabled={busy || pending !== null}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-[12px] font-semibold text-emerald-100 transition",
          "hover:border-emerald-500/60 hover:bg-emerald-500/25",
          (busy || pending) &&
            "cursor-not-allowed opacity-60 hover:bg-emerald-500/15",
        )}
      >
        {pending === "approve" ? (
          <span className="size-2 animate-pulse rounded-full bg-emerald-300" />
        ) : (
          <Check className="size-3" />
        )}
        Setujui
      </button>
      <button
        type="button"
        onClick={() => fire("deny")}
        disabled={busy || pending !== null}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-1 text-[12px] font-semibold text-red-100 transition",
          "hover:border-red-500/60 hover:bg-red-500/25",
          (busy || pending) &&
            "cursor-not-allowed opacity-60 hover:bg-red-500/15",
        )}
      >
        {pending === "deny" ? (
          <span className="size-2 animate-pulse rounded-full bg-red-300" />
        ) : (
          <span aria-hidden>✕</span>
        )}
        Tolak
      </button>
    </div>
  );
}

/** WhatsApp / Telegram-style chrono anchor shown INSIDE a chat bubble's
 *  bottom-right corner. Symmetric between inbound + outbound bubbles so the
 *  eye tracks the same spot for "kapan pesan ini dikirim/diterima".
 *
 *  Tone just swaps the muted accent: cyan-ish for the user's own bubble so it
 *  reads against the cyan hairline border, white/40 for the assistant bubble
 *  so it recedes against the translucent white surface. Never takes hover
 *  focus — it's metadata, not an action. */
/** Parse the reply-prefix the composer prepends when the user replied to a
 *  specific message. Returns `{ speaker, quoted, body }` if the message starts
 *  with `**↪ Membalas @<speaker>:**\n> <quoted>\n\n<optional italic agent-hint>\n\n<body>`,
 *  else `null`.
 *
 *  The italic agent-hint line (`_(Catatan untuk Buff: ...)_`) is a prompt-
 *  engineering aid that tells the model how to interpret pronouns; we strip
 *  it from the visual body so the user sees only their original prose.
 *  The model still receives the full text in the chat.send payload — what
 *  this parser does is purely a render concern.
 */
function parseReplyPrefix(
  content: string,
): { speaker: string; quoted: string; body: string } | null {
  if (!content || !content.startsWith("**↪ Membalas @")) return null;
  const newlineIdx = content.indexOf("\n");
  if (newlineIdx < 0) return null;
  const header = content.slice(0, newlineIdx);
  const m = /^\*\*↪ Membalas @(.+?):\*\*$/.exec(header);
  if (!m) return null;
  const speaker = m[1];
  const rest = content.slice(newlineIdx + 1);
  const lines = rest.split(/\r?\n/);
  const quotedLines: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("> ")) {
      quotedLines.push(line.slice(2));
    } else if (line.startsWith(">")) {
      quotedLines.push(line.slice(1));
    } else {
      break;
    }
  }
  if (quotedLines.length === 0) return null;
  // Skip a single blank separator line before the optional agent-hint OR body.
  if (i < lines.length && lines[i].trim() === "") i++;
  // Detect & skip the agent-hint paragraph: a multi-line italic block that
  // starts with "_(Catatan untuk Buff:" and ends with ")_". Single-line or
  // multi-line — collect until the closing `)_`. Then skip one blank line.
  if (
    i < lines.length &&
    lines[i].startsWith("_(Catatan untuk Buff")
  ) {
    while (i < lines.length) {
      const trimmedRight = lines[i].trimEnd();
      i++;
      if (trimmedRight.endsWith(")_")) break;
    }
    if (i < lines.length && lines[i].trim() === "") i++;
  }
  const body = lines.slice(i).join("\n");
  return { speaker, quoted: quotedLines.join("\n"), body };
}

/** Telegram-style reply quote card — rendered above the user's actual reply
 *  text inside the UserBubble. Shows the speaker label + the quoted content
 *  in a left-bordered cyan box. */
function ReplyQuoteCard({
  speaker,
  quoted,
}: {
  speaker: string;
  quoted: string;
}) {
  return (
    <div
      title={quoted}
      className="rounded-md border-l-2 border-cyan-400/60 bg-cyan-400/[0.06] px-2 py-1.5"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
        ↪ Membalas @{speaker}
      </div>
      <p className="line-clamp-4 text-[11.5px] leading-snug text-white/70 whitespace-pre-wrap">
        {quoted}
      </p>
    </div>
  );
}

/** H3 — split a plain-text string at every case-insensitive match of
 *  `query` and wrap each match in <mark>. Returns the original string
 *  untouched when query is empty. Markdown bubbles skip this and rely on
 *  bubble-level dimming instead (highlighting INSIDE markdown would
 *  collide with rehypeHighlight + react-markdown's AST). */
function highlightMatches(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q || !text) return text;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lowerText.indexOf(lowerQ);
  let key = 0;
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      // Amber highlight — matches `processSearchHighlight` in
      // message-markdown.tsx so user bubble (plain text) and assistant
      // bubble (markdown) render IDENTICAL search marks. Chief
      // 2026-05-24: "biar benar benar terlihat dan mata tidak pusing".
      <mark
        key={key++}
        className="rounded-sm bg-amber-300/35 px-0.5 text-amber-50 shadow-[inset_0_-1px_0_rgba(252,211,77,0.55)]"
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
    idx = lowerText.indexOf(lowerQ, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function BubbleTime({
  createdAt,
  tone,
  className,
}: {
  createdAt?: number;
  tone: "user" | "assistant";
  className?: string;
}) {
  const { t } = useI18n();
  const clock = formatClockTime(createdAt);
  if (!clock) return null;
  return (
    <div
      className={cn(
        "mt-1 select-none text-right font-mono text-[10px] leading-none tabular-nums",
        tone === "user" ? "text-cyan-200/55" : "text-white/40",
        className,
      )}
      aria-label={t.app.chat.thread.sentAria.replace("{time}", clock)}
    >
      {clock}
    </div>
  );
}

export function ChatThread() {
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const messages = useAppStore((s) => s.messages[s.activeSessionKey]);
  const streaming = useAppStore(
    (s) => s.streaming[s.activeSessionKey] ?? null,
  );
  const sending = useAppStore((s) => s.sending[s.activeSessionKey] ?? false);
  const loadingHistory = useAppStore(
    (s) => s.loadingHistory[s.activeSessionKey] ?? false,
  );
  const errorMsg = useAppStore((s) => s.errors[s.activeSessionKey] ?? null);
  const clearError = useAppStore((s) => s.clearError);
  // Session context window (tokens) feeds the ctx% chip in MessageMeta.
  // We pick the first matching summary rather than a .find() indirection so
  // the selector stays cheap and referentially stable when sessions[] mutates.
  const contextTokens = useAppStore((s) => {
    const row = s.sessions.find((r) => r.key === s.activeSessionKey);
    return row?.contextTokens;
  });
  // Resolve the active session's agent ONCE here; provide it to every turn
  // avatar/header via context so they all show the same real persona.
  const agentProfile = useActiveAgentProfile();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // ── Smart auto-scroll state ────────────────────────────────────────────
  // WhatsApp-style behavior:
  //  1. When the user is AT BOTTOM, we keep them pinned — new messages and
  //     streaming deltas all auto-scroll down.
  //  2. When the user has scrolled UP to read older content, we stop
  //     hijacking their scroll position. Instead, we count arriving messages
  //     as "unread" and surface a floating chip to jump back.
  //  3. The user's OWN sends (last committed message has role=user) always
  //     scroll to bottom regardless of position — you don't want to not see
  //     your own message land.
  //  4. Session switch always scrolls to bottom (new context).
  //
  // We track the committed message count (length of `messages`, not the
  // synthesized renderList which can swell by 1 for pending/streaming stubs)
  // because that's what reliably marks "a new turn has landed" for the
  // unread counter.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const prevCommittedLenRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);

  const committed = messages ?? [];
  const committedLen = committed.length;

  const renderList = useMemo<ChatMessage[]>(() => {
    // Drop heartbeat-runner's (user-role synthetic prompt + assistant
    // HEARTBEAT_OK) pairs BEFORE grouping — they leak into the transcript
    // because they ride the same `user`/`assistant` roles as real chat.
    // Mirror of OpenClaw upstream's heartbeat-filter.ts; see §3.7.1 G-notes.
    const base = filterHeartbeatPairs(messages ?? []);
    const extras: ChatMessage[] = [];
    if (streaming) extras.push(streaming);
    else if (sending) {
      extras.push({
        id: "__pending__",
        role: "assistant",
        content: "",
        blocks: [],
        state: "pending",
        createdAt: Date.now(),
      });
    }
    return extras.length ? [...base, ...extras] : base;
  }, [messages, streaming, sending]);

  const turns = useMemo(() => groupTurns(renderList), [renderList]);

  // H1 — Edit user message: the edit chip is only shown on the LAST user
  // text message (Hermes 0.14 has no message-level delete RPC, so editing
  // earlier messages would leave the old turns on disk and resurface on
  // refresh). Walk the rendered list backwards to find that id.
  const lastUserMessageId = useMemo(() => {
    for (let i = renderList.length - 1; i >= 0; i--) {
      const m = renderList[i];
      if (m.role === "user" && m.kind !== "tool" && m.content?.trim()) {
        return m.id;
      }
    }
    return null;
  }, [renderList]);

  // H3 — Search within thread. When the query is non-empty, compute the
  // set of message IDs whose content matches (case-insensitive). The
  // ChatBubble + UserBubble dim themselves when their message id is NOT
  // in the set.
  const searchQuery = useAppStore((s) => s.chatSearchQuery);
  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set<string>();
    for (const m of renderList) {
      if (m.kind === "tool") continue;
      const text = (m.content || "").toLowerCase();
      if (text.includes(q)) ids.add(m.id);
    }
    return ids;
  }, [searchQuery, renderList]);

  // R1 — Render-window virtualization (light variant). For threads above
  // VIRTUAL_THRESHOLD, render only the most recent VIRTUAL_WINDOW_SIZE
  // rows; older rows hide behind a "Load earlier" CTA. Avoids the
  // architectural risk of swapping the scroller out for a windowed
  // virtualizer (which would break the WhatsApp-style auto-scroll +
  // unread pin behaviour above) while still bounding render cost for
  // long-running sessions. Search disables the window so search results
  // anywhere in the thread are visible. Same for active search.
  const VIRTUAL_THRESHOLD = 200;
  const VIRTUAL_WINDOW_SIZE = 150;
  const [revealEarlier, setRevealEarlier] = useState(false);
  // Reset window on session switch so a fresh thread doesn't show stale
  // "load earlier" state.
  useEffect(() => {
    setRevealEarlier(false);
  }, [activeKey]);

  // Flatten turns into a row sequence with day-dividers spliced in wherever
  // the calendar day changes. One walk, stable keys — keeps the render tree
  // thin and gives the sticky pill a ready list of divider nodes to observe.
  const rows = useMemo<ThreadRow[]>(() => {
    const out: ThreadRow[] = [];
    let lastDayKey = "";
    turns.forEach((turn, idx) => {
      const anchor = turnAnchorTime(turn);
      if (anchor) {
        const dk = localDayKey(anchor);
        if (dk && dk !== lastDayKey) {
          out.push({
            kind: "day",
            id: `day-${dk}`,
            ts: anchor,
            dayKey: dk,
            label: formatDayDivider(anchor),
          });
          lastDayKey = dk;
        }
      }
      out.push({ kind: "turn", id: `turn-${idx}`, turn });
    });
    return out;
  }, [turns]);

  // R1 — Apply the windowing AFTER turn-grouping so the day-divider
  // boundaries inside the visible window remain consistent. We don't
  // window when search is active (need all matches visible) or when the
  // user explicitly revealed the earlier slice.
  const totalRows = rows.length;
  const isWindowed =
    !searchQuery && totalRows > VIRTUAL_THRESHOLD && !revealEarlier;
  const visibleRows = useMemo<ThreadRow[]>(() => {
    if (!isWindowed) return rows;
    return rows.slice(totalRows - VIRTUAL_WINDOW_SIZE);
  }, [rows, totalRows, isWindowed]);
  const hiddenCount = isWindowed ? totalRows - VIRTUAL_WINDOW_SIZE : 0;

  const handleDismissError = useCallback(() => {
    clearError(activeKey);
  }, [clearError, activeKey]);

  // ── 1. Scroll listener (rAF-throttled) ───────────────────────────────
  // One passive listener, one in-flight rAF at a time. We keep the "are we
  // at the bottom?" answer in a ref so the commit-growth + streaming-pin
  // effects below can read it synchronously without re-renders; the
  // state setter is just for the chip to reactively mount/unmount.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const BOTTOM_THRESHOLD = 80; // px of slack — chat bubbles have padding

    const compute = () => {
      scrollRafRef.current = null;
      const el2 = scrollerRef.current;
      if (!el2) return;
      const distance = el2.scrollHeight - el2.scrollTop - el2.clientHeight;
      const at = distance < BOTTOM_THRESHOLD;
      atBottomRef.current = at;
      setAtBottom(at);
      if (at) setUnread(0);
    };

    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = window.requestAnimationFrame(compute);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", compute);
    // Prime — first paint might not have triggered a scroll event yet.
    compute();

    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", compute);
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // ── 2. Session-switch reset — scroll, rebase, drop unread ────────────
  // Runs strictly on activeKey change (eslint-disable keeps committedLen
  // out of deps because re-running on growth is task 3's job, not ours).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(0);
    prevCommittedLenRef.current = messages?.length ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // ── 3. Commit growth — new COMMITTED message(s) arrived ──────────────
  // We only scroll when (a) the new tail is the user's own send, or
  // (b) they were already at bottom. Otherwise we bump the unread counter
  // so the chip tells them something landed out of view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const prev = prevCommittedLenRef.current;
    if (committedLen === prev) return;
    if (committedLen < prev) {
      // Shouldn't happen outside of session-switch, but stay safe.
      prevCommittedLenRef.current = committedLen;
      return;
    }
    const diff = committedLen - prev;
    const tail = committed[committedLen - 1];
    const userSent = tail?.role === "user";
    if (userSent || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // Own sends reset unread; also keep at 0 when we were already at bottom.
      setUnread(0);
    } else {
      setUnread((n) => Math.min(999, n + diff));
    }
    prevCommittedLenRef.current = committedLen;
    // committed stays out of deps — it's a locally-derived array we read via
    // closure; committedLen is the stable growth signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedLen]);

  // ── 4. Streaming pin — stay at bottom while deltas pour in ───────────
  // Gateway throttles deltas at ~150ms, and each delta carries the FULL
  // merged text (wire gotcha G5) — renderList replaces the streaming node
  // on every tick. If user is pinned to bottom, follow along; otherwise we
  // leave them alone so they can read history without being yanked.
  const streamingSig = streaming?.content ?? null;
  const streamingBlocksSig = streaming?.blocks?.length ?? 0;
  useEffect(() => {
    if (!streaming) return;
    if (!atBottomRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streaming, streamingSig, streamingBlocksSig]);

  // ── 5. Error banner appearance — keep pinned if already at bottom ────
  useEffect(() => {
    if (!errorMsg) return;
    if (!atBottomRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [errorMsg]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Smooth for user-initiated jump (chip click); the auto-effects above
    // use instant scrollTop assignment so streaming doesn't feel laggy.
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUnread(0);
  }, []);

  const hasAny = renderList.length > 0 || Boolean(errorMsg);

  // A1 — dedicated aria-live region for streaming announcements. The main
  // scroller's `aria-live="polite" aria-relevant="additions"` is too noisy
  // because it fires on EVERY delta (gateway throttles at ~150ms = 7 per
  // second). We announce only transitions: thinking-start, reply-complete,
  // error. The region is visually-hidden but semantically present.
  const lastMsg = renderList.length > 0 ? renderList[renderList.length - 1] : null;
  const isTyping = sending || (streaming && !streaming.content);
  const justFinished =
    lastMsg && lastMsg.role === "assistant" && lastMsg.state === "final";
  const ariaAnnouncement = errorMsg
    ? `Error: ${errorMsg}`
    : isTyping
      ? "Buff sedang menyiapkan balasan"
      : streaming && streaming.content
        ? "Buff mengetik balasan"
        : justFinished
          ? "Buff selesai membalas"
          : "";

  return (
    <AgentProfileProvider value={agentProfile}>
    <div className="relative h-full">
      {/* A1 — visually-hidden screen-reader announcement region. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {ariaAnnouncement}
      </span>
      <div
        ref={scrollerRef}
        className="scrollbar-slim h-full overflow-y-auto px-5 py-6"
        role="log"
        // The visual scroller no longer needs aria-live — A1's dedicated
        // region above handles the transition announcements without spam.
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {loadingHistory && !hasAny ? (
            <HistoryLoading />
          ) : (
            <>
              {hiddenCount > 0 ? (
                <LoadEarlierBanner
                  hiddenCount={hiddenCount}
                  onReveal={() => setRevealEarlier(true)}
                />
              ) : null}
              {visibleRows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <DayDivider
                      key={row.id}
                      dayKey={row.dayKey}
                      label={row.label}
                    />
                  );
                }
                const turn = row.turn;
                if (turn.kind === "user") {
                  const userMatched =
                    !searchMatchIds || searchMatchIds.has(turn.message.id);
                  return (
                    <div
                      key={`${row.id}-user-${turn.message.id}`}
                      className={cn(
                        "transition-opacity",
                        searchMatchIds && !userMatched && "opacity-30",
                      )}
                    >
                      <UserBubble
                        message={turn.message}
                        editable={turn.message.id === lastUserMessageId}
                        searchQuery={searchQuery}
                      />
                    </div>
                  );
                }
                const agentMatched =
                  !searchMatchIds ||
                  turn.messages.some((m) => searchMatchIds.has(m.id));
                return (
                  <AgentTurn
                    key={`${row.id}-agent-${turn.messages[0].id}`}
                    messages={turn.messages}
                    contextTokens={contextTokens}
                    dimmed={!!searchMatchIds && !agentMatched}
                    searchQuery={searchQuery}
                  />
                );
              })}
              {errorMsg ? (
                <ErrorBanner
                  message={errorMsg}
                  onDismiss={handleDismissError}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
      <StickyDayPill scrollRef={scrollerRef} sessionKey={activeKey} />
      <ScrollToBottomChip
        atBottom={atBottom}
        unread={unread}
        onClick={scrollToBottom}
      />
    </div>
    </AgentProfileProvider>
  );
}

/**
 * Floating "jump to latest" chip — WhatsApp / Telegram idiom. Mounts when the
 * reader has scrolled UP from the bottom; shows the count of committed messages
 * that landed while they were out of viewport. Click → smooth-scrolls to tail
 * + resets the counter.
 *
 * Deliberately outside the scroll container so it stays pinned to the viewport
 * while the transcript scrolls underneath. `pointer-events-none` on the shell
 * lets hovers pass through to the chat when the chip isn't the target;
 * `pointer-events-auto` on the button itself keeps it clickable.
 *
 * Styling mirrors the sticky day pill: glass blur + dark surface + cyan-
 * accented hover. When unread > 0 we dress it up with the "Pesan baru" label
 * + a gradient count badge; at zero it degrades to a neutral "Ke bawah".
 */
function ScrollToBottomChip({
  atBottom,
  unread,
  onClick,
}: {
  atBottom: boolean;
  unread: number;
  onClick: () => void;
}) {
  const { t } = useI18n();
  if (atBottom) return null;
  const displayCount = unread > 99 ? "99+" : String(unread);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-end pr-4">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "pointer-events-auto group/chip inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#05070C]/85 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/80 shadow-[0_8px_24px_rgba(0,0,0,0.55)] backdrop-blur-xl transition",
          "hover:border-cyan-400/50 hover:bg-[#05070C]/95 hover:text-white",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40",
        )}
        aria-label={
          unread > 0
            ? `${t.app.chat.thread.newMessages} (${unread})`
            : t.app.chat.thread.scrollToBottomLabel
        }
      >
        <ChevronDown
          aria-hidden
          className="size-3.5 text-cyan-300/80 transition-transform duration-200 group-hover/chip:translate-y-0.5 group-hover/chip:text-cyan-200"
        />
        {unread > 0 ? (
          <>
            <span>{t.app.chat.thread.newMessages}</span>
            <span
              aria-hidden
              className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-1.5 py-0.5 text-[9.5px] font-bold leading-none text-[#0B0E14] shadow-[0_0_12px_rgba(99,102,241,0.55)]"
            >
              {displayCount}
            </span>
          </>
        ) : (
          <span>{t.app.chat.thread.toBottom}</span>
        )}
      </button>
    </div>
  );
}

// ── Turn grouping ───────────────────────────────────────────────────────
type Turn =
  | { kind: "user"; message: ChatMessage }
  | { kind: "agent"; messages: ChatMessage[] };

/** Flat thread row — a turn or an interleaved day divider. Produced once per
 *  render in `ChatThread` so day-change detection happens in one walk. */
type ThreadRow =
  | { kind: "day"; id: string; ts: number; dayKey: string; label: string }
  | { kind: "turn"; id: string; turn: Turn };

/** Anchor timestamp for a turn — first message in an agent turn (avatar row
 *  represents the whole batch), or the single message for user/system turns.
 *  Used to decide whether to precede the turn with a fresh day divider. */
function turnAnchorTime(turn: Turn): number | null {
  if (turn.kind === "agent") {
    const first = turn.messages[0];
    return typeof first?.createdAt === "number" ? first.createdAt : null;
  }
  return typeof turn.message.createdAt === "number"
    ? turn.message.createdAt
    : null;
}

/** True when the message should belong to an agent-side turn (avatar +
 *  Buff header). Covers role=assistant, explicit kind=tool, plus the
 *  defensive case of a user-role message that carries only tool_result
 *  blocks (pre-kind-detection history, unexpected wire shape). */
function isAgentSideMessage(msg: ChatMessage): boolean {
  if (msg.role === "assistant") return true;
  if (msg.kind === "tool") return true;
  if (messageIsToolResultOnly(msg)) return true;
  return false;
}

function groupTurns(list: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const msg of list) {
    // Drop gateway-injected system messages (restart-sentinel, dreaming
    // updates, doctor hints, HEARTBEAT prelude). They're dev-tool chatter
    // that leaked when we swapped the Lit UI for vanilla OpenClaw —
    // mass-market users (§2.5) shouldn't see any of this.
    if (msg.role === "system") continue;
    if (isAgentSideMessage(msg)) {
      const last = turns[turns.length - 1];
      if (last && last.kind === "agent") {
        last.messages.push(msg);
      } else {
        turns.push({ kind: "agent", messages: [msg] });
      }
      continue;
    }
    turns.push({ kind: "user", message: msg });
  }
  return turns;
}

function messageIsToolResultOnly(message: ChatMessage): boolean {
  if (!message.blocks || message.blocks.length === 0) return false;
  if (message.content && message.content.trim()) return false;
  return message.blocks.every((b) => b.type === "tool_result");
}

// ── Agent turn ──────────────────────────────────────────────────────────

type AgentItem =
  | { kind: "tool"; id: string; message: ChatMessage }
  | { kind: "thinking"; id: string; blocks: ThinkingBlock[] }
  | { kind: "chat"; id: string; message: ChatMessage; blocks: ContentBlock[] };

/** Flatten turn messages into a sequence of render items. Thinking blocks
 *  embedded in chat-kind messages get hoisted into their own item so the
 *  bubble body only carries the actual reply text (mirrors openclaw's
 *  reasoning-above-bubble pattern).
 *
 *  Empty-bubble guard: when a streaming message has ONLY a thinking block
 *  (reasoning arrived before any assistant text), we push the thinking item
 *  but SKIP the chat item. Without this the bubble below the thinking card
 *  would render "(pesan kosong)" mid-stream. The `pending` state is exempt —
 *  ChatBubble renders a `<ProcessingIndicator />` on an empty-pending message
 *  shell, which is the deliberate "Agent lagi mikir…" spinner. */
function buildAgentItems(messages: ChatMessage[]): AgentItem[] {
  const items: AgentItem[] = [];
  for (const msg of messages) {
    if (msg.kind === "tool" || messageIsToolResultOnly(msg)) {
      items.push({ kind: "tool", id: `t-${msg.id}`, message: msg });
      continue;
    }
    const thinkingBlocks = (msg.blocks ?? []).filter(
      (b): b is ThinkingBlock => b.type === "thinking",
    );
    const restBlocks = (msg.blocks ?? []).filter((b) => b.type !== "thinking");
    if (thinkingBlocks.length > 0) {
      items.push({
        kind: "thinking",
        id: `th-${msg.id}`,
        blocks: thinkingBlocks,
      });
    }
    const hasBubbleContent =
      restBlocks.length > 0 ||
      (typeof msg.content === "string" && msg.content.length > 0);
    const isPending = msg.state === "pending";
    // Skip the chat row when it would be empty AND a thinking card already
    // stands in for this message. Pending-state messages fall through so
    // `<ProcessingIndicator />` can still render its "Agent lagi mikir…"
    // chip on the fresh in-flight turn.
    if (!hasBubbleContent && thinkingBlocks.length > 0 && !isPending) {
      continue;
    }
    items.push({
      kind: "chat",
      id: `c-${msg.id}`,
      message: msg,
      blocks: restBlocks,
    });
  }
  return items;
}

// PERF: memoized like ChatBubble/UserBubble so re-renders triggered by
// scroll / unread-count / search-toggle state (which leave a committed turn's
// props referentially stable) bail out instead of re-rendering every turn.
// The streaming turn's `messages` array changes each delta so it still
// re-renders — that's the changing content and is expected.
const AgentTurn = memo(AgentTurnImpl);
function AgentTurnImpl({
  messages,
  contextTokens,
  dimmed = false,
  searchQuery = "",
}: {
  messages: ChatMessage[];
  contextTokens?: number;
  dimmed?: boolean;
  searchQuery?: string;
}) {
  const agentProfile = useAgentProfile();
  const items = useMemo(() => buildAgentItems(messages), [messages]);
  // Actions + meta attach to the LAST chat bubble in the turn; if the turn
  // consists of only tool trace (mid-run snapshot), nothing gets actions.
  const lastChatIdx = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].kind === "chat") return i;
    }
    return -1;
  }, [items]);

  return (
    <div
      className={cn(
        "group/turn relative flex items-start gap-3 transition-opacity",
        dimmed && "opacity-30",
      )}
    >
      {/* Left rail — hairline that grows out of the avatar and fades out
          at the bottom of the turn, tying all the item rows together. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-4 top-10 bottom-1 w-px bg-gradient-to-b from-cyan-400/25 via-white/10 to-transparent"
      />
      <AgentAvatar />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-white/85">{agentProfile.name}</span>
          <span className="text-white/35">·</span>
          <span className="text-white/40">{agentProfile.role}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {items.map((item, idx) => (
            <AgentItemRow
              key={item.id}
              item={item}
              isLastChat={idx === lastChatIdx}
              contextTokens={contextTokens}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentItemRow({
  item,
  isLastChat,
  contextTokens,
  searchQuery = "",
}: {
  item: AgentItem;
  isLastChat: boolean;
  contextTokens?: number;
  searchQuery?: string;
}) {
  if (item.kind === "tool") {
    if (!item.message.blocks || item.message.blocks.length === 0) return null;
    return <MessageBlocks blocks={item.message.blocks} />;
  }
  if (item.kind === "thinking") {
    return <MessageBlocks blocks={item.blocks} />;
  }
  // ALL chat items render in the same bubble style — pre-tool and final
  // alike. `isLast=true` adds the copy button + meta footer; intermediate
  // chat msgs in the same turn get bubble styling but no actions, so the
  // visual reads as "one response in multiple phases" rather than two
  // distinct messages. Per chief's preference: consistent bubble is less
  // confusing than special "Rencana eksekusi" / bare-text variants.
  return (
    <ChatBubble
      message={item.message}
      blocks={item.blocks}
      isLast={isLastChat}
      contextTokens={contextTokens}
      searchQuery={searchQuery}
    />
  );
}


// P1 — memoized so unrelated parent re-renders (status pill, scroll state,
// other turns receiving deltas) don't re-render every prior turn in the
// transcript. Props are: message (stable ref via useMemo in parent), blocks
// (stable ref), isLast (boolean), searchQuery (string), contextTokens
// (number/undefined) — all shallow-comparable.
const ChatBubble = memo(ChatBubbleImpl);
function ChatBubbleImpl({
  message,
  blocks,
  isLast,
  contextTokens,
  searchQuery = "",
}: {
  message: ChatMessage;
  blocks: ContentBlock[];
  isLast: boolean;
  searchQuery?: string;
  contextTokens?: number;
}) {
  const { t } = useI18n();
  const activeSessionForAnnotations = useAppStore(
    (s) => s.activeSessionKey,
  );
  const isPending = message.state === "pending";
  const isErrored = message.state === "error";
  const isAborted = message.state === "aborted";
  const isDelta = message.state === "delta";
  const isFinal = !message.state || message.state === "final";

  const hasBlocks = blocks.length > 0;
  const showThinking = isPending && !hasBlocks && !message.content;

  const copyText = useMemo(() => {
    const fromBlocks = blocks?.length ? blocksToText(blocks).trim() : "";
    if (fromBlocks) return fromBlocks;
    return (message.content ?? "").trim();
  }, [blocks, message.content]);

  if (showThinking) {
    return <ProcessingIndicator />;
  }

  // Bot-emitted media attachments (image_generate / text_to_speech /
  // video_generate / write_file output). Rendered ABOVE the bubble so
  // the chip is the eye-catcher — same Telegram/WA pattern user-side
  // attachments already use. Renders only on `final` state because
  // attachments are extracted from the agent's final text by the bridge.
  const botAttachments =
    isFinal && message.attachments && message.attachments.length > 0
      ? message.attachments
      : null;

  return (
    <div className="flex flex-col gap-2">
      {botAttachments ? (
        <MessageAttachments attachments={botAttachments} align="start" />
      ) : null}
      <div
        data-message-id={message.id}
        className={cn(
          "group/bubble relative rounded-2xl rounded-tl-md border px-4 py-3 text-sm leading-relaxed transition-shadow",
          isErrored
            ? "border-red-500/40 bg-red-500/5 text-white/90"
            : message.ephemeral
              ? "border-dashed border-indigo-400/40 bg-indigo-500/[0.06] text-white/85"
              : "border-white/10 bg-white/[0.04] text-white/85",
        )}
      >
        {isFinal ? (
          <AssistantBubbleActions
            messageId={message.id}
            sessionKey={activeSessionForAnnotations}
            copyText={copyText}
            replyBy={message.meta?.model || "Buff"}
            replySnippet={copyText || message.content || ""}
            isLast={isLast}
          />
        ) : null}
        {message.deleted ? (
          <p className="italic text-white/45 line-through">
            {"Pesan dihapus"}
          </p>
        ) : null}
        {message.deleted ? null : hasBlocks ? (
          <MessageBlocks
            blocks={blocks}
            streaming={isDelta}
            searchQuery={searchQuery}
          />
        ) : message.content ? (
          <MessageMarkdown searchQuery={searchQuery} streaming={isDelta}>
            {message.content}
          </MessageMarkdown>
        ) : message.hasToolActivity ? (
          <span className="italic text-white/55">
            {t.app.chat.thread.runningTool}
          </span>
        ) : (
          <span className="italic text-white/45">
            {t.app.chat.thread.emptyMessagePlaceholder}
          </span>
        )}

        {isDelta ? (
          <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-cyan-300 align-middle" />
        ) : null}

        {isAborted ? (
          <div className="mt-2 text-[11px] italic text-white/55">
            {t.app.chat.thread.abortedNotice}.
          </div>
        ) : null}

        {isErrored && message.errorMessage ? (
          <p className="mt-2 break-words text-[11px] text-red-300/90">
            {message.errorMessage}
          </p>
        ) : null}

        {message.ephemeral ? (
          <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-indigo-300/80">
            <EyeOff className="size-3" />
            <span>Only visible to you</span>
          </div>
        ) : null}

        <BubbleTime createdAt={message.createdAt} tone="assistant" />
      </div>

      {isFinal && isLast && message.content && APPROVAL_RE.test(message.content) ? (
        <ApprovalBar />
      ) : null}

      {isFinal ? (
        <MessageReactions
          sessionKey={activeSessionForAnnotations}
          messageId={message.id}
        />
      ) : null}

      {isLast && isFinal ? (
        <div className="flex flex-wrap items-center gap-2">
          <MessageMeta meta={message.meta} contextTokens={contextTokens} />
        </div>
      ) : null}
    </div>
  );
}

// ── Shared subcomponents ────────────────────────────────────────────────

/** R1 — Load-earlier banner. Shown when a long thread has been windowed.
 *  Clicking reveals all earlier turns; safe because heavy markdown +
 *  highlight rendering only happens after this gesture. */
function LoadEarlierBanner({
  hiddenCount,
  onReveal,
}: {
  hiddenCount: number;
  onReveal: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onReveal}
      className="mx-auto flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs text-white/65 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200"
    >
      <RotateCcw className="size-3" />
      <span className="font-semibold">
        {t.app.chat.thread.loadEarlierLabel}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
        {t.app.chat.thread.loadEarlierHint.replace(
          "{remaining}",
          String(hiddenCount),
        )}
      </span>
    </button>
  );
}

function HistoryLoading() {
  return (
    <div className="space-y-5" aria-busy>
      <div className="flex justify-end">
        <div className="h-10 w-40 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]" />
      </div>
      <div className="flex items-start gap-3">
        <div className="size-8 animate-pulse rounded-full border border-white/10 bg-white/[0.04]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
          <div className="h-24 w-full max-w-[480px] animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="h-10 w-52 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]" />
      </div>
    </div>
  );
}

// P1 — memoized for the same reasons as ChatBubble. The `message` ref is
// stable because the parent groups via useMemo.
const UserBubble = memo(UserBubbleImpl);
function UserBubbleImpl({
  message,
  editable = false,
  searchQuery = "",
}: {
  message: ChatMessage;
  editable?: boolean;
  searchQuery?: string;
}) {
  const { t } = useI18n();
  const activeSessionForAnnotations = useAppStore(
    (s) => s.activeSessionKey,
  );
  const [editing, setEditing] = useState(false);
  // Busy = sending or streaming for this session. Edit+resubmit calls
  // sendMessage which refuses while busy (store.editAndResubmit:2524), so
  // showing the Edit chip during that window opens a dead-end editor.
  // Hide the chip — the user can wait or hit Stop to interrupt the stream,
  // then edit normally. We also auto-close any open editor if the session
  // flips to busy mid-edit (e.g. clarify-request resumes a stream).
  const isBusy = useAppStore((s) => {
    const k = s.activeSessionKey;
    return !!(s.sending[k] || s.streaming[k]);
  });
  useEffect(() => {
    if (isBusy && editing) setEditing(false);
  }, [isBusy, editing]);
  const hasAttachments =
    !!message.attachments && message.attachments.length > 0;
  const hasText = !!message.content && message.content.trim().length > 0;
  /** Synthetic media summaries — extracted from bridge-injected prefixes
   *  on history rehydrate. Used as a fallback when the original `attachments`
   *  array is gone (e.g. after page refresh). Hidden when real attachments
   *  ARE present so we don't double up. */
  const mediaSummaries = message.userContext?.mediaSummaries;
  const hasMediaSummaries =
    !hasAttachments && !!mediaSummaries && mediaSummaries.length > 0;
  // NOTE: the gateway-injected meta card (timestamp / channel envelope / sender
  // JSON) is intentionally NOT rendered — chief asked to hide it because it
  // clutters every message. The capture still lives in `message.userContext`
  // (and the `UserContextRow` component is kept) so it can be re-surfaced
  // behind a future developer/debug toggle without re-plumbing.
  if (!hasAttachments && !hasText && !hasMediaSummaries) return null;
  const copyText = hasText ? message.content.trim() : "";
  // Edit mode disabled when attachments present (can't reconstruct File),
  // and disabled while a stream is in flight (would dead-end in store).
  const canEdit = editable && hasText && !hasAttachments && !isBusy;
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1.5">
        {hasAttachments ? (
          <MessageAttachments
            attachments={message.attachments!}
            align="end"
          />
        ) : hasMediaSummaries ? (
          <MediaSummaryList summaries={mediaSummaries!} />
        ) : null}
        {hasText && editing ? (
          <UserBubbleEditor
            initialText={message.content}
            messageId={message.id}
            onClose={() => setEditing(false)}
          />
        ) : hasText ? (
          <div
            data-message-id={message.id}
            className={cn(
              "group/bubble relative rounded-2xl rounded-tr-md border bg-[#0B0E14]/80 px-4 py-2.5 text-sm text-white/90 transition-shadow",
              message.ephemeral
                ? "border-dashed border-indigo-400/50 shadow-[0_0_0_1px_rgba(129,140,248,0.18)]"
                : "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]",
            )}
          >
            <UserBubbleActions
              messageId={message.id}
              sessionKey={activeSessionForAnnotations}
              copyText={copyText}
              canEdit={canEdit}
              onStartEdit={() => setEditing(true)}
            />
            {message.deleted ? (
              <div className="italic text-white/45 line-through">
                {"Pesan dihapus"}
              </div>
            ) : (() => {
              // Detect the reply-prefix the composer prepends when the
              // user replied to a specific bubble:
              //   **↪ Membalas @<by>:**
              //   > <quoted line>
              //   > <quoted line>
              //
              //   <reply text>
              //
              // If matched, split into (quote, body) and render a Telegram-
              // style mini quote card ABOVE the user's actual reply text.
              // Falls through to plain text rendering on no match.
              const replyMatch = parseReplyPrefix(message.content);
              if (replyMatch) {
                return (
                  <div className="flex flex-col gap-1.5">
                    <ReplyQuoteCard
                      speaker={replyMatch.speaker}
                      quoted={replyMatch.quoted}
                    />
                    <div className="whitespace-pre-wrap break-words">
                      {searchQuery
                        ? highlightMatches(replyMatch.body, searchQuery)
                        : replyMatch.body}
                    </div>
                  </div>
                );
              }
              return (
                <div className="whitespace-pre-wrap break-words">
                  {searchQuery
                    ? highlightMatches(message.content, searchQuery)
                    : message.content}
                </div>
              );
            })()}
            {message.ephemeral ? (
              <div className="mt-2 flex items-center justify-end gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-indigo-300/80">
                <EyeOff className="size-3" />
                <span>Only visible to you</span>
              </div>
            ) : null}
            <BubbleTime createdAt={message.createdAt} tone="user" />
            {message.editedAt ? (
              <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
                · diedit
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** H1 — inline editor that swaps in for a UserBubble when the edit chip is
 *  clicked. Enter = resubmit, Esc = cancel. Wires editAndResubmit which
 *  truncates the local transcript before the edited turn and re-sends. */
function UserBubbleEditor({
  initialText,
  messageId,
  onClose,
}: {
  initialText: string;
  messageId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const editAndResubmit = useAppStore((s) => s.editAndResubmit);
  const [value, setValue] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-grow the textarea to fit content (max 200px before scroll).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    if (trimmed === initialText.trim()) {
      // No change — just close without re-sending so we don't burn energy.
      onClose();
      return;
    }
    setBusy(true);
    try {
      const ok = await editAndResubmit(messageId, trimmed);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  }, [value, busy, initialText, editAndResubmit, messageId, onClose]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleSave, onClose],
  );

  return (
    <div className="w-full min-w-[280px] max-w-[600px] rounded-2xl rounded-tr-md border border-cyan-400/60 bg-[#0B0E14]/90 p-2.5 shadow-[0_0_20px_rgba(34,211,238,0.2)]">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        disabled={busy}
        placeholder={t.app.chat.thread.editPlaceholder}
        aria-label={t.app.chat.thread.editAriaLabel}
        className="w-full resize-none bg-transparent px-1 text-sm leading-relaxed text-white placeholder:text-white/30 focus:outline-none disabled:opacity-50"
      />
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35">
          {t.app.chat.thread.editHint}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-white/55 transition hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            {t.app.chat.thread.editCancel}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !value.trim()}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold transition",
              busy || !value.trim()
                ? "cursor-not-allowed bg-white/[0.04] text-white/30"
                : "bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14] hover:brightness-110",
            )}
          >
            {busy ? (
              <RotateCcw className="size-3 animate-spin" />
            ) : null}
            {t.app.chat.thread.editSave}
          </button>
        </div>
      </div>
    </div>
  );
}

/** B5 — Subscribe to a single annotation entry via useSyncExternalStore so
 *  the component re-renders whenever the underlying localStorage row
 *  changes (this tab OR another tab). Returns `null` when no annotation. */
function useAnnotation(
  sessionKey: string,
  messageId: string,
): Annotation | null {
  return useSyncExternalStore(
    subscribeAnnotations,
    () => getAnnotation(sessionKey, messageId),
    () => null, // SSR snapshot — annotations are client-only
  );
}

/** B5 — Inline annotation editor. Renders as a floating panel pinned just
 *  below the bubble. Ctrl/Cmd+Enter to save, Esc to cancel. */
function AnnotationEditor({
  sessionKey,
  messageId,
  initial,
  onClose,
}: {
  sessionKey: string;
  messageId: string;
  initial: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const handleSave = useCallback(() => {
    setAnnotation(sessionKey, messageId, value);
    onClose();
  }, [sessionKey, messageId, value, onClose]);

  const handleDelete = useCallback(() => {
    deleteAnnotation(sessionKey, messageId);
    onClose();
  }, [sessionKey, messageId, onClose]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave, onClose],
  );

  return (
    <div
      role="dialog"
      aria-label={t.app.chat.thread.annotationEyebrow}
      className="absolute right-2 top-10 z-20 w-72 rounded-xl border border-cyan-400/40 bg-[#0B0E14]/95 p-2.5 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-cyan-300/80">
        {t.app.chat.thread.annotationEyebrow}
      </p>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, NOTE_MAX))}
        onKeyDown={handleKey}
        placeholder={t.app.chat.thread.annotationPlaceholder}
        rows={4}
        className="w-full resize-none rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none transition placeholder:text-white/30 focus:border-cyan-400/60 focus:bg-black/60"
      />
      <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/35">
        {t.app.chat.thread.annotationHint}
      </p>
      <div className="mt-2 flex items-center justify-between gap-1.5">
        {initial ? (
          <button
            type="button"
            onClick={handleDelete}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-semibold text-red-300/85 transition hover:bg-red-500/15 hover:text-red-200"
          >
            <Trash2 className="size-3" />
            {t.app.chat.thread.annotationDelete}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[10.5px] font-semibold text-white/65 transition hover:bg-white/5 hover:text-white"
          >
            {t.app.chat.thread.annotationCancel}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-1 rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-2.5 py-1 text-[10.5px] font-bold text-[#0B0E14] transition hover:brightness-110"
          >
            <Check className="size-3" />
            {t.app.chat.thread.annotationSave}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Delete button — opens a confirmation modal (chief preference; matches
 *  Telegram/Discord/Instagram/WA delete-message UX). On confirm, the
 *  bridge soft-deletes the message via `messages.delete` and the bubble
 *  swaps to a strikethrough "Pesan dihapus" placeholder.
 *
 *  Previous version used inline two-click confirm; switched to a modal
 *  per chief's feedback: "pesan konfirmasi popup saja, karena itu lebih
 *  biasa dilakukan banyak user di banyak sosmed". */
/**
 * Consolidated action toolbar for ASSISTANT bubbles.
 *
 * Discord-style single pill anchored to the BOTTOM-RIGHT of the bubble
 * (chief 2026-05-24: previous top-right placement overlapped bubble
 * text — "kadang suka bikin nimpa tulisan di bubble nya jadi ketutupan").
 *
 *   ┌─────────────────────────────┐
 *   │   bubble content...         │
 *   ├─────────────────────────────┤
 *   │ ↪ appears on hover: pill    │
 *   │ [😊][↩][📋][🔊][🔄][⋯]      │
 *   └─────────────────────────────┘
 *
 * Primary actions (inline icons):
 *   - Reaksi (😊)
 *   - Balas (↩)
 *   - Salin (📋 ↔ ✓ when just-copied)
 *   - Putar Suara (🔊 → ■ playing → loading state)
 *   - Regenerate (🔄) — ONLY on the last assistant bubble
 *
 * Overflow ⋯ More menu:
 *   - Catatan (bookmark icon — filled cyan when annotation exists)
 *   - Hapus pesan (danger variant)
 *
 * Annotation editor + delete-confirm modal live OUTSIDE the toolbar.
 */
function AssistantBubbleActions({
  messageId,
  sessionKey,
  copyText,
  replyBy,
  replySnippet,
  isLast,
}: {
  messageId: string;
  sessionKey: string;
  copyText: string;
  replyBy: string;
  replySnippet: string;
  isLast: boolean;
}) {
  const { t } = useI18n();
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const deleteMessageInPlace = useAppStore((s) => s.deleteMessageInPlace);
  const playTTS = useAppStore((s) => s.playTTS);
  const retryLastUserMessage = useAppStore((s) => s.retryLastUserMessage);
  const annotation = useAnnotation(sessionKey, messageId);
  const isSessionBusy = useAppStore(
    (s) =>
      Boolean(s.streaming[s.activeSessionKey]) ||
      Boolean(s.sending[s.activeSessionKey]),
  );

  const [copied, setCopied] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // TTS playback state. Audio element kept in ref so a second click can
  // pause+reset the same instance — no "old audio keeps playing while a
  // new one starts" overlap. Cleanup on unmount stops orphaned audio
  // when the bubble unmounts mid-playback (e.g. session switch).
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Regenerate state — local "pending" while the store action runs so
  // the icon can show a spin animation distinct from the global
  // session-busy state (which lights up the moment another caller is
  // sending too).
  const [regenPending, setRegenPending] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!copyText) return;
      try {
        await navigator.clipboard.writeText(copyText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // Clipboard blocked / permission denied — silent fail OK.
      }
    },
    [copyText],
  );

  const handleReply = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setReplyTarget(sessionKey, {
        messageId,
        role: "assistant",
        by: replyBy,
        snippet: replySnippet,
      });
    },
    [setReplyTarget, sessionKey, messageId, replyBy, replySnippet],
  );

  const handleTTS = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (ttsBusy) return;
      // Toggle stop if already playing.
      if (ttsPlaying && audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setTtsPlaying(false);
        return;
      }
      if (!copyText) return;
      setTtsBusy(true);
      try {
        const url = await playTTS(copyText.slice(0, 4000));
        if (!url) {
          setTtsBusy(false);
          return;
        }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener("ended", () => setTtsPlaying(false));
        audio.addEventListener("error", () => setTtsPlaying(false));
        setTtsPlaying(true);
        await audio.play();
      } catch {
        setTtsPlaying(false);
      } finally {
        setTtsBusy(false);
      }
    },
    [ttsBusy, ttsPlaying, copyText, playTTS],
  );

  const handleRegenerate = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isSessionBusy || regenPending) return;
      setRegenPending(true);
      try {
        await retryLastUserMessage();
      } finally {
        setRegenPending(false);
      }
    },
    [isSessionBusy, regenPending, retryLastUserMessage],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteMessageInPlace(messageId, sessionKey);
      setDeleteOpen(false);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteMessageInPlace, messageId, sessionKey]);

  return (
    <>
      <BubbleActions side="right">
        <ReactionPicker
          sessionKey={sessionKey}
          messageId={messageId}
          side="right"
        />
        <ActionIcon
          icon={<Reply className="size-3.5" />}
          label="Balas"
          onClick={handleReply}
        />
        {copyText ? (
          <ActionIcon
            icon={
              copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )
            }
            label={copied ? "Tersalin" : t.app.chat.thread.copyAssistant}
            onClick={handleCopy}
            active={copied}
          />
        ) : null}
        {copyText ? (
          <ActionIcon
            icon={
              ttsPlaying ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <Volume2 className="size-3.5" />
              )
            }
            label={
              ttsBusy
                ? "Bikin suara…"
                : ttsPlaying
                  ? "Stop"
                  : "Putar suara"
            }
            onClick={handleTTS}
            active={ttsPlaying}
            busy={ttsBusy}
          />
        ) : null}
        {isLast ? (
          <ActionIcon
            icon={<RotateCcw className="size-3.5" />}
            label={
              isSessionBusy || regenPending
                ? "Sedang sibuk…"
                : t.app.chat.thread.regenerateAriaLabel
            }
            onClick={handleRegenerate}
            busy={regenPending}
            disabled={isSessionBusy || regenPending}
          />
        ) : null}
        <MoreMenu side="right">
          <MoreMenuItem
            icon={
              <Bookmark
                className="size-3.5"
                fill={annotation ? "currentColor" : "none"}
              />
            }
            label={
              annotation
                ? t.app.chat.thread.annotationEditLabel
                : t.app.chat.thread.annotationAddLabel
            }
            onClick={() => setEditingAnnotation(true)}
          />
          <MoreMenuItem
            icon={<Trash2 className="size-3.5" />}
            label="Hapus pesan"
            onClick={() => setDeleteOpen(true)}
            danger
          />
        </MoreMenu>
      </BubbleActions>
      {editingAnnotation ? (
        <AnnotationEditor
          sessionKey={sessionKey}
          messageId={messageId}
          initial={annotation?.note ?? ""}
          onClose={() => setEditingAnnotation(false)}
        />
      ) : null}
      {deleteOpen ? (
        <DeleteConfirmModal
          busy={deleteBusy}
          onConfirm={handleDeleteConfirm}
          onCancel={() => !deleteBusy && setDeleteOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Consolidated action toolbar for USER bubbles.
 *
 * Positioned at the top-LEFT (which is the chat-facing edge for a right-
 * aligned user bubble). Primary: Salin only (users rarely react to their
 * own messages). Overflow ⋯ menu: Catatan · Edit (conditional) · Hapus.
 *
 * Edit was previously a separate chip beneath the bubble; chief feedback
 * preferred consolidation, so it's now an item in the More menu, behind
 * the same hover-reveal as the rest.
 */
function UserBubbleActions({
  messageId,
  sessionKey,
  copyText,
  canEdit,
  onStartEdit,
}: {
  messageId: string;
  sessionKey: string;
  copyText: string;
  canEdit: boolean;
  onStartEdit: () => void;
}) {
  const { t } = useI18n();
  const deleteMessageInPlace = useAppStore((s) => s.deleteMessageInPlace);
  const annotation = useAnnotation(sessionKey, messageId);

  const [copied, setCopied] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!copyText) return;
      try {
        await navigator.clipboard.writeText(copyText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* silent */
      }
    },
    [copyText],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteMessageInPlace(messageId, sessionKey);
      setDeleteOpen(false);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteMessageInPlace, messageId, sessionKey]);

  // No primary actions besides Copy → render an empty toolbar if even
  // Copy is impossible (deleted message with no text). Skip render
  // entirely so the user sees a clean bubble.
  if (!copyText && !canEdit) return null;

  return (
    <>
      <BubbleActions side="left">
        {copyText ? (
          <ActionIcon
            icon={
              copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )
            }
            label={copied ? "Tersalin" : t.app.chat.thread.copyUser}
            onClick={handleCopy}
            active={copied}
          />
        ) : null}
        <MoreMenu side="left">
          <MoreMenuItem
            icon={
              <Bookmark
                className="size-3.5"
                fill={annotation ? "currentColor" : "none"}
              />
            }
            label={
              annotation
                ? t.app.chat.thread.annotationEditLabel
                : t.app.chat.thread.annotationAddLabel
            }
            onClick={() => setEditingAnnotation(true)}
          />
          {canEdit ? (
            <MoreMenuItem
              icon={<Pencil className="size-3.5" />}
              label={t.app.chat.thread.editAriaLabel}
              onClick={onStartEdit}
            />
          ) : null}
          <MoreMenuItem
            icon={<Trash2 className="size-3.5" />}
            label="Hapus pesan"
            onClick={() => setDeleteOpen(true)}
            danger
          />
        </MoreMenu>
      </BubbleActions>
      {editingAnnotation ? (
        <AnnotationEditor
          sessionKey={sessionKey}
          messageId={messageId}
          initial={annotation?.note ?? ""}
          onClose={() => setEditingAnnotation(false)}
        />
      ) : null}
      {deleteOpen ? (
        <DeleteConfirmModal
          busy={deleteBusy}
          onConfirm={handleDeleteConfirm}
          onCancel={() => !deleteBusy && setDeleteOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Delete confirmation modal — full-screen overlay with two action
 *  buttons. Esc closes; click outside closes; Enter confirms (when not
 *  busy). Matches the popup-confirm pattern user expects from Telegram /
 *  Discord / Instagram / WA. */
function DeleteConfirmModal({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keyboard: Esc = cancel, Enter = confirm.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !busy) {
        e.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onConfirm, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
      onClick={(e) => {
        // Click on backdrop (the wrapper itself) cancels; clicks inside
        // the card (which call stopPropagation) don't.
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[#0B0E14]/95 p-5 shadow-[0_30px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl"
      >
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 text-red-300">
            <Trash2 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="delete-confirm-title"
              className="text-[15px] font-semibold text-white"
            >
              Hapus pesan ini?
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/65">
              Pesan ini akan disembunyikan dari obrolan dan diganti dengan
              tulisan &quot;Pesan dihapus&quot;. Setelah dihapus, tampilannya
              nggak bisa dikembalikan lagi.
            </p>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-medium text-white/85 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/15 px-3.5 py-1.5 text-[12px] font-semibold text-red-100 transition hover:border-red-500/70 hover:bg-red-500/25",
              busy && "cursor-wait opacity-70",
            )}
          >
            {busy ? (
              <>
                <span className="size-3 animate-pulse rounded-full bg-red-300" />
                Menghapus…
              </>
            ) : (
              <>
                <Trash2 className="size-3.5" />
                Hapus
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared copy chip — legacy label+icon variant kept for callers that
 *  still prefer the "Salin"/"Tersalin" affordance. Currently unused after
 *  switching bubbles to CopyIconButton corner icons. */
function CopyChipButton({
  text,
  ariaLabel,
}: {
  text: string;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  const copiedLabel = t.app.shared.copied;
  const copyLabel = t.app.shared.copy;
  const [copied, setCopied] = useState(false);
  const canCopy = text.length > 0;

  const handleCopy = useCallback(async () => {
    if (!canCopy) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked; fail silently — the user can still select
      // the text manually.
    }
  }, [text, canCopy]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!canCopy}
      aria-label={copied ? copiedLabel : ariaLabel}
      title={copied ? copiedLabel : copyLabel}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-white/65 transition",
        canCopy
          ? "hover:border-cyan-400/30 hover:bg-white/[0.08] hover:text-white"
          : "cursor-not-allowed opacity-40",
      )}
    >
      {copied ? (
        <>
          <Check className="size-3" /> {copiedLabel}
        </>
      ) : (
        <>
          <Copy className="size-3" /> {copyLabel}
        </>
      )}
    </button>
  );
}

function AgentAvatar() {
  const agentProfile = useAgentProfile();
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full bg-gradient-to-br opacity-70 blur-md",
          agentProfile.gradient,
        )}
      />
      <div
        className={cn(
          "relative flex size-8 items-center justify-center overflow-hidden rounded-full border border-white/10 font-display text-[13px] font-bold text-[#0B0E14]",
          agentProfile.avatarUrl ? "bg-[#0B0E14]" : "bg-gradient-to-br " + agentProfile.gradient,
        )}
      >
        {agentProfile.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={agentProfile.avatarUrl}
            alt={agentProfile.name}
            className="size-full object-cover"
          />
        ) : agentProfile.emoji ? (
          <span className="text-base leading-none">{agentProfile.emoji}</span>
        ) : (
          (agentProfile.name[0]?.toUpperCase() ?? "B")
        )}
      </div>
    </div>
  );
}

// Live spinner shown only while we have an in-flight request with zero
// content yet (pending state). Once the gateway sends the first delta, we
// swap to the streaming content bubble — basecamp's behavior, preserved for
// real data. Elapsed seconds come from a local tick so we don't need to
// know when the request started at the store level.
function ProcessingIndicator() {
  const { t, locale } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Localized "seconds" suffix. Indonesian uses "detik", English uses "s".
  const secondsLabel = locale === "id" ? "detik" : "s";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-fuchsia-400/20 bg-[#05070C]/85 px-4 py-3 font-mono text-[11.5px] text-fuchsia-200/90">
      <Terminal className="size-3.5" />
      <span className="font-semibold">{t.app.chat.thread.typingHint}</span>
      <span className="flex gap-1" aria-hidden>
        <span className="size-1 animate-pulse rounded-full bg-fuchsia-400 [animation-delay:-0.3s]" />
        <span className="size-1 animate-pulse rounded-full bg-fuchsia-400 [animation-delay:-0.15s]" />
        <span className="size-1 animate-pulse rounded-full bg-fuchsia-400" />
      </span>
      <span className="ml-auto text-white/40">{elapsed} {secondsLabel}</span>
    </div>
  );
}

/** Inline day divider — sits between turns whenever the calendar day flips
 *  (WhatsApp / Telegram idiom). Pill is centered, glass-blurred, mono
 *  uppercase so it reads as chrome rather than a message. `data-day-*`
 *  attributes let `<StickyDayPill>` discover these nodes via a plain
 *  `querySelectorAll` — no context / ref forwarding needed. */
function DayDivider({ dayKey, label }: { dayKey: string; label: string }) {
  if (!label) return null;
  return (
    <div
      data-day-divider=""
      data-day-key={dayKey}
      data-day-label={label}
      className="my-1 flex justify-center"
      role="separator"
      aria-label={label}
    >
      <div className="rounded-full border border-white/10 bg-[#05070C]/70 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-white/55 shadow-[0_2px_10px_rgba(0,0,0,0.35)] backdrop-blur-md">
        {label}
      </div>
    </div>
  );
}

/**
 * Floating day pill that tracks scroll position — same idiom WhatsApp uses
 * when the user flings through history. Absolute-positioned overlay at the
 * top of the scroll container; label derived from whichever inline
 * `DayDivider` has most recently passed above the viewport top. Fades in
 * while the user is actively scrolling, fades out ~1.2s after idle so the
 * reading surface stays calm at rest.
 *
 * Implementation:
 *  - One scroll listener, rAF-throttled. Reads `getBoundingClientRect` of
 *    every `[data-day-divider]` inside the scroll container; picks the last
 *    one whose top has crossed the scroll area's top edge.
 *  - Recomputes on resize (different scroll geometry) and whenever the
 *    session key changes (new thread = new divider set).
 *  - We intentionally don't use `position: sticky` on DayDivider itself —
 *    sticky would stack every divider at the top as the user scrolls; we
 *    want exactly ONE pill whose label updates. The overlay pattern keeps
 *    the inline divider static in the flow.
 */
function StickyDayPill({
  scrollRef,
  sessionKey,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionKey: string;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const idleTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const compute = () => {
      rafRef.current = null;
      const dividers = scrollEl.querySelectorAll<HTMLElement>(
        "[data-day-divider]",
      );
      if (dividers.length === 0) {
        setLabel(null);
        return;
      }
      const scrollTop = scrollEl.getBoundingClientRect().top;
      // Threshold: a few px below the scroll area top. A divider "passes" the
      // sticky line once its own top is above this — so the pill adopts THAT
      // divider's label (the day we're currently reading into).
      const threshold = scrollTop + 12;
      let activeIdx = -1;
      for (let i = 0; i < dividers.length; i += 1) {
        const rect = dividers[i].getBoundingClientRect();
        if (rect.top <= threshold) {
          activeIdx = i;
        } else {
          break;
        }
      }
      if (activeIdx === -1) {
        // User is above every divider — no pill needed yet.
        setLabel(null);
        return;
      }
      const nextLabel = dividers[activeIdx].getAttribute("data-day-label");
      if (nextLabel) setLabel(nextLabel);
    };

    const ping = () => {
      // Wake visibility + debounce the fade-out. scroll + resize share this.
      setVisible(true);
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        setVisible(false);
      }, 1200);
      if (rafRef.current == null) {
        rafRef.current = window.requestAnimationFrame(compute);
      }
    };

    const onScroll = ping;
    const onResize = ping;

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    // Prime once so the first-time visitor already has a label cached for the
    // topmost visible day — avoids a flash of empty state on first scroll.
    compute();

    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
    // `sessionKey` in the dep list re-primes the compute pass after a thread
    // switch — the new transcript has a different divider set.
  }, [scrollRef, sessionKey]);

  if (!label) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="rounded-full border border-white/15 bg-[#05070C]/85 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-white/70 shadow-[0_6px_22px_rgba(0,0,0,0.55)] backdrop-blur-xl">
        {label}
      </div>
    </div>
  );
}
