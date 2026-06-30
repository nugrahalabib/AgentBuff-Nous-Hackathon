// Capability policy (D13 opt-in admin override). Optional admin-set lists of
// skills/toolsets to hide or lock in the /app agent capability picker. ALL DEFAULT
// EMPTY — an unset policy means today's behavior (mirror engine, nothing
// hidden/forced; Chief 2026-06-03). The client hydrates these into the predicate
// store in capability-tiers.ts via setCapabilityPolicy(). PROTECTED_PLUGINS stays
// hardcoded (mandatory plugins are a safety control, not an admin knob).
import { resolveSetting } from "@/lib/admin/settings";

export type CapabilityPolicy = {
  hiddenSkills: string[];
  hiddenToolsets: string[];
  essentialToolsets: string[];
  essentialSkills: string[];
};

export const CAPABILITY_KEYS = {
  hiddenSkills: "capability.hidden.skills",
  hiddenToolsets: "capability.hidden.toolsets",
  essentialToolsets: "capability.essential.toolsets",
  essentialSkills: "capability.essential.skills",
} as const;

const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export async function resolveCapabilityPolicy(): Promise<CapabilityPolicy> {
  const [hiddenSkills, hiddenToolsets, essentialToolsets, essentialSkills] =
    await Promise.all([
      resolveSetting<string[]>(CAPABILITY_KEYS.hiddenSkills, [], {}),
      resolveSetting<string[]>(CAPABILITY_KEYS.hiddenToolsets, [], {}),
      resolveSetting<string[]>(CAPABILITY_KEYS.essentialToolsets, [], {}),
      resolveSetting<string[]>(CAPABILITY_KEYS.essentialSkills, [], {}),
    ]);
  return {
    hiddenSkills: asArr(hiddenSkills),
    hiddenToolsets: asArr(hiddenToolsets),
    essentialToolsets: asArr(essentialToolsets),
    essentialSkills: asArr(essentialSkills),
  };
}
