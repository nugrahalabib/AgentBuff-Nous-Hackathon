// Verify coming-soon flag coverage di channel catalog:
//   - WhatsApp + Telegram = ACTIVE (comingSoon !== true)
//   - Discord, Slack, GoogleChat, Signal, iMessage, Nostr = COMING SOON
//   - filterCatalogForUser: comingSoon channels bypass tier-lock
//   - tierLockedCatalog: exclude comingSoon (no double render)
//
//   pnpm tsx --env-file=.env.local scripts/verify-coming-soon.ts

import {
  CHANNEL_CATALOG,
  filterCatalogForUser,
} from "@/components/app/channels/channel-catalog";

type Result = { name: string; ok: boolean; detail: string };
const checks: Result[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
}

console.log("[Phase 1] Per-channel comingSoon flag");

const ACTIVE = new Set(["whatsapp", "telegram"]);
const COMING_SOON = new Set([
  "discord",
  "slack",
  "googlechat",
  "signal",
  "imessage",
  "nostr",
]);

for (const entry of CHANNEL_CATALOG) {
  const isComingSoon = entry.comingSoon === true;
  if (ACTIVE.has(entry.id)) {
    check(
      `${entry.id}: ACTIVE (comingSoon !== true)`,
      !isComingSoon,
      isComingSoon ? "BUG — channel ini harus tetap aktif" : "OK",
    );
  } else if (COMING_SOON.has(entry.id)) {
    check(
      `${entry.id}: COMING SOON (comingSoon === true)`,
      isComingSoon,
      isComingSoon ? "OK" : "BUG — channel ini harus coming-soon",
    );
  } else {
    check(
      `${entry.id}: not in expected set (verify intent)`,
      false,
      `unexpected channel, comingSoon=${isComingSoon}`,
    );
  }
}

// Make sure no orphans
const catalogIds = new Set(CHANNEL_CATALOG.map((c) => c.id));
for (const id of [...ACTIVE, ...COMING_SOON]) {
  check(`expected channel "${id}" exists in catalog`, catalogIds.has(id));
}

console.log("\n[Phase 2] filterCatalogForUser behavior — starter tier");
// Starter user, no connected channels, no advanced.
const starterCatalog = filterCatalogForUser("starter", new Set(), false);
const starterIds = starterCatalog.map((c) => c.id);
console.log(`  catalog (non-advanced for starter): [${starterIds.join(", ")}]`);

// WhatsApp + Telegram must be there (active starter-tier)
check(
  "starter sees whatsapp",
  starterIds.includes("whatsapp"),
  starterCatalog.find((c) => c.id === "whatsapp")?.comingSoon === true
    ? "WRONG — whatsapp shouldn't be coming-soon"
    : "OK",
);
check(
  "starter sees telegram",
  starterIds.includes("telegram"),
  starterCatalog.find((c) => c.id === "telegram")?.comingSoon === true
    ? "WRONG — telegram shouldn't be coming-soon"
    : "OK",
);

// Discord, Slack — coming-soon starter-tier; should appear (bypass tier)
check("starter sees discord (coming-soon bypass tier)", starterIds.includes("discord"));
check("starter sees slack (coming-soon bypass tier)", starterIds.includes("slack"));

// Google Chat — coming-soon op_buff-tier; should ALSO appear (comingSoon bypass)
check(
  "starter sees googlechat (coming-soon bypass op_buff requirement)",
  starterIds.includes("googlechat"),
);

// Signal, iMessage, Nostr — advanced; should NOT appear in non-advanced catalog
check(
  "starter does NOT see signal in main catalog (it's advanced)",
  !starterIds.includes("signal"),
);
check(
  "starter does NOT see imessage in main catalog (it's advanced)",
  !starterIds.includes("imessage"),
);
check(
  "starter does NOT see nostr in main catalog (it's advanced)",
  !starterIds.includes("nostr"),
);

console.log("\n[Phase 3] filterCatalogForUser includeAdvanced=true");
const allForStarter = filterCatalogForUser("starter", new Set(), true);
const allIds = allForStarter.map((c) => c.id);
console.log(`  full catalog (advanced included): [${allIds.join(", ")}]`);

check("starter+advanced sees signal", allIds.includes("signal"));
check("starter+advanced sees imessage", allIds.includes("imessage"));
check("starter+advanced sees nostr", allIds.includes("nostr"));

console.log("\n[Phase 4] tierLockedCatalog reproduction (logic from channels-tab)");
// Simulate channels-tab filter:
const TIER_ORDER: Record<string, number> = {
  starter: 0,
  op_buff: 1,
  guild_master: 2,
};
const userLevel = TIER_ORDER["starter"] ?? 0;
const tierLocked = CHANNEL_CATALOG.filter(
  (c) =>
    !new Set<string>().has(c.id) &&
    !c.advanced &&
    !c.comingSoon &&
    TIER_ORDER[c.minTier] > userLevel,
);
console.log(
  `  tier-locked for starter (non-advanced, non-comingSoon): [${tierLocked
    .map((c) => c.id)
    .join(", ")}]`,
);
check(
  "tier-locked is empty for starter (all op_buff channels are coming-soon)",
  tierLocked.length === 0,
);

console.log("\n[Phase 5] op_buff tier behavior");
const opBuffCatalog = filterCatalogForUser("op_buff", new Set(), false);
const opBuffIds = opBuffCatalog.map((c) => c.id);
check(
  "op_buff still sees coming-soon discord (disabled card)",
  opBuffIds.includes("discord"),
);
check(
  "op_buff still sees coming-soon googlechat (disabled card)",
  opBuffIds.includes("googlechat"),
);

// === Summary ===
const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).length;
console.log("\n" + "=".repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed (${checks.length} total)`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\nFAILURES:");
  for (const c of checks.filter((x) => !x.ok)) {
    console.log(`  ✗ ${c.name}: ${c.detail}`);
  }
  process.exit(1);
}
console.log("\nALL COMING-SOON CHECKS PASSED ✓");
process.exit(0);
