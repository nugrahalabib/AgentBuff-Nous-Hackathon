"use client";

/**
 * Shared agent-profile resolver — single source of truth for how an agent's
 * identity (name, role, emoji, gradient color) renders ACROSS the chat UI:
 * the workspace header, every assistant turn avatar/label, and the right-rail
 * "Tim Aktif" panel. Before this, each surface hardcoded a "Buff / Asisten
 * Pribadi / cyan→fuchsia" mock, so they disagreed with the real agent.
 *
 * The gradient is derived from the agent's `identity.theme` (cyan/fuchsia/…),
 * falling back to a stable per-position color so themeless agents still get a
 * distinct, consistent look everywhere.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppStore } from "@/lib/app/store";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";
import { useAgentsList } from "./use-agents-data";
import { getAgentDisplayName, getAgentEmoji, type AgentRow } from "./helpers";

export const THEME_GRADIENT: Record<string, string> = {
  cyan: "from-cyan-400 to-blue-500",
  fuchsia: "from-fuchsia-400 to-pink-500",
  indigo: "from-indigo-400 to-violet-500",
  violet: "from-violet-400 to-indigo-500",
  emerald: "from-emerald-400 to-teal-500",
  amber: "from-amber-400 to-orange-500",
  rose: "from-rose-400 to-red-500",
  blue: "from-blue-400 to-cyan-500",
};

const FALLBACK_GRADIENTS = [
  "from-cyan-400 to-blue-500",
  "from-fuchsia-400 to-pink-500",
  "from-emerald-400 to-teal-500",
  "from-violet-400 to-indigo-500",
  "from-amber-400 to-orange-500",
  "from-rose-400 to-red-500",
];

export function agentGradient(agent: AgentRow, index: number): string {
  const theme = agent.identity?.theme;
  if (theme && THEME_GRADIENT[theme]) return THEME_GRADIENT[theme];
  return FALLBACK_GRADIENTS[index % FALLBACK_GRADIENTS.length];
}

/** The house brand mark. The default ("utama") agent ALWAYS wears this — its
 *  face is the AgentBuff logo and is not customizable (emoji/avatar locked in
 *  the Profil tab). Specialist agents keep their own emoji/avatar. */
export const AGENTBUFF_LOGO = "/images/logo.png";

export type AgentProfile = {
  id: string;
  name: string;
  /** Persona descriptor — the agent's own description, else a friendly default
   *  (NOT the model id; that lives in /app/agents). Kept identical across all
   *  surfaces so the agent reads the same everywhere. */
  role: string;
  emoji?: string;
  /** Image avatar. Forced to the AgentBuff logo for the default agent; for
   *  specialists it's their custom avatar URL when set. Takes priority over
   *  emoji when present. */
  avatarUrl?: string;
  gradient: string;
};

export const HOUSE_PROFILE: AgentProfile = {
  id: "default",
  name: "Buff",
  role: "Personal Assistant",
  avatarUrl: AGENTBUFF_LOGO,
  gradient: "from-cyan-400 to-blue-500",
};

export function profileFromAgent(
  agent: AgentRow,
  index: number,
  isDefault = false,
): AgentProfile {
  const customAvatar =
    agent.identity?.avatarUrl?.trim() || agent.identity?.avatar?.trim() || undefined;
  return {
    id: agent.id,
    name: getAgentDisplayName(agent),
    role: agent.description?.trim() || "Personal Assistant",
    // Default agent: brand logo, ignore emoji. Specialists: their emoji.
    emoji: isDefault ? undefined : getAgentEmoji(agent),
    avatarUrl: isDefault ? AGENTBUFF_LOGO : customAvatar,
    gradient: agentGradient(agent, index),
  };
}

/**
 * Resolve the profile of the agent that owns the CURRENTLY-ACTIVE session.
 * A session is owned by exactly one agent (its `agentId`), so the whole thread
 * shows one persona. Falls back to the house "Buff" identity while agents load
 * or when the session's agent can't be resolved.
 */
