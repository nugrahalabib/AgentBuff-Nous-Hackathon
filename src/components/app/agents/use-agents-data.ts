"use client";

/**
 * use-agents-data — composable hooks for fetching all agent-related data
 * from the Hermes gateway over RPC. Uses the existing `useRpc` hook from
 * `src/lib/app/use-rpc.ts` (NOT TanStack Query) — refetch is explicit.
 *
 * Why no TanStack: existing /app uses custom useRpc with status-driven
 * refetch + permanent event listener. Keep parity, avoid mixing query
 * caches across tabs.
 *
 * Mutation helpers (config.patch, agents.create/update/delete, skills
 * toggle) are exported as plain async functions — callers control busy
 * state + toast directly.
 */
import { useMemo } from "react";
import { useRpc } from "@/lib/app/use-rpc";
import { getClient } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import type {
  AgentDescribeResult,
  AgentExportResult,
  AgentImportResult,
  AgentRow,
  AgentTemplateListResult,
  AgentsListResult,
  AgentsFilesListResult,
  AgentsFilesGetResult,
  McpListResult,
  McpPresetsResult,
  McpServerRow,
  McpTestResult,
  MemoryCapacityResult,
  MemoryEntriesResult,
  MemoryMutResult,
  ModelAuthStatusResult,
  ModelOptionsResult,
  PluginRow,
  PluginsListResult,
  SkillStatusReport,
  SoulGenerateResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "./helpers";

/* ── Read-side hooks ─────────────────────────────────────────────── */

export function useAgentsList() {
  return useRpc<AgentsListResult, Record<string, never>>({
    method: "agents.list",
    params: {},
  });
}

/**
 * useModelOptions — Hermes `model.options` (via bridge `models.list`
 * passthrough) but typed as the REAL provider-grouped shape rather than
 * the legacy flat ModelChoice[] guess. Use this in places that need to
 * render provider-grouped dropdowns (wizard step 1, AiAgentsTab picker).
 *
 * Bridge `handle_models_list` forwards Hermes' `model.options` 1:1, and
 * Hermes' `build_models_payload` returns `{providers, model, provider}`.
 */
export function useModelOptions() {
  return useRpc<ModelOptionsResult, Record<string, never>>({
    method: "models.list",
    params: {},
  });
}

/**
 * generateSoulMd — call bridge `agents.soulGenerate` RPC. Used by wizard
 * step 2 "Generate" button. Returns SOUL text on success or reason on
 * failure (e.g. "no_llm_provider" when user has no API keys yet).
 */
export async function generateSoulMd(params: {
  name: string;
  brief?: string;
  persona?: string;
  channelTargets?: string[];
  tone?: string;
}): Promise<MutResult<SoulGenerateResult>> {
  try {
    const data = await requireClient().request<SoulGenerateResult>(
      "agents.soulGenerate",
      params,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export function useModelsAuthStatus() {
  return useRpc<ModelAuthStatusResult, Record<string, never>>({
    method: "models.authStatus",
    params: {},
  });
}

/**
 * Channel binding/credential status — used by the requirement resolver to
 * tell user which channels are paired vs still need login.
 *
 * Returns the raw `channels.status` response which is either an object
 * `{ channels: [...] }` OR a bare array (depends on engine version). The
 * resolver normalizes via `Array.isArray(...) ? ... : .channels`.
 */
export type ChannelStatusEntry = {
  channel: string;
  connected?: boolean;
  configured?: boolean;
  running?: boolean;
  identity?: string;
  lastError?: string | null;
};

export type ChannelStatusResult = {
  channels?: ChannelStatusEntry[];
};

export function useChannelsStatus() {
  return useRpc<ChannelStatusResult | ChannelStatusEntry[], Record<string, never>>({
    method: "channels.status",
    params: {},
  });
}

/**
 * Env var presence — bridge returns NAMES of capability-relevant env
 * vars that are set (non-empty value). Values never leave the bridge.
 * Used by capability-requirements resolver to detect setup state.
 */
export type EnvListResult = {
  presentKeys: string[];
  totalScanned: number;
};

export function useEnvList() {
  return useRpc<EnvListResult, Record<string, never>>({
    method: "env.list",
    params: {},
  });
}

export function useAgentFiles(agentId: string | null) {
  const params = useMemo(() => ({ agentId: agentId ?? "" }), [agentId]);
  return useRpc<AgentsFilesListResult, { agentId: string }>({
    method: "agents.files.list",
    params,
    enabled: !!agentId,
    deps: [agentId],
  });
}

export function useToolsCatalog(agentId: string | null) {
  const params = useMemo(
    () => ({ agentId: agentId ?? "", includePlugins: true }),
    [agentId],
  );
  return useRpc<
    ToolsCatalogResult,
    { agentId: string; includePlugins?: boolean }
  >({
    method: "tools.catalog",
    params,
    enabled: !!agentId,
    deps: [agentId],
  });
}

export function useSkillsStatus(agentId: string | null) {
  const params = useMemo(() => ({ agentId: agentId ?? "" }), [agentId]);
  return useRpc<SkillStatusReport, { agentId: string }>({
    method: "skills.status",
    params,
    enabled: !!agentId,
    deps: [agentId],
  });
}

/**
 * useSkillsStatusGlobal — same as useSkillsStatus but ALWAYS fires (no
 * agentId gate). Used by the create-agent wizard, which needs the workspace
 * skill catalog BEFORE any agent exists. Bridge `skills.status` with an empty
 * agentId returns the global allowlist view.
 */
export function useSkillsStatusGlobal() {
  return useRpc<SkillStatusReport, { agentId: string }>({
    method: "skills.status",
    params: { agentId: "" },
  });
}

/**
 * useToolsCatalogGlobal — toolset catalog for the wizard. The per-agent
 * useToolsCatalog is gated on agentId (won't fire pre-creation), so this
 * variant always fires against the "default" agent id, which the bridge
 * resolves to the workspace-wide toolset catalog. Toolsets are bundled in
 * the engine, so this section ALWAYS has content (unlike skills).
 */
export function useToolsCatalogGlobal() {
  return useRpc<
    ToolsCatalogResult,
    { agentId: string; includePlugins?: boolean }
  >({
    method: "tools.catalog",
    params: { agentId: "default", includePlugins: true },
  });
}

/* ── Mutation helpers — plain async functions ──────────────────── */

function requireClient() {
  const c = getClient();
  if (!c) throw new Error("Gateway not connected");
  return c;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof GatewayError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

export type MutResult<T = unknown> =
  | { ok: true; data: T; warning?: string }
  | { ok: false; error: string };

/**
 * createAgent — bridge `agents.create` with full preset support. All
 * optional fields (model, fallbacks, theme, skills, soul) are applied
 * atomically so the wizard doesn't need follow-up RPC calls.
 *
 * Bridge expects { id, profile, soulContent }. We build that shape
 * internally. After agents.create succeeds, we apply skills allowlist
 * via agents.skills.set (separate RPC because allowlist write needs
 * special-case skills.disabled inversion at bridge).
 */
export async function createAgent(params: {
  agentId: string;
  name: string;
  workspace?: string;
  model?: string;
  /** Provider slug of the group the model was picked from. A model id can live
   *  in MULTIPLE provider groups (e.g. "gpt-5.5" under openai-codex AND openai),
   *  so without this the bridge guesses the provider and can resolve the wrong
   *  one (or fall back to the default) → agent ends up on the wrong model. */
  providerSlug?: string;
  fallbacks?: string[];
  emoji?: string;
  theme?: string;
  avatar?: string;
  soulContent?: string;
  description?: string;
  skills?: string[];
}): Promise<MutResult<AgentRow>> {
  try {
    const identity: Record<string, unknown> = { name: params.name };
    if (params.emoji !== undefined) identity.emoji = params.emoji;
    if (params.avatar !== undefined) identity.avatar = params.avatar;
    if (params.theme !== undefined) identity.theme = params.theme;
    const profile: Record<string, unknown> = {
      name: params.name,
      identity,
    };
    if (params.workspace) profile.workspace = params.workspace;
    if (params.model || (params.fallbacks && params.fallbacks.length > 0)) {
      const modelObj: Record<string, unknown> = {};
      if (params.model) modelObj.primary = params.model;
      if (params.providerSlug) modelObj.providerSlug = params.providerSlug;
      if (params.fallbacks && params.fallbacks.length > 0)
        modelObj.fallbacks = params.fallbacks;
      profile.model = modelObj;
    }
    if (params.description) profile.description = params.description;

    const client = requireClient();
    const data = await client.request<AgentRow>("agents.create", {
      id: params.agentId,
      profile,
      soulContent: params.soulContent ?? "",
    });

    // Apply skills allowlist (separate call — bridge inverts to
    // skills.disabled and patches REAL config.yaml). Non-fatal — if it
    // fails the agent still works with default global allowlist.
    if (params.skills && params.skills.length > 0) {
      try {
        const updated = await client.request<AgentRow>("agents.skills.set", {
          agentId: data.id ?? params.agentId,
          skills: params.skills,
        });
        return { ok: true, data: updated };
      } catch (skillErr) {
        // Non-fatal: the agent exists, but the curated skill selection didn't
        // apply (transient timeout / bridge restart). Surface a warning so the
        // caller can tell the user instead of silently diverging. (Audit HIGH #8.)
        return {
          ok: true,
          data,
          warning: `Selected skills could not be applied: ${toErrorMessage(skillErr)}`,
        };
      }
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.update — full subtree variant. Call this when you need to update
 *  fields like model.fallbacks or identity.theme that require sending the
 *  whole nested object (bridge shallow merge).
 *
 *  Pass `currentProfile` so we can merge the partial into the existing
 *  identity/model subtrees and avoid nuking sibling fields. */
export async function updateAgentRich(
  agentId: string,
  currentProfile: AgentRow,
  changes: {
    name?: string;
    workspace?: string;
    description?: string;
    description_auto?: boolean;
    identity?: Partial<AgentRow["identity"]>;
    model?: Partial<NonNullable<AgentRow["model"]>>;
    skills?: string[];
    default?: boolean;
    // Per-agent auxiliary task models → bridge writes auxiliary.<task>; provider
    // "auto" (or empty model) = use the agent's main model for that side task.
    auxiliary?: Record<string, { provider?: string; model?: string }>;
    // Per-agent context-window override → bridge writes model_context_length
    // (0 = auto-detect from the model).
    modelContextLength?: number;
  },
): Promise<MutResult<AgentRow>> {
  try {
    const patch: Record<string, unknown> = {};
    if (changes.name !== undefined) patch.name = changes.name;
    if (changes.workspace !== undefined) patch.workspace = changes.workspace;
    if (changes.description !== undefined)
      patch.description = changes.description;
    if (changes.description_auto !== undefined)
      patch.description_auto = changes.description_auto;
    if (changes.skills !== undefined) patch.skills = changes.skills;
    if (changes.default !== undefined) patch.default = changes.default;
    if (changes.auxiliary !== undefined) patch.auxiliary = changes.auxiliary;
    if (changes.modelContextLength !== undefined)
      patch.modelContextLength = changes.modelContextLength;

    // Identity: merge with existing so we don't drop sibling fields.
    if (changes.identity !== undefined) {
      patch.identity = {
        ...(currentProfile.identity ?? {}),
        ...changes.identity,
      };
    }
    // Model: same — merge so changing fallbacks doesn't nuke primary.
    if (changes.model !== undefined) {
      patch.model = {
        ...(currentProfile.model ?? {}),
        ...changes.model,
      };
    }
    // NOTE: tool config goes through dedicated tools.toggle RPC now, not
    // agents.update. The bridge silently ignores tools.* fields in patches.
    const data = await requireClient().request<AgentRow>("agents.update", {
      agentId,
      patch,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.delete. */
export async function deleteAgent(params: {
  agentId: string;
}): Promise<MutResult<{ deleted: string }>> {
  try {
    // The bridge always hard-deletes the profile dir; there is no soft-delete
    // path, so the old `deleteFiles` param was vestigial (bridge ignored it).
    // Dropped to keep the TS contract honest. (Audit HIGH #12.)
    const data = await requireClient().request<{ deleted: string }>(
      "agents.delete",
      { agentId: params.agentId },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.files.get → bridge returns flat {name, content}; we normalize
 *  to the UI's nested {file:{content}} shape so callers keep working. */
export async function getAgentFile(
  agentId: string,
  name: string,
): Promise<MutResult<AgentsFilesGetResult>> {
  try {
    const raw = await requireClient().request<{
      name?: string;
      content?: string;
      // Some older bridge versions returned {file:{content}} — accept both
      file?: { content?: string };
      agentId?: string;
      workspace?: string;
      // Bridge (agents_handler.py) returns exists:false for a not-yet-created
      // file, exists:true otherwise; absent on older bridges.
      exists?: boolean;
    }>("agents.files.get", { agentId, filename: name, name });
    const content =
      (raw && typeof raw.content === "string"
        ? raw.content
        : raw?.file?.content) ?? "";
    const data: AgentsFilesGetResult = {
      agentId: raw?.agentId ?? agentId,
      workspace: raw?.workspace ?? "",
      file: {
        name: raw?.name ?? name,
        path: name,
        // exists:false (bridge) = genuinely not created yet. Absent on older
        // bridges → false (assume present), matching prior behavior. The old
        // `!raw` was always false since raw is always the response object.
        missing: raw?.exists === false,
        content,
      },
    };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.files.set — bridge expects { agentId, filename, content }. */
export async function setAgentFile(
  agentId: string,
  name: string,
  content: string,
): Promise<MutResult<unknown>> {
  try {
    const data = await requireClient().request("agents.files.set", {
      agentId,
      filename: name,
      name,
      content,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** tools.toggle — enable/disable a single Hermes toolset for an agent.
 *  Writes to REAL config.yaml::platform_toolsets.cli of that profile. */
export async function toggleToolset(
  agentId: string,
  toolset: string,
  enable: boolean,
): Promise<MutResult<{ agentId: string; toolset: string; enabled: boolean }>> {
  try {
    const data = await requireClient().request<{
      ok: true;
      agentId: string;
      toolset: string;
      enabled: boolean;
    }>("tools.toggle", { agentId, toolset, enable });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** tools.effective — agent's resolved tool set. sessionKey optional (bridge
 *  reads agent profile to compute, no real session required). */
export async function getToolsEffective(
  agentId: string,
  sessionKey?: string,
): Promise<MutResult<ToolsEffectiveResult>> {
  try {
    const data = await requireClient().request<ToolsEffectiveResult>(
      "tools.effective",
      sessionKey ? { agentId, sessionKey } : { agentId },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/* ── Tier 2 — Clone / Describe / Templates / Export / Import / Reset / Skill allowlist ── */

/** agents.clone — copy source agent into new id. */
export async function cloneAgent(params: {
  sourceId: string;
  newId: string;
  name?: string;
  emoji?: string;
}): Promise<MutResult<AgentRow>> {
  try {
    const data = await requireClient().request<AgentRow>("agents.clone", params);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.describe — invoke LLM auto-describe; persists to profile. */
export async function describeAgent(
  agentId: string,
  overwrite = false,
): Promise<MutResult<AgentDescribeResult>> {
  try {
    const data = await requireClient().request<AgentDescribeResult>(
      "agents.describe",
      { agentId, overwrite },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.export — returns base64 + filename for download. */
export async function exportAgent(
  agentId: string,
  includeMemory = true,
): Promise<MutResult<AgentExportResult>> {
  try {
    const data = await requireClient().request<AgentExportResult>(
      "agents.export",
      { agentId, includeMemory },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.import — restore from base64 tar.gz produced by export. */
export async function importAgent(params: {
  base64: string;
  newAgentId?: string;
  overwrite?: boolean;
}): Promise<MutResult<AgentImportResult>> {
  try {
    const data = await requireClient().request<AgentImportResult>(
      "agents.import",
      params,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.files.reset — restore a file to its AgentBuff default template
 *  (currently SOUL.md). */
export async function resetAgentFile(
  agentId: string,
  filename: string,
): Promise<MutResult<{ name: string; size: number }>> {
  try {
    const data = await requireClient().request<{ name: string; size: number }>(
      "agents.files.reset",
      { agentId, filename },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** agents.skills.set — overwrite the agent's skill allowlist. */
export async function setAgentSkillAllowlist(
  agentId: string,
  skills: string[],
): Promise<MutResult<AgentRow>> {
  try {
    const data = await requireClient().request<AgentRow>("agents.skills.set", {
      agentId,
      skills,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/**
 * setAgentSkillDisabled — toggle ONE skill's per-agent disabled state directly
 * in the engine's skills.disabled list (bridge `agents.skills.setDisabled`),
 * bypassing the synthetic allowlist whitelist. Used by the "Buatan Agen" tab so
 * agent-created skills reflect/control the REAL engine state.
 */
export async function setAgentSkillDisabled(
  agentId: string,
  name: string,
  disabled: boolean,
): Promise<MutResult<{ ok: boolean; name: string; disabled: boolean }>> {
  try {
    const data = await requireClient().request<{
      ok: boolean;
      name: string;
      disabled: boolean;
    }>("agents.skills.setDisabled", { agentId, name, disabled });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/**
 * resetAgentSkillsToFactory — restore the factory skill baseline via bridge
 * `agents.skills.resetToFactory`: builtin (vanilla) skills back ON, every
 * non-builtin skill (bought / agent-created) turned OFF but KEPT. The user can
 * still toggle manually afterwards.
 */
export async function resetAgentSkillsToFactory(
  agentId: string,
): Promise<MutResult<{ ok: boolean; builtinOn: number; nonBuiltinOff: number }>> {
  try {
    const data = await requireClient().request<{
      ok: boolean;
      builtinOn: number;
      nonBuiltinOff: number;
    }>("agents.skills.resetToFactory", { agentId });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/**
 * deleteAgentCreatedSkill — hard-delete an AGENT-AUTHORED skill via the bridge
 * `skills.deleteAgentCreated`. The bridge refuses to delete bundled/builtin
 * skills (they're protected by the builtin baseline), so this is only valid for
 * skills the agent created itself.
 */
export async function deleteAgentCreatedSkill(
  name: string,
): Promise<MutResult<{ ok: boolean; name: string; removedDir: boolean }>> {
  try {
    const data = await requireClient().request<{
      ok: boolean;
      name: string;
      removedDir: boolean;
    }>("skills.deleteAgentCreated", { name });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/* ── Templates ───────────────────────────────────────────────────── */

export function useAgentTemplates() {
  return useRpc<AgentTemplateListResult, Record<string, never>>({
    method: "agents.template.list",
    params: {},
  });
}

/**
 * instantiateAgentTemplate — bridge `agents.template.instantiate`.
 *
 * The bridge now accepts override fields on top of the base template so the
 * wizard can forward the user's edited identity + SOUL + model + skills.
 * Every override is optional; omitting one falls back to the template preset:
 *   - name/emoji/theme → identity overrides
 *   - soulContent      → overrides the template's bundled SOUL.md
 *   - model            → overrides the template's modelHint
 *   - skills           → overrides the preset skill allowlist (a list, even
 *                        empty, is honored — empty = "no skill restriction").
 */
export async function instantiateAgentTemplate(params: {
  templateId: string;
  newAgentId: string;
  name?: string;
  emoji?: string;
  theme?: string;
  /** Role/persona tagline → new profile sidecar `description` (override). */
  description?: string;
  soulContent?: string;
  model?: string;
  /** Provider slug for `model` (disambiguates multi-provider model ids). */
  providerSlug?: string;
  /** Fallback model ids → new profile config.yaml `model.fallbacks`. */
  fallbacks?: string[];
  skills?: string[];
}): Promise<MutResult<AgentRow>> {
  try {
    const payload: Record<string, unknown> = {
      templateId: params.templateId,
      newAgentId: params.newAgentId,
    };
    if (params.name !== undefined) payload.name = params.name;
    if (params.emoji !== undefined) payload.emoji = params.emoji;
    if (params.theme !== undefined) payload.theme = params.theme;
    if (params.description !== undefined) payload.description = params.description;
    if (params.soulContent !== undefined) payload.soulContent = params.soulContent;
    if (params.model !== undefined) payload.model = params.model;
    if (params.providerSlug !== undefined) payload.providerSlug = params.providerSlug;
    if (params.fallbacks !== undefined) payload.fallbacks = params.fallbacks;
    if (params.skills !== undefined) payload.skills = params.skills;
    const data = await requireClient().request<AgentRow>(
      "agents.template.instantiate",
      payload,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/* ── Memory structured editor ────────────────────────────────────── */

export function useAgentMemoryEntries(agentId: string | null) {
  const params = useMemo(() => ({ agentId: agentId ?? "" }), [agentId]);
  return useRpc<MemoryEntriesResult, { agentId: string }>({
    method: "agents.memory.entries",
    params,
    enabled: !!agentId,
    deps: [agentId],
  });
}

export async function addMemoryEntry(
  agentId: string,
  content: string,
): Promise<MemoryMutResult> {
  try {
    return (await requireClient().request<MemoryMutResult>(
      "agents.memory.addEntry",
      { agentId, content },
    ));
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function updateMemoryEntry(
  agentId: string,
  index: number,
  content: string,
): Promise<MemoryMutResult> {
  try {
    return (await requireClient().request<MemoryMutResult>(
      "agents.memory.updateEntry",
      { agentId, index, content },
    ));
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function removeMemoryEntry(
  agentId: string,
  index: number,
): Promise<MemoryMutResult> {
  try {
    return (await requireClient().request<MemoryMutResult>(
      "agents.memory.removeEntry",
      { agentId, index },
    ));
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function getMemoryCapacity(
  agentId: string,
): Promise<MutResult<MemoryCapacityResult>> {
  try {
    const data = await requireClient().request<MemoryCapacityResult>(
      "agents.memory.capacity",
      { agentId },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/* ── Plugins ──────────────────────────────────────────────────────── */

export function usePluginsList() {
  return useRpc<PluginsListResult, Record<string, never>>({
    method: "plugins.list",
    params: {},
  });
}

export async function getPluginInfo(
  key: string,
): Promise<MutResult<PluginRow>> {
  try {
    const data = await requireClient().request<PluginRow>("plugins.info", {
      key,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function enablePlugin(
  key: string,
): Promise<MutResult<PluginRow>> {
  try {
    const data = await requireClient().request<PluginRow>("plugins.enable", {
      key,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function disablePlugin(
  key: string,
): Promise<MutResult<PluginRow>> {
  try {
    const data = await requireClient().request<PluginRow>("plugins.disable", {
      key,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function removePlugin(
  key: string,
): Promise<MutResult<{ removed: string }>> {
  try {
    const data = await requireClient().request<{ removed: string }>(
      "plugins.remove",
      { key },
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function rediscoverPlugins(): Promise<
  MutResult<{ ok: true; total: number; enabled: number }>
> {
  try {
    const data = await requireClient().request<{
      ok: true;
      total: number;
      enabled: number;
    }>("plugins.discover", {});
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/* ── MCP Connectors ──────────────────────────────────────────────── */

export function useMcpList() {
  return useRpc<McpListResult, Record<string, never>>({
    method: "mcp.list",
    params: {},
  });
}

export function useMcpPresets() {
  return useRpc<McpPresetsResult, Record<string, never>>({
    method: "mcp.presets",
    params: {},
  });
}

export async function getMcpInfo(name: string): Promise<MutResult<McpServerRow>> {
  try {
    const data = await requireClient().request<McpServerRow>("mcp.info", { name });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function addMcpServer(params: {
  name: string;
  presetId?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: "oauth" | "header" | null;
}): Promise<MutResult<McpServerRow>> {
  try {
    const data = await requireClient().request<McpServerRow>("mcp.add", params);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function removeMcpServer(
  name: string,
): Promise<MutResult<{ removed: string }>> {
  try {
    const data = await requireClient().request<{ removed: string }>("mcp.remove", {
      name,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function testMcpServer(name: string): Promise<MutResult<McpTestResult>> {
  try {
    const data = await requireClient().request<McpTestResult>("mcp.test", { name });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function configureMcpServer(params: {
  name: string;
  enabledTools?: string[];
  enabled?: boolean;
}): Promise<MutResult<McpServerRow>> {
  try {
    const data = await requireClient().request<McpServerRow>(
      "mcp.configure",
      params,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}
