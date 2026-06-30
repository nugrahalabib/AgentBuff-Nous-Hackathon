/**
 * capability-requirements.ts — pure resolver that takes a VocabEntry's
 * `requires[]` list + live data (model auth, channel status, MCP list)
 * and returns an aggregated readiness verdict for the UI badge + modal.
 *
 * No side effects, no React. Just data in → status out.
 */

import type {
  Requirement,
  RequirementStatus,
  VocabEntry,
} from "./vocab";
import type {
  ChannelStatusEntry,
  ChannelStatusResult,
  EnvListResult,
} from "./use-agents-data";
import type {
  McpListResult,
  ModelAuthStatusResult,
} from "./helpers";

export type RequirementCheck = {
  requirement: Requirement;
  /** True = satisfied / available. False = missing / blocked. */
  satisfied: boolean;
  /** Human-readable status note. */
  note: string;
};

export type CapabilityReadiness = {
  status: RequirementStatus;
  checks: RequirementCheck[];
  /** Short headline shown in tooltip. */
  summary: string;
};

/**
 * Resolve a capability's requirements against live runtime data.
 *
 * Returns "internal" if vocab declares no requirements at all — those
 * capabilities don't render a badge (no clutter for file/shell/memory).
 */
export function resolveReadiness(
  vocab: VocabEntry,
  data: {
    models?: ModelAuthStatusResult | null;
    channels?: ChannelStatusResult | ChannelStatusEntry[] | null;
    mcp?: McpListResult | null;
    env?: EnvListResult | null;
    /** Per-agent paired channels (bridge `agentChannels`). When present with
     *  agentId, a channel paired for THAT agent counts as satisfied even if the
     *  global channel namespace is empty (multi-account plugin case). */
    agentChannels?: Record<string, unknown> | null;
    agentId?: string;
  },
): CapabilityReadiness {
  const requires = vocab.requires ?? [];
  if (requires.length === 0) {
    return { status: "internal", checks: [], summary: "Internal — no setup required" };
  }

  const checks: RequirementCheck[] = requires.map((req) =>
    checkRequirement(req, data),
  );

  // Drop optional checks that pass — they're noise. Keep failing optionals
  // so user knows they can add them for better behavior.
  const meaningful = checks.filter((c) => c.satisfied || !isOptional(c.requirement));

  const hardFailing = meaningful.filter(
    (c) => !c.satisfied && !isOptional(c.requirement),
  );
  const blocking = hardFailing.filter((c) => c.requirement.kind === "external" && c.requirement.blocking);

  let status: RequirementStatus;
  let summary: string;
  if (blocking.length > 0) {
    status = "blocked";
    summary = `Blocked — requires ${blocking[0].requirement.label}`;
  } else if (hardFailing.length > 0) {
    status = "setup-needed";
    const first = hardFailing[0];
    summary =
      hardFailing.length === 1
        ? `Needs: ${first.requirement.label}`
        : `Needs ${hardFailing.length} setup steps`;
  } else {
    status = "ready";
    summary = "Ready to use";
  }

  return { status, checks, summary };
}

function isOptional(req: Requirement): boolean {
  if (req.kind === "external") return false; // externals are never optional
  if (req.kind === "mcp-server") return false; // explicit MCP req is required
  return req.optional === true;
}

function checkRequirement(
  req: Requirement,
  data: {
    models?: ModelAuthStatusResult | null;
    channels?: ChannelStatusResult | ChannelStatusEntry[] | null;
    mcp?: McpListResult | null;
    env?: EnvListResult | null;
    agentChannels?: Record<string, unknown> | null;
    agentId?: string;
  },
): RequirementCheck {
  switch (req.kind) {
    case "llm-key":
      return checkLlmKey(req, data.models);
    case "channel":
      return checkChannel(req, data.channels, data.agentChannels, data.agentId);
    case "mcp-server":
      return checkMcpServer(req, data.mcp);
    case "env":
      return checkEnv(req, data.env);
    case "external":
      // Externals are never "auto-resolved" — always show as needing setup.
      // blocking:true escalates to red.
      return {
        requirement: req,
        satisfied: false,
        note: req.hint,
      };
  }
}

function checkEnv(
  req: Extract<Requirement, { kind: "env" }>,
  env?: EnvListResult | null,
): RequirementCheck {
  const present = env?.presentKeys ?? [];
  if (present.includes(req.name)) {
    return {
      requirement: req,
      satisfied: true,
      note: "Set",
    };
  }
  return {
    requirement: req,
    satisfied: false,
    note: req.optional ? "Optional — fill in if needed" : "Not set",
  };
}

// Engine reports CANONICAL provider ids (e.g. "google"); vocab requirements were
// authored with the marketing alias "gemini". Normalize BOTH sides so a connected
// Google/Gemini key satisfies vision/image_gen/video_gen/tts instead of falsely
// locking them.
const PROVIDER_ALIASES: Record<string, string> = {
  gemini: "google",
  "google-gemini": "google",
};
function normalizeProvider(p: string): string {
  const lower = (p || "").toLowerCase();
  return PROVIDER_ALIASES[lower] ?? lower;
}

