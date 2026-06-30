"use client";

/**
 * MiniChat — a floating chat dock in the corner of /app/office so the user can
 * talk to / command agents while watching them work in the 3D office.
 *
 * It reuses the real ChatThread + ChatComposer, which read everything from the
 * global Zustand store (useAppStore), so this dock is fully functional: same
 * sessions, streaming, tool calls, attachments, abort — identical to the full
 * Chat tab. The header adds a compact agent picker + session picker + new-thread
 * button. Picking an agent starts a fresh thread routed to that agent; the
 * session picker resumes any existing thread.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MessageSquare, Minus, Plus, Bot } from "lucide-react";
import { useAppStore } from "@/lib/app/store";
import { ChatThread } from "@/components/app/chat-thread";
import { ChatComposer } from "@/components/app/chat-composer";
import { useAgentsList } from "@/components/app/agents/use-agents-data";
import { getAgentDisplayName, getAgentEmoji, type AgentRow } from "@/components/app/agents/helpers";
import { isDashboardSessionKey, agentIdFromSessionKey } from "@/lib/app/session-utils";
import { cn } from "@/lib/utils";

/** Normalise the house agent ids ("", "default", "main") to one canonical id. */
function normAgent(id?: string | null): string {
  const v = (id ?? "").trim();
  return v === "" || v === "default" || v === "main" ? "main" : v;
}

function relTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return "baru";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}j`;
  return `${Math.round(h / 24)}h`;
}

export function MiniChat() {
  const [open, setOpen] = useState(false);
  const [agentMenu, setAgentMenu] = useState(false);
  const [sessionMenu, setSessionMenu] = useState(false);

  const sessions = useAppStore((s) => s.sessions);
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const setActive = useAppStore((s) => s.setActiveSession);
  const createSession = useAppStore((s) => s.createSession);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const setDefaultAgentId = useAppStore((s) => s.setDefaultAgentId);
  const status = useAppStore((s) => s.status);

  const agentsRpc = useAgentsList();
  const agents: AgentRow[] = (agentsRpc.data?.agents ?? []) as AgentRow[];
  const agentName = (canonId: string): string => {
    const a = agents.find((x) => normAgent(x.id) === canonId);
    return a ? getAgentDisplayName(a) : canonId === "main" ? "Buff" : canonId;
  };

  // The "current" agent is whoever owns the active session — so the header agent
  // and the visible session always belong to the same agent (no cross-agent mixups).
  const activeSession = useMemo(() => sessions.find((s) => s.key === activeKey), [sessions, activeKey]);
  const currentAgentId = normAgent(agentIdFromSessionKey(activeKey) ?? defaultAgentId);

  // Session list = ONLY this agent's WEB sessions. Channel sessions (WhatsApp,
  // Telegram, …) and other agents' threads are excluded — a safety filter so
  // running Buff can never open / hijack Kak Tutor's (or a channel's) session.
  const agentSessions = useMemo(
    () =>
      sessions
        .filter((s) => isDashboardSessionKey(s.key) && normAgent(agentIdFromSessionKey(s.key) ?? s.agentId) === currentAgentId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 30),
    [sessions, currentAgentId],
  );

  const ready = status === "ready";

  // close menus on outside click
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!agentMenu && !sessionMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setAgentMenu(false);
        setSessionMenu(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [agentMenu, sessionMenu]);

  const pickAgent = async (id: string) => {
    setAgentMenu(false);
    setDefaultAgentId(id);
    const canon = normAgent(id);
    // resume the agent's latest WEB session if any, else start a fresh one —
    // never lands on another agent's / a channel session.
    const existing = sessions
      .filter((s) => isDashboardSessionKey(s.key) && normAgent(agentIdFromSessionKey(s.key) ?? s.agentId) === canon)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (existing.length) await setActive(existing[0].key);
    else if (ready) await createSession(undefined, id);
  };
  const pickSession = async (key: string) => {
    setSessionMenu(false);
    await setActive(key);
  };
  const newThread = async () => {
    if (ready) await createSession(undefined, currentAgentId);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-[#0B0E14]/85 px-4 py-2.5 text-sm font-medium text-white/90 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl transition hover:border-cyan-400/40 hover:bg-[#0B0E14]/95"
      >
        <span className="relative flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[#0B0E14]">
          <MessageSquare className="size-3.5" />
        </span>
        Chat agen
      </button>
    );
  }

  return (
    <div
      ref={rootRef}
      className="absolute bottom-4 right-4 top-4 z-30 flex w-[min(400px,calc(100vw-260px))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14]/92 shadow-[0_16px_50px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl"
    >
      {/* header */}
      <div className="relative flex items-center gap-1.5 border-b border-white/[0.06] bg-[#0B0E14]/70 px-2.5 py-2">
        {/* agent picker */}
        <div className="relative">
          <button
            onClick={() => { setAgentMenu((v) => !v); setSessionMenu(false); }}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs font-medium text-white/85 hover:border-cyan-400/40"
          >
            <Bot className="size-3.5 text-cyan-300" />
            <span className="max-w-[90px] truncate">{agentName(currentAgentId)}</span>
            <ChevronDown className="size-3 text-white/40" />
          </button>
          {agentMenu ? (
            <div className="absolute left-0 top-full z-40 mt-1 max-h-64 w-56 overflow-auto rounded-xl border border-white/10 bg-[#0B0E14]/95 p-1 shadow-2xl backdrop-blur-xl">
              <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">Mulai chat dengan</div>
              {agents.length === 0 ? (
                <div className="px-2 py-2 text-xs text-white/40">Belum ada agen.</div>
              ) : (
                agents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => void pickAgent(a.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-white/85 hover:bg-white/[0.06]"
                  >
                    <span className="text-sm">{getAgentEmoji(a) ?? "🤖"}</span>
                    <span className="truncate">{getAgentDisplayName(a)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* session picker */}
        <div className="relative min-w-0 flex-1">
          <button
            onClick={() => { setSessionMenu((v) => !v); setAgentMenu(false); }}
            className="flex w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-white/80 hover:border-cyan-400/40"
          >
            <span className="min-w-0 flex-1 truncate text-left">{activeSession?.title ?? "Chat baru"}</span>
            <ChevronDown className="size-3 shrink-0 text-white/40" />
          </button>
          {sessionMenu ? (
            <div className="absolute right-0 top-full z-40 mt-1 max-h-72 w-[300px] overflow-auto rounded-xl border border-white/10 bg-[#0B0E14]/95 p-1 shadow-2xl backdrop-blur-xl">
              <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
                Sesi web · {agentName(currentAgentId)}
              </div>
              {agentSessions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-white/40">Belum ada sesi web untuk agen ini.</div>
              ) : (
                agentSessions.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => void pickSession(s.key)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/[0.06]",
                      s.key === activeKey ? "bg-white/[0.05] text-white" : "text-white/80",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-white/35">{relTime(s.updatedAt)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <button
          onClick={() => void newThread()}
          title="Thread baru"
          className="flex size-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/80 hover:border-cyan-400/40 hover:text-white"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          onClick={() => setOpen(false)}
          title="Kecilkan"
          className="flex size-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/80 hover:border-white/20 hover:text-white"
        >
          <Minus className="size-3.5" />
        </button>
      </div>

      {/* thread */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatThread />
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-white/[0.06] bg-[#0B0E14]/60">
        <ChatComposer compact />
      </div>
    </div>
  );
}
