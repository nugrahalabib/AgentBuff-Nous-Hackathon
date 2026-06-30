/**
 * Agent tab helpers — wire types (bridge parity) + friendly Bahasa labels.
 *
 * Bridge source of truth verified 2026-05-26:
 *   - docker/hermes-bridge/agents_handler.py (agents.* CRUD + clone + skill.set)
 *   - docker/hermes-bridge/tools_handler.py (tools.catalog + tools.effective)
 *   - docker/hermes-bridge/skills_extras.py (skills.update + models.authStatus)
 *   - docker/hermes-bridge/agents_memory.py (agents.memory.* structured CRUD)
 *   - docker/hermes-bridge/agents_templates.py (agents.template.list/instantiate)
 *   - docker/hermes-bridge/agents_archive.py (agents.export + agents.import)
 *   - docker/hermes-bridge/agents_describer.py (agents.describe via LLM)
 *
 * Don't shorten field names — bridge validates strict shape.
 */

/* ── Agent shapes ─────────────────────────────────────────────────────── */

export type AgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type AgentAuxTask = { provider?: string; model?: string };

export type AgentModel = {
  primary?: string;
  // Fallback chain as bare model-ids (UI shape). Bridge resolves provider per
  // entry + writes the REAL engine field `fallback_providers`.
  fallbacks?: string[];
  // Provider slug of the group the model was picked from. Disambiguates models
  // that exist in multiple provider groups (e.g. "gpt-5.4" under openai-codex
  // AND openai), so the bridge routes to the EXACT provider the user chose.
  providerSlug?: string;
  // Per-task auxiliary models (auxiliary.<task>); provider "auto" / empty model
  // = use the agent's main model for that side task.
  auxiliary?: Record<string, AgentAuxTask>;
  // Context-window override (model_context_length); 0 = auto-detect.
  contextLength?: number;
};

export type AgentRow = {
  id: string;
  name?: string;
  identity?: AgentIdentity;
  workspace?: string;
  model?: AgentModel & { provider?: string };
  description?: string;
  description_auto?: boolean;
  default?: boolean;
  active?: boolean;
  skills?: string[];
  skillCount?: number;
  hasEnv?: boolean;
  hasSoul?: boolean;
  hasMemory?: boolean;
  gatewayRunning?: boolean;
  templateId?: string;
  templateUseCase?: string;
  cloned_from?: string;
  imported_from?: string;
};

export type AgentsListResult = {
  defaultId: string;
  activeId?: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: AgentRow[];
};

export type AgentFileEntry = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentsFilesListResult = {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
};

export type AgentsFilesGetResult = {
  agentId: string;
  workspace: string;
  file: AgentFileEntry & { content: string };
};

/* ── Models catalog ──────────────────────────────────────────────────── */

export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type ModelsListResult = {
  models: ModelChoice[];
};

export type ModelAuthStatus = "ok" | "expiring" | "expired" | "missing" | "static";

export type ModelAuthProvider = {
  provider: string;
  displayName: string;
  status: ModelAuthStatus;
  expiry?: { at: number; remainingMs: number; label: string };
};

export type ModelAuthStatusResult = {
  ts: number;
  providers: ModelAuthProvider[];
};

/* ── Tools catalog + effective (REAL Hermes shape, rewrite 2026-05-26) ── */

// Replaced invented profile presets with real Hermes TOOLSET concept.
// Each "group" is a real Hermes toolset (memory, shell, mcp:xxx, etc.).
// "Bundles" are UI helpers — bulk-enable suggestions, NOT written to config.

export type ToolSource = "core" | "plugin" | "channel";

export type ToolCatalogTool = {
  id: string;
  label: string;
  description: string;
};

export type ToolCatalogGroup = {
  id: string;
  label: string;
  source: ToolSource;
  pluginId?: string;
  enabled: boolean;
  toolCount: number;
  description: string;
  tools: ToolCatalogTool[];
};

export type ToolsCatalogResult = {
  agentId: string;
  enabledCount: number;
  totalToolsets: number;
  enabledToolsets: string[] | null;
  groups: ToolCatalogGroup[];
};

export type ToolEffectiveTool = {
  id: string;
  label: string;
  description: string;
  rawDescription: string;
  source: ToolSource;
  toolset: string;
};

export type ToolEffectiveGroup = {
  id: ToolSource;
  label: string;
  source: ToolSource;
  tools: ToolEffectiveTool[];
};

export type ToolsEffectiveResult = {
  agentId: string;
  enabledCount: number;
  totalToolsets: number;
  groups: ToolEffectiveGroup[];
};

/* ── Memory structured editor ────────────────────────────────────── */

export type MemoryEntry = {
  index: number;
  content: string;
};

export type MemoryEntriesResult = {
  agentId: string;
  entries: MemoryEntry[];
  charCount: number;
  charLimit: number;
};

export type MemoryCapacityResult = {
  agentId: string;
  charCount: number;
  charLimit: number;
  percent: number;
};

export type MemoryMutResult =
  | { ok: true; entries: MemoryEntry[]; charCount: number; charLimit: number; noop?: boolean }
  | { ok: false; error: string };

