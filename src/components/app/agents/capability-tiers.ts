/**
 * capability-tiers.ts — the single source of truth for a capability's TIER.
 *
 * Chief's rule (2026-05-31):
 *   - ESSENTIAL  → core agent plumbing that EVERY agent must always have.
 *                  Rendered ON + LOCKED (cannot be turned off). Sorted to top.
 *   - LOCKED     → needs external setup that isn't satisfied yet (resolved at
 *                  runtime via resolveReadiness on the vocab `requires`). OFF +
 *                  locked until configured. Sorted to bottom.
 *   - READY      → everything else: works out of the box, free to toggle on/off.
 *
 * This file ONLY decides the essential set (a static fact about the engine).
 * The locked/ready split is data-driven from live requirement checks, so it is
 * computed in the panel/wizard, not here.
 *
 * Engine is NOT modified — this is pure portal UI policy. The bare keys below
 * match `bareKey()` output (brand prefix already stripped), so both the native
 * id (`skills`) and the plugin id (`agentbuff-cli`) resolve to the same tier.
 */

import { bareKey } from "./vocab";
// (HIDDEN_SKILLS / isHiddenSkill defined below — used by panel + wizard skill picker)

/**
 * Runtime admin overrides (D13 opt-in). The hardcoded sets above are EMPTY by
 * Chief's decision ("mirror engine, nothing hidden/forced"). This store lets an
 * admin OPTIONALLY hide/lock specific skills/tools without reversing that default
 * — it starts empty, so before hydration (and if an admin sets nothing) behavior
 * is exactly today's. Hydrated once on /app load from /api/app/capability-policy
 * via setCapabilityPolicy(). Keys are stored lowercased; predicates also check
 * the bareKey() form so brand variants resolve.
 */
const runtimeOverrides = {
  hiddenSkills: new Set<string>(),
  hiddenToolsets: new Set<string>(),
  essentialToolsets: new Set<string>(),
  essentialSkills: new Set<string>(),
};

export type CapabilityPolicy = {
  hiddenSkills: string[];
  hiddenToolsets: string[];
  essentialToolsets: string[];
  essentialSkills: string[];
};

const toSet = (arr: string[] | undefined): Set<string> =>
  new Set((arr ?? []).map((s) => (s || "").trim().toLowerCase()).filter(Boolean));

/** Replace the runtime override sets (admin policy). Empty arrays = no override. */
export function setCapabilityPolicy(p: Partial<CapabilityPolicy>): void {
  if (p.hiddenSkills) runtimeOverrides.hiddenSkills = toSet(p.hiddenSkills);
  if (p.hiddenToolsets) runtimeOverrides.hiddenToolsets = toSet(p.hiddenToolsets);
  if (p.essentialToolsets) runtimeOverrides.essentialToolsets = toSet(p.essentialToolsets);
  if (p.essentialSkills) runtimeOverrides.essentialSkills = toSet(p.essentialSkills);
}

function overrideHas(set: Set<string>, id: string): boolean {
  if (set.size === 0) return false;
  const lower = (id || "").toLowerCase();
  const bare = bareKey(id);
  return (
    set.has(lower) ||
    set.has(bare) ||
    set.has(bare.replace(/-/g, "_")) ||
    set.has(bare.replace(/_/g, "-"))
  );
}

/**
 * ESSENTIAL toolsets — always-on, locked-on. Two groups:
 *  1. Core agent plumbing the agent literally can't function well without
 *     (file/memory/skills/todo/clarify/delegation/session_search).
 *  2. The developer/system runtime Chief asked to keep visible but locked-on
 *     (cli/gateway/api-server/safe/debugging/browser).
 * All keys are BARE (no agentbuff-/hermes- prefix).
 */
// EMPTIED 2026-06-03 (Chief: "peraturan wajib lock-on/off hilangin — skill/tool
// yang on/off MURNI ngikut engine, gak ada yang dipaksa"). Nothing is forced
// always-on anymore; every toolset is freely toggleable and mirrors the engine
// exactly (no auto-reconcile writes). Restore the old contents to re-enable the
// essential lock-on policy.
export const ESSENTIAL_TOOLSETS: ReadonlySet<string> = new Set([]);

export type CapabilityTier = "essential" | "ready" | "locked";

/**
 * Decide a toolset's tier given whether its requirement is currently met.
 * `locked` (the runtime readiness verdict) is supplied by the caller, who has
 * the live requirement data. Essential always wins — an essential toolset is
 * never locked-off even if some optional dep looks unmet.
 */
export function toolsetTier(
  _toolsetId: string,
  _lockedByRequirement: boolean,
): CapabilityTier {
  // 2026-06-03 (Chief: no forced lock-on/off). Every toolset is freely
  // toggleable and mirrors the engine — nothing is essential-locked-on or
  // requirement-locked-off anymore.
  return "ready";
}