export function useActiveAgentProfile(): AgentProfile {
  const activeKey = useAppStore((s) => s.activeSessionKey);
  const sessionAgentId = useAppStore(
    (s) => s.sessions.find((row) => row.key === activeKey)?.agentId,
  );
  const { data } = useAgentsList();

  return useMemo(() => {
    const agents = data?.agents ?? [];
    if (agents.length === 0) return HOUSE_PROFILE;
    // Prefer the session KEY namespace (agent:<id>:...) — it's the canonical,
    // always-correct owner. Only fall back to the session's agentId field (which
    // the engine sometimes reports as "default" for non-default agents) or the
    // default agent. This keeps the responder bubble + avatar in lock-step with
    // the header (which already parses from the key).
    const wantId =
      agentIdFromSessionKey(activeKey) ?? sessionAgentId ?? data?.defaultId;
    let idx = agents.findIndex((a) => a.id === wantId);
    if (idx < 0 && data?.defaultId) {
      idx = agents.findIndex((a) => a.id === data.defaultId);
    }
    if (idx < 0) idx = 0;
    const isDefault = agents[idx].id === (data?.defaultId ?? "default");
    return profileFromAgent(agents[idx], idx, isDefault);
  }, [data, sessionAgentId, activeKey]);
}

/**
 * Resolve ANY agent id to its profile (not just the active session's). Fetches
 * the agent list ONCE and returns a stable lookup `byId(agentId)`. Used by the
 * sidebar to stamp each session row with its owning agent's face.
 */
export function useAgentProfiles(): {
  byId: (agentId?: string | null) => AgentProfile;
  ready: boolean;
} {
  const { data } = useAgentsList();
  return useMemo(() => {
    const agents = data?.agents ?? [];
    const defaultId = data?.defaultId ?? "default";
    const map = new Map<string, AgentProfile>();
    agents.forEach((a, i) =>
      map.set(a.id, profileFromAgent(a, i, a.id === defaultId)),
    );
    const byId = (agentId?: string | null): AgentProfile => {
      // Hermes stamps the default agent's keys with the "main" sentinel; the
      // catalog calls it `defaultId`. Fold both onto the default profile.
      const want = agentId && agentId !== "main" ? agentId : defaultId;
      return map.get(want) ?? map.get(defaultId) ?? HOUSE_PROFILE;
    };
    return { byId, ready: agents.length > 0 };
  }, [data]);
}

// ── context (avoids prop-drilling + N RPC calls in the thread) ──────────────

const AgentProfileContext = createContext<AgentProfile>(HOUSE_PROFILE);

// Per-id resolver context — provided once at the sidebar root so every session
// row can look up its owning agent's face without each row firing its own RPC.
const AgentProfilesContext = createContext<
  (agentId?: string | null) => AgentProfile
>(() => HOUSE_PROFILE);

export function AgentProfilesProvider({
  resolve,
  children,
}: {
  resolve: (agentId?: string | null) => AgentProfile;
  children: ReactNode;
}) {
  return (
    <AgentProfilesContext.Provider value={resolve}>
      {children}
    </AgentProfilesContext.Provider>
  );
}

export function useAgentProfileResolver(): (
  agentId?: string | null,
) => AgentProfile {
  return useContext(AgentProfilesContext);
}

// ── presentational ──────────────────────────────────────────────────────────

/** Small round agent face — emoji on the agent's theme gradient (first letter
 *  fallback). Shared by the sidebar rows so a session's owner is recognizable
 *  at a glance, matching the header + panel persona. */
export function AgentFace({
  profile,
  size = 22,
  className,
}: {
  profile: AgentProfile;
  size?: number;
  className?: string;
}) {
  const fontPx = Math.round(size * 0.55);
  return (
    <span
      className={
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/15 font-display font-bold leading-none text-[#0B0E14] " +
        (profile.avatarUrl ? "bg-[#0B0E14] " : "bg-gradient-to-br " + profile.gradient + " ") +
        (className ? className : "")
      }
      style={{ width: size, height: size }}
      title={`${profile.name} · ${profile.role}`}
      aria-label={profile.name}
    >
      {profile.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={profile.avatarUrl}
          alt={profile.name}
          className="size-full object-cover"
        />
      ) : profile.emoji ? (
        <span style={{ fontSize: fontPx }}>{profile.emoji}</span>
      ) : (
        <span style={{ fontSize: fontPx }}>
          {profile.name[0]?.toUpperCase() ?? "B"}
        </span>
      )}
    </span>
  );
}

export function AgentProfileProvider({
  value,
  children,
}: {
  value: AgentProfile;
  children: ReactNode;
}) {
  return (
    <AgentProfileContext.Provider value={value}>
      {children}
    </AgentProfileContext.Provider>
  );
}

export function useAgentProfile(): AgentProfile {
  return useContext(AgentProfileContext);
}