/* ── Templates ───────────────────────────────────────────────────── */

export type AgentTemplate = {
  id: string;
  label: string;
  description: string;
  /** One-line routing hint shown in wizard step 1 cards. Falls back to description. */
  personaTagline?: string;
  useCase: string;
  identity: AgentIdentity;
  modelHint?: string;
  /** Number of skills the template pre-allowlists — UI shows as "N skill pre-set". */
  recommendedSkillCount?: number;
  /** Full comprehensive SOUL.md body (per-role). Bridge `agents.template.list`
   *  now returns this so the wizard can seed the real persona at step 3 and
   *  forward an edited copy to `agents.template.instantiate`. */
  soul?: string;
  /** Preset skill allowlist (skill names). Wizard pre-checks these at step 4
   *  and forwards the user's final selection on instantiate. */
  skills?: string[];
};

/* ── SOUL generator wire types ───────────────────────────────────── */

export type SoulGenerateResult =
  | { ok: true; soul: string; model: string }
  | { ok: false; reason: string };

/* ── Models picker — Hermes model.options provider grouping ──────── */

/**
 * Provider row from `model.options` (Hermes RPC). Each provider has its
 * own curated model list. Use authStatus to filter which providers have
 * usable keys.
 */
export type ModelProvider = {
  slug: string;
  name: string;
  is_current?: boolean;
  is_user_defined?: boolean;
  models: string[];
  total_models?: number;
  source?: string;
  warning?: string;
};

export type ModelOptionsResult = {
  providers: ModelProvider[];
  model?: string;
  provider?: string;
};

export type AgentTemplateListResult = {
  templates: AgentTemplate[];
};

/* ── Export / Import ─────────────────────────────────────────────── */

export type AgentExportResult = {
  agentId: string;
  filename: string;
  base64: string;
  sizeBytes: number;
  sha256Prefix: string;
  includeMemory: boolean;
};

export type AgentImportResult = {
  agentId: string;
  profile: AgentRow;
  importedFiles: string[];
  fromManifest: Record<string, unknown>;
};

/* ── Plugins ──────────────────────────────────────────────────────── */

export type PluginSource =
  | "user"
  | "bundled"
  | "project"
  | "entrypoint"
  | "unknown";

export type PluginRow = {
  key: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: string;
  source: PluginSource;
  enabled: boolean;
  explicitlyEnabled: boolean;
  explicitlyDisabled: boolean;
  providesTools: string[];
  providesHooks: string[];
  requiresEnv: Array<{ name: string; optional: boolean; hint?: string }>;
  toolsRegistered: number;
  hooksRegistered: number;
  commandsRegistered: number;
  loadError?: string | null;
  manifestPath?: string | null;
  pluginPath?: string | null;
  hasDashboard: boolean;
  skillFiles: number;
};

export type PluginsListResult = {
  plugins: PluginRow[];
  total: number;
  enabledCount: number;
  userInstalledCount: number;
  bundledCount: number;
  hasErrors: boolean;
};

/* ── MCP Connector ───────────────────────────────────────────────── */

export type McpTransport = "http" | "stdio";

export type McpServerRow = {
  name: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  auth?: "oauth" | "header" | null;
  enabled: boolean;
  enabledTools?: string[] | null;
  raw?: Record<string, unknown>;
};

export type McpListResult = {
  servers: McpServerRow[];
  total: number;
  enabledCount: number;
};

export type McpPresetEnvVar = {
  name: string;
  hint?: string;
  required: boolean;
};

export type McpPreset = {
  id: string;
  label: string;
  labelId: string;
  description: string;
  category: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  envVars: McpPresetEnvVar[];
  icon: string;
  popularity: number;
};

export type McpPresetsResult = {
  presets: McpPreset[];
  total: number;
  categories: string[];
};

export type McpTestResult = {
  name: string;
  ok: boolean;
  toolCount?: number | null;
  output?: string;
  error?: string | null;
};

/* ── Mode Pemula vs Pro ──────────────────────────────────────────── */

export type AgentUiMode = "pemula" | "pro";

/* ── Describe ────────────────────────────────────────────────────── */

export type AgentDescribeResult =
  | {
      ok: true;
      description: string;
      autoFlag: boolean;
      profile?: AgentRow;
    }
  | {
      ok: false;
      reason: string;
      description?: string;
      autoFlag?: boolean;
    };

/* ── Skills catalog ─────────────────────────────────────────────────── */

export type SkillRequirement = {
  bins?: string[];
  env?: string[];
};

export type SkillConfigCheck = {
  path?: string;
  ok: boolean;
  message?: string;
};