function checkLlmKey(
  req: Extract<Requirement, { kind: "llm-key" }>,
  models?: ModelAuthStatusResult | null,
): RequirementCheck {
  const providers = models?.providers ?? [];
  const candidates = req.providersAny && req.providersAny.length > 0
    ? req.providersAny
    : [req.provider];

  const candSet = new Set(candidates.map(normalizeProvider));
  const hits = providers.filter((p) => candSet.has(normalizeProvider(p.provider)));
  const okHits = hits.filter((p) => p.status === "ok" || p.status === "static" || p.status === "expiring");

  if (okHits.length > 0) {
    const ok = okHits[0];
    return {
      requirement: req,
      satisfied: true,
      note: `Active via ${ok.displayName}`,
    };
  }

  if (hits.length > 0) {
    return {
      requirement: req,
      satisfied: false,
      note: `${hits[0].displayName} key expired / not logged in`,
    };
  }

  return {
    requirement: req,
    satisfied: false,
    note: req.optional ? "Optional — add a key to enable" : "No provider key connected",
  };
}

function checkChannel(
  req: Extract<Requirement, { kind: "channel" }>,
  channelsRaw?: ChannelStatusResult | ChannelStatusEntry[] | null,
  agentChannels?: Record<string, unknown> | null,
  agentId?: string,
): RequirementCheck {
  // Per-agent precheck: a channel paired for THIS agent (multi-account plugin,
  // synthetic platform <base>__<agent>) satisfies the requirement even when the
  // global channels namespace is empty. Shape:
  //   agentChannels[agentId].channels[<base>].accounts[] (each has running/
  //   configured/enabled/lastError).
  if (agentChannels && agentId) {
    const forAgent = agentChannels[agentId] as
      | { channels?: Record<string, { accounts?: Array<Record<string, unknown>> }> }
      | undefined;
    const accounts = forAgent?.channels?.[req.channel]?.accounts ?? [];
    const live = accounts.find(
      (a) =>
        a &&
        (a.running === true || a.configured === true || a.enabled === true) &&
        !a.lastError,
    );
    if (live) {
      return {
        requirement: req,
        satisfied: true,
        note: "Connected (this agent's account)",
      };
    }
  }
  // Tolerant normalizer — bridge may return [], {channels: []},
  // {channels: {telegram: {...}}}, or null. Default to empty list.
  let list: ChannelStatusEntry[] = [];
  if (Array.isArray(channelsRaw)) {
    list = channelsRaw;
  } else if (channelsRaw && typeof channelsRaw === "object") {
    const inner = (channelsRaw as ChannelStatusResult).channels;
    if (Array.isArray(inner)) {
      list = inner;
    } else if (inner && typeof inner === "object") {
      list = Object.entries(inner).map(([channel, v]) => ({
        channel,
        ...((v as Record<string, unknown>) ?? {}),
      }) as ChannelStatusEntry);
    }
  }

  const entry = list.find((c) => c && c.channel === req.channel);
  if (!entry) {
    return {
      requirement: req,
      satisfied: false,
      note: "Channel not connected — open the Channels tab",
    };
  }

  // Polling-mode channels (Telegram/Discord polling) won't have `connected`
  // field set; running + no lastError is the signal they work.
  const isRunning = entry.running === true;
  const hasExplicitConnected = entry.connected === true;
  const hasExplicitDisconnected = entry.connected === false;
  const isConfigured = entry.configured !== false;
  const noError = !entry.lastError;

  if (hasExplicitDisconnected) {
    return {
      requirement: req,
      satisfied: false,
      note: "Disconnected — reconnect in the Channels tab",
    };
  }

  if ((hasExplicitConnected || (isRunning && noError)) && isConfigured) {
    return {
      requirement: req,
      satisfied: true,
      note: `Connected${entry.identity ? ` as ${entry.identity}` : ""}`,
    };
  }

  return {
    requirement: req,
    satisfied: false,
    note: entry.lastError ?? "Channel not logged in",
  };
}

function checkMcpServer(
  req: Extract<Requirement, { kind: "mcp-server" }>,
  mcp?: McpListResult | null,
): RequirementCheck {
  const servers = mcp?.servers ?? [];
  const entry = servers.find((s) => s.name === req.name);
  if (!entry) {
    return {
      requirement: req,
      satisfied: false,
      note: "Connector not installed — add it in the Plugins & Connectors tab",
    };
  }
  if (!entry.enabled) {
    return {
      requirement: req,
      satisfied: false,
      note: "Connector installed but disabled — turn it on first",
    };
  }
  return {
    requirement: req,
    satisfied: true,
    note: "Connector active",
  };
}

/* ── Display helpers ──────────────────────────────────────────────── */

export function readinessBadgeTone(status: RequirementStatus): {
  dot: string;
  text: string;
  bg: string;
  border: string;
  label: string;
} {
  switch (status) {
    case "ready":
      return {
        dot: "bg-emerald-400",
        text: "text-emerald-200",
        bg: "bg-emerald-400/10",
        border: "border-emerald-400/30",
        label: "Ready",
      };
    case "setup-needed":
      return {
        dot: "bg-amber-400",
        text: "text-amber-200",
        bg: "bg-amber-400/10",
        border: "border-amber-400/30",
        label: "Setup needed",
      };
    case "blocked":
      return {
        dot: "bg-red-500",
        text: "text-red-200",
        bg: "bg-red-500/10",
        border: "border-red-500/30",
        label: "Blocked",
      };
    case "internal":
      return {
        dot: "bg-white/30",
        text: "text-white/55",
        bg: "bg-white/[0.03]",
        border: "border-white/10",
        label: "Internal",
      };
  }
}
