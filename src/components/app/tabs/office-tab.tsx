"use client";

/**
 * Office (Kantor 3D) — native AgentBuff 3D office (Three.js / react-three-fiber).
 *
 * No iframe, no external app: a first-party 3D scene fed by AgentBuff's own data.
 * Each real agent is a character; agents with a live session walk to a desk and
 * work, idle agents wander the room. Furniture uses MIT .glb assets duplicated
 * from github.com/fathah/hermes-office (see public/office3d/ATTRIBUTION.txt).
 */
import { useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { useRpc } from "@/lib/app/use-rpc";
import { useAppStore } from "@/lib/app/store";
import type { OfficeAgentInput } from "@/components/app/office3d/OfficeScene";
import { MiniChat } from "@/components/app/office3d/mini-chat";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";

/** Normalise the house agent ids ("", "default", "main") to one canonical id. */
function normAgentId(id?: string | null): string {
  const v = (id ?? "").trim();
  return v === "" || v === "default" || v === "main" ? "main" : v;
}

const OfficeScene = dynamic(
  () => import("@/components/app/office3d/OfficeScene").then((m) => m.OfficeScene),
  {
    ssr: false,
    loading: () => (
      <div className="flex size-full items-center justify-center bg-[#0b0e14]">
        <div className="flex flex-col items-center gap-3 text-white/55">
          <Loader2 className="size-7 animate-spin text-cyan-300" />
          <span className="text-sm">Menyiapkan kantor 3D…</span>
        </div>
      </div>
    ),
  },
);

export function OfficeTab() {
  const { t } = useI18n();
  const agentsRpc = useRpc<{ agents?: Array<Record<string, unknown>> }>({ method: "agents.list" });
  const refetchAgents = agentsRpc.refetch;
  const liveSessionIds = useAppStore((s) => s.liveSessionIds);
  const streaming = useAppStore((s) => s.streaming);
  const sending = useAppStore((s) => s.sending);

  // Full session list across EVERY surface (web + WhatsApp/Telegram/Discord/…),
  // not the store's web-only `sessions` (which filters channels out). We need
  // channel sessions here so channel-driven work shows in the office too.
  const allSessionsRpc = useRpc<{ sessions?: Array<{ key: string; sessionId?: string; agentId?: string }> }>({
    method: "sessions.list",
    params: {},
  });
  const refetchSessions = allSessionsRpc.refetch;
  const allSessions = useMemo(() => allSessionsRpc.data?.sessions ?? [], [allSessionsRpc.data]);

  // raw db session id -> owning agent. The owner comes from the session KEY
  // (`agent:<id>:…`) first (authoritative); the bridge `agentId` field is a
  // fallback (it's "default" for every web session, so it can't tell web
  // agents apart on its own).
  const idToAgent = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allSessions) {
      if (s.sessionId) m.set(s.sessionId, normAgentId(agentIdFromSessionKey(s.key) ?? s.agentId));
    }
    return m;
  }, [allSessions]);

  // Which agents are working right now (ANY surface): a channel/db session that
  // the bridge `sessions.activity` watcher reports as live (mapped id->agent),
  // OR a web session mid-reply (streaming/sending, agent read from its key).
  const workingAgentIds = useMemo(() => {
    const out = new Set<string>();
    for (const sid of liveSessionIds) {
      const a = idToAgent.get(sid);
      if (a) out.add(a);
    }
    for (const key of Object.keys(streaming)) if (streaming[key]) out.add(normAgentId(agentIdFromSessionKey(key)));
    for (const key of Object.keys(sending)) if (sending[key]) out.add(normAgentId(agentIdFromSessionKey(key)));
    return out;
  }, [idToAgent, liveSessionIds, streaming, sending]);

  // Keep the full session list fresh so newly-appeared sessions (esp. from
  // channels) get attributed to the right agent: poll, and refetch immediately
  // whenever a live session id isn't in our map yet.
  useEffect(() => {
    const t = setInterval(() => void refetchSessions(), 12000);
    return () => clearInterval(t);
  }, [refetchSessions]);
  // Poll the agent roster so agents added in the Agents tab show up in the
  // office (new avatar) without leaving the page; deletions remove their avatar.
  useEffect(() => {
    const t = setInterval(() => void refetchAgents(), 15000);
    return () => clearInterval(t);
  }, [refetchAgents]);
  useEffect(() => {
    for (const sid of liveSessionIds) {
      if (!idToAgent.has(sid)) {
        void refetchSessions();
        break;
      }
    }
  }, [liveSessionIds, idToAgent, refetchSessions]);

  const agents: OfficeAgentInput[] = useMemo(() => {
    const raw = agentsRpc.data?.agents ?? [];
    return raw
      .map((a) => {
        const id = String(a.id ?? a.agentId ?? "");
        const identity = (a.identity as Record<string, unknown> | undefined) ?? {};
        const name = String(identity.name ?? a.name ?? id ?? "Agen");
        const working = workingAgentIds.has(normAgentId(id));
        return { id, name, status: working ? ("working" as const) : ("idle" as const) };
      })
      .filter((a) => a.id);
  }, [agentsRpc.data, workingAgentIds]);

  const workingCount = agents.filter((a) => a.status === "working").length;

  // HARD refresh — a soft refetch + scene remount wasn't enough to surface the
  // avatars (chief: "refresh berkali kali ga muncul"). A full page reload re-runs
  // the dynamic OfficeScene import, reloads the GLB character/furniture assets,
  // and opens a fresh WS — the reliable way to bring the characters back.
  const handleRefresh = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        eyebrow="3D OFFICE"
        title={t.app.nav.tabs.office}
        subtitle="Lihat agen-agenmu hidup di kantor 3D — yang sedang bekerja duduk di mejanya, yang menganggur berjalan-jalan. Bergerak real-time mengikuti aktivitas asli mereka."
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-white/65">
              <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              {workingCount} bekerja · {agents.length} agen
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              title="Muat ulang halaman penuh kalau avatar agen belum muncul"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-400/40 hover:text-white"
            >
              <RefreshCw className="size-3" />
              Refresh
            </button>
          </div>
        }
      />
      <div className="relative flex-1">
        {agentsRpc.state.kind === "ready" && agents.length === 0 ? (
          // CONFIRMED empty — a successful agents.list genuinely returned zero
          // agents. ONLY here do we tell the chief to create one.
          <div className="flex size-full items-center justify-center bg-[#0b0e14] text-sm text-white/50">
            Belum ada agen. Buat agen dulu di tab Agen.
          </div>
        ) : agentsRpc.state.kind === "error" && agents.length === 0 ? (
          // The query failed (cold boot before the socket connected / a blip).
          // Show a retry instead of a misleading "no agents" — they exist.
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-[#0b0e14] text-sm text-white/50">
            <span>Gagal memuat agen.</span>
            <button
              type="button"
              onClick={() => void agentsRpc.refetch()}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 transition hover:border-cyan-400/40 hover:text-white"
            >
              Muat ulang
            </button>
          </div>
        ) : (
          // Connecting / first load / has agents → mount the scene NOW so the
          // room renders immediately and agents pop in the instant agents.list
          // resolves. Previously `agents.length === 0 && !loading` was true
          // during the idle/connecting window too, so a cold boot (esp. hard
          // refresh) flashed/stuck on "Belum ada agen" until the WS connected.
          <div className="absolute inset-0">
            <OfficeScene agents={agents} />
          </div>
        )}
        <MiniChat />
      </div>
    </div>
  );
}