export type SkillInstallOption = {
  kind?: string;
  label?: string;
  bin?: string;
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  /** True when an agent authored this skill itself during a session (not a
   *  bundled/seeded builtin). Drives the dedicated "Buatan Agen" tab + the
   *  delete affordance. */
  agentCreated?: boolean;
  /** Usage metadata for agent-created skills (epoch ms / count). */
  createdAtMs?: number | null;
  lastUsedAtMs?: number | null;
  useCount?: number;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: SkillRequirement;
  missing: SkillRequirement;
  configChecks: SkillConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

/* ── Config patch ──────────────────────────────────────────────────── */

export type ConfigGetResult = {
  hash: string;
  config: Record<string, unknown>;
  path: string;
};

export type ConfigPatchParams = {
  baseHash: string;
  raw: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
};

export type ConfigPatchResult = {
  ok: true;
  noop?: boolean;
  path: string;
  config: Record<string, unknown>;
  restart?: Record<string, unknown>;
  sentinel?: Record<string, unknown>;
};

/* ── Workspace file friendly labels (Bahasa) ─────────────────────── */

export type AgentFileMeta = {
  filename: string;
  title: string;
  subtitle: string;
  icon: "user" | "scroll" | "heart" | "wrench" | "info" | "pulse" | "rocket" | "brain";
  tone: "cyan" | "fuchsia" | "indigo" | "emerald" | "amber" | "rose";
  optional?: boolean;
};

// REAL Hermes-native file layout (verified 2026-05-26 against
// hermes-desktop-main/src/main/{memory,soul}.ts):
//   - <profile>/SOUL.md
//   - <profile>/memories/MEMORY.md
//   - <profile>/memories/USER.md
//
// Other files surfaced before (IDENTITY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md,
// BOOTSTRAP.md, RUTINITAS.md) were AgentBuff inventions that the engine never
// read. They've been removed from the UI to stop misleading users.
export const AGENT_FILE_META: Record<string, AgentFileMeta> = {
  "SOUL.md": {
    filename: "SOUL.md",
    title: "Soul",
    subtitle: "Core persona + brand guardrails. Engine reads this every session.",
    icon: "heart",
    tone: "fuchsia",
  },
  "memories/MEMORY.md": {
    filename: "memories/MEMORY.md",
    title: "Long-Term Memory",
    subtitle: "Persistent notes per agent. Engine reads and can update this itself.",
    icon: "brain",
    tone: "indigo",
  },
  "memories/USER.md": {
    filename: "memories/USER.md",
    title: "About You",
    subtitle: "Chief profile — name, timezone, preferences. Max 1375 chars.",
    icon: "info",
    tone: "amber",
  },
};

/** Order in which the Persona file rail surfaces real Hermes files. */
export const KNOWN_FILE_ORDER: string[] = [
  "SOUL.md",
  "memories/MEMORY.md",
  "memories/USER.md",
];

/* ── Util ─────────────────────────────────────────────────────────── */

export function getAgentDisplayName(agent: AgentRow): string {
  return agent.identity?.name || agent.name || agent.id;
}

export function getAgentEmoji(agent: AgentRow): string | undefined {
  return agent.identity?.emoji;
}

/** Sanitize a free-text agent name into a valid agentId path component.
 *  Mirrors engine `normalizeAgentId` heuristic (lowercase + safe chars). */
export function suggestAgentIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}

/** Suggest workspace path from agent name. Engine convention: `./<name>` or
 *  a bare folder name resolved against the Hermes profile root. */
export function suggestWorkspaceFromName(name: string): string {
  const id = suggestAgentIdFromName(name);
  if (!id) return "";
  return `agents/${id}`;
}

/** Pool of suggested emojis when user doesn't pick one. Mass-market vibes. */
export const SUGGESTED_EMOJIS = [
  "🤖",
  "🧠",
  "⚡",
  "🦾",
  "🚀",
  "🛡️",
  "🌟",
  "🔮",
  "🎯",
  "🦊",
  "🐉",
  "🦅",
  "🐺",
  "🦁",
  "🐯",
  "🦉",
  "🦋",
  "🐙",
  "🌊",
  "🔥",
  "💎",
  "✨",
  "🌙",
  "☀️",
];

export function randomEmoji(): string {
  return SUGGESTED_EMOJIS[
    Math.floor(Math.random() * SUGGESTED_EMOJIS.length)
  ];
}

/** Format model label terbaca dari catalog entry. */
export function formatModelLabel(m: ModelChoice): string {
  if (m.alias) return `${m.alias} · ${m.provider}`;
  return `${m.name} · ${m.provider}`;
}

/** Cari catalog entry by id (the wire-level model id string). */
export function findModelById(
  list: ModelChoice[] | undefined,
  id: string | undefined | null,
): ModelChoice | null {
  if (!id || !list) return null;
  return list.find((m) => m.id === id) ?? null;
}

/** Bytes → KB/MB friendly. */
export function formatBytes(b?: number): string {
  if (!b || b < 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Relative timestamp from ms epoch — friendly Bahasa. */
export function formatRelative(ms?: number, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} day${Math.round(diff / 86_400_000) === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Provider auth status → tone color. */
export function providerStatusTone(status: ModelAuthStatus): {
  tone: "emerald" | "amber" | "red" | "indigo";
  label: string;
} {
  if (status === "ok") return { tone: "emerald", label: "Active" };
  if (status === "expiring") return { tone: "amber", label: "Expiring soon" };
  if (status === "expired") return { tone: "red", label: "Expired" };
  if (status === "missing") return { tone: "red", label: "Not connected" };
  return { tone: "indigo", label: "Static key" };
}
