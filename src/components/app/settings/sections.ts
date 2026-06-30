/**
 * Shared section catalog for the /app/pengaturan Settings page + its category
 * sub-sidebar. Single source of truth for the ordered list of sections, their
 * lucide icon, the anchor DOM id (so the sub-sidebar can scrollIntoView), and
 * the scroll-container id. Labels live in i18n (t.app.settings.sections[id]).
 */
export type SettingsSectionId =
  | "ai"
  | "voice"
  | "memory"
  | "safety"
  | "appearance"
  | "providers"
  | "account";

export const SETTINGS_SECTIONS: { id: SettingsSectionId; icon: string }[] = [
  { id: "ai", icon: "Sparkles" },
  { id: "voice", icon: "Volume2" },
  { id: "memory", icon: "BrainCircuit" },
  { id: "safety", icon: "ShieldCheck" },
  { id: "appearance", icon: "Palette" },
  { id: "providers", icon: "KeyRound" },
  // Account management — isolated to its own tab so the irreversible "Hapus Akun"
  // action can't be mis-clicked from an unrelated settings category.
  { id: "account", icon: "UserX" },
];

/** id of the scrollable container in PengaturanTab (IntersectionObserver root). */
export const SETTINGS_SCROLL_ID = "settings-scroll";

/** Anchor id stamped on each <section> + used by the sub-sidebar to jump. */
export const settingsDomId = (id: SettingsSectionId): string =>
  `set-section-${id}`;