/** True if this toolset id (any brand variant) is essential / always-on. */
export function isEssentialToolset(toolsetId: string): boolean {
  const bare = bareKey(toolsetId);
  return (
    ESSENTIAL_TOOLSETS.has(bare) ||
    ESSENTIAL_TOOLSETS.has(bare.replace(/-/g, "_")) ||
    ESSENTIAL_TOOLSETS.has(bare.replace(/_/g, "-")) ||
    ESSENTIAL_TOOLSETS.has(toolsetId.toLowerCase()) ||
    overrideHas(runtimeOverrides.essentialToolsets, toolsetId)
  );
}

/**
 * ESSENTIAL skills — platform-critical skills every agent must keep ON + LOCKED
 * (Chief 2026-06-01: "skill skill yang sangat penting... bikin lock always on").
 *  - hermes-agent: AgentBuff self-knowledge + website navigation (so the agent
 *    can answer "kamu siapa / di mana setting X" and point users to the right
 *    tab). Engine key is `hermes-agent`; the UI sees the brand-scrubbed `Buff`.
 *  - hermes-agent-skill-authoring: lets the agent create/extend its own skills.
 *  - debugging-hermes-tui-commands: lets the agent self-diagnose.
 *
 * Both name forms are listed because skills.status emits the BRAND-SCRUBBED name
 * (Buff / Buff-skill-authoring / debugging-agentbuff-tui-commands) while the raw
 * engine keys (hermes-*) appear in config.yaml::skills.disabled. isEssentialSkill
 * lowercases before matching, so list every lowercase variant.
 */
// EMPTIED 2026-06-03 (Chief: no forced lock-on). Skills mirror the engine.
export const ESSENTIAL_SKILLS: ReadonlySet<string> = new Set<string>([]);

export function isEssentialSkill(skillName: string): boolean {
  const lower = (skillName || "").toLowerCase();
  return (
    ESSENTIAL_SKILLS.has(lower) ||
    ESSENTIAL_SKILLS.has(bareKey(skillName)) ||
    overrideHas(runtimeOverrides.essentialSkills, skillName)
  );
}

/**
 * PROTECTED plugins — AgentBuff's own bundled plugins that power core product
 * features. Always on; can never be turned off or removed from the UI
 * (Chief 2026-05-31: "plugin yang ga boleh mati karena bawaan dari kita").
 * Bare keys (brand prefix already stripped by bareKey).
 */
// RESTORED 2026-06-03 (Chief: "plugin ini WAJIB nyala untuk setiap agen & user").
// AgentBuff's own core plugins — always on, can never be turned off / removed in
// the UI. (Tools/skills stay freely toggleable — only plugins are mandatory.)
export const PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  "multichannel",
  "multimodal",
]);

/** True if this plugin (any brand variant) is an AgentBuff-bundled core plugin. */
export function isProtectedPlugin(pluginKey: string): boolean {
  const bare = bareKey(pluginKey);
  return (
    PROTECTED_PLUGINS.has(bare) ||
    PROTECTED_PLUGINS.has((pluginKey || "").toLowerCase())
  );
}

/**
 * HIDDEN toolsets — niche / foreign / hard-to-configure messaging channels +
 * doc connectors that confuse mass-market users in the "Kemampuan Utama" tab
 * (Chief 2026-06-01: "hide dulu, biar user biasa nggak bingung"). These are
 * NOT deleted from the engine — just not rendered in the capability picker
 * (panel + create-agent wizard). Channels that genuinely matter are paired in
 * the Saluran tab instead. Bare keys (brand prefix stripped by bareKey).
 */
// EMPTIED 2026-06-03 (Chief: show everything, nothing hidden — mirror engine).
export const HIDDEN_TOOLSETS: ReadonlySet<string> = new Set([]);

/** True if this toolset (any brand variant) should be hidden from the UI. */
export function isHiddenToolset(toolsetId: string): boolean {
  const bare = bareKey(toolsetId);
  return (
    HIDDEN_TOOLSETS.has(bare) ||
    HIDDEN_TOOLSETS.has(bare.replace(/-/g, "_")) ||
    HIDDEN_TOOLSETS.has(bare.replace(/_/g, "-")) ||
    HIDDEN_TOOLSETS.has((toolsetId || "").toLowerCase()) ||
    overrideHas(runtimeOverrides.hiddenToolsets, toolsetId)
  );
}

/**
 * HIDDEN skills — bundled Hermes skills too technical / niche / internal for
 * mass-market AgentBuff users (Chief 2026-06-01: hide MLOps/training,
 * developer/coding, internal+brand-leak, and blockchain/research/gaming/MCP
 * niche). NOT deleted from the engine — just not shown in the Skill Khusus
 * picker. Lowercased skill names (matches the brand-scrubbed `name` that
 * skills.status returns; raw hermes/openclaw keys included as a safety net).
 */
// EMPTIED 2026-06-03 (Chief: show everything, nothing hidden — mirror engine).
export const HIDDEN_SKILLS: ReadonlySet<string> = new Set([]);

/** True if this skill should be hidden from the Skill Khusus picker. */
export function isHiddenSkill(skillName: string): boolean {
  const lower = (skillName || "").toLowerCase();
  return (
    HIDDEN_SKILLS.has(lower) ||
    HIDDEN_SKILLS.has(bareKey(skillName)) ||
    overrideHas(runtimeOverrides.hiddenSkills, skillName)
  );
}
