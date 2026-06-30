"use client";

/**
 * useWorkingAgents — the single source of truth for "which agents are working
 * RIGHT NOW, on ANY surface" (web chat OR a channel: Telegram / WhatsApp /
 * Discord / Slack / …).
 *
 * Why this exists (the cross-source problem): channel turns run in a SEPARATE
 * process (`hermes gateway run`) from the tui gateway that /app proxies to, so
 * the engine's in-memory `running` flag is per-process and invisible to /app.
 * The cross-process truth is the shared root `state.db`, which the bridge
 * `_run_sessions_watcher` polls; it broadcasts `sessions.activity` with the set
 * of db session ids whose agent is mid-reply. `gateway-provider` routes that
 * into the store as `liveSessionIds`. This hook maps those raw db ids back to
 * their owning agent (via `sessions.list`, which — unlike the store's web-only
 * `sessions[]` — includes channel sessions), then unions in the local web
 * turns (`streaming` / `sending`) so a web reply lights its agent too.
 *
 * CANONICAL FOLD: the house/default agent is reported three different ways
 * across the codebase — "" (unset), "main" (the gateway session-key sentinel),
 * and "default" (DEFAULT_PROFILE in `agents.list`). We fold all three to
 * "default" so a single membership test works against both `agents.list`
 * defaultId and `agentIdFromSessionKey` output (which already folds main →
 * default). Do NOT use office-tab's "main" fold here — it disagrees with
 * `agents.list` defaultId and would silently miss the default agent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@/lib/app/use-rpc";
import { useAppStore } from "@/lib/app/store";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";

/** Fold the house agent's many aliases ("", "main", "default") to "default". */
export function canonAgentId(id?: string | null): string {
  const v = (id ?? "").trim();
  return v === "" || v === "main" || v === "default" ? "default" : v;
}

type RawSessionRow = { key: string; sessionId?: string; agentId?: string };

export type WorkingAgents = {
  /** Canonical agent ids (see canonAgentId) that have a live turn anywhere. */
  workingAgentIds: Set<string>;
  /** Raw db sessionId -> canonical owning agent id. */
  idToAgent: Map<string, string>;
  /** Raw db sessionIds currently mid-reply (mirror of store.liveSessionIds). */
  liveSessionIds: string[];
};

export function useWorkingAgents(): WorkingAgents {
  const liveSessionIds = useAppStore((s) => s.liveSessionIds);
  const liveAgentIds = useAppStore((s) => s.liveAgentIds);
  const streaming = useAppStore((s) => s.streaming);
  const sending = useAppStore((s) => s.sending);

  // Full session list across EVERY surface (web + channels). The store's
  // `sessions[]` filters channel keys out (isDashboardSessionKey), so it cannot
  // attribute a channel sid to its agent — we need the raw RPC list here.
  const allSessionsRpc = useRpc<{ sessions?: RawSessionRow[] }>({
    method: "sessions.list",
    params: {},
  });
  const refetchSessions = allSessionsRpc.refetch;
  const allSessions = useMemo(
    () => allSessionsRpc.data?.sessions ?? [],
    [allSessionsRpc.data],
  );

  // raw db sessionId -> owning agent. Owner comes from the session KEY
  // (`agent:<id>:…`, authoritative) first; the bridge `agentId` field is the
  // fallback (it's "default" for every web session, so it can't disambiguate
  // web agents on its own).
  const idToAgent = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allSessions) {
      if (s.sessionId) {
        m.set(s.sessionId, canonAgentId(agentIdFromSessionKey(s.key) ?? s.agentId));
      }
    }
    return m;
  }, [allSessions]);

  const rawWorking = useMemo(() => {
    const out = new Set<string>();
    for (const sid of liveSessionIds) {
      const a = idToAgent.get(sid);
      if (a) out.add(a);
    }
    // Channel turns in flight, reported directly as agent ids by the bridge
    // active-turn marker (the DB can't show an in-progress channel turn, so the
    // sid→agent path above never catches them). Already canonical-ish; fold to
    // be safe.
    for (const aid of liveAgentIds) out.add(canonAgentId(aid));
    for (const key of Object.keys(streaming)) {
      if (streaming[key]) out.add(canonAgentId(agentIdFromSessionKey(key)));
    }
    for (const key of Object.keys(sending)) {
      if (sending[key]) out.add(canonAgentId(agentIdFromSessionKey(key)));
    }
    return out;
  }, [idToAgent, liveSessionIds, liveAgentIds, streaming, sending]);

  // Visibility latch. A channel turn (Telegram/WhatsApp) can finish in well
  // under a second on a fast model, so the raw "working" signal flickers past
  // before the eye registers it — the chief reported "animasinya tidak
  // tertampil". Keep each agent visibly working for a short minimum window so
  // the card animation is always perceivable from the web, no matter how quick
  // the off-web turn was.
  const LATCH_MS = 4000;
  const latchRef = useRef<Map<string, number>>(new Map());
  const [latchTick, setLatchTick] = useState(0);

  const workingAgentIds = useMemo(() => {
    void latchTick; // re-eval trigger: recompute when a latch expires
    const now = Date.now();
    const m = latchRef.current;
    for (const id of rawWorking) m.set(id, now + LATCH_MS);
    const out = new Set<string>();
    for (const [id, expiry] of [...m]) {
      if (expiry > now) out.add(id);
      else m.delete(id);
    }
    return out;
  }, [rawWorking, latchTick]);

  // Heartbeat while any latch is pending so an expired entry drops off (and the
  // card stops animating) even when no fresh signal arrives to re-render.
  useEffect(() => {
    if (latchRef.current.size === 0) return;
    const t = setInterval(() => setLatchTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [latchTick, rawWorking]);

  // Keep the session list fresh so a brand-new channel session gets attributed
  // to the right agent: poll every 7s, and refetch immediately whenever a live
  // sid isn't in the map yet (a channel turn just started for an unseen sid).
  useEffect(() => {
    const t = setInterval(() => void refetchSessions(), 12000);
    return () => clearInterval(t);
  }, [refetchSessions]);
  useEffect(() => {
    for (const sid of liveSessionIds) {
      if (!idToAgent.has(sid)) {
        void refetchSessions();
        break;
      }
    }
  }, [liveSessionIds, idToAgent, refetchSessions]);

  return { workingAgentIds, idToAgent, liveSessionIds };
}
