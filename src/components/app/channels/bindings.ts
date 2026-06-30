"use client";

/**
 * Helper untuk read + manipulate `cfg.bindings[]` array. Engine route
 * channel→agent via array bindings, masing-masing entry shape:
 *   { type: "route", agentId, match: { channel, accountId? } }
 *
 * Why we manipulate array end-to-end (bukan partial patch):
 * - `bindings` adalah ARRAY, bukan object map. config.patch deep-merge
 *   bekerja for objects, tapi untuk array harus replace whole.
 * - Strategy: read existing bindings via config.get → upsert (replace
 *   match-key existing OR append) → patch full array.
 * - Match key: channel + (accountId ?? "default") — gak count peer,
 *   roles, dll karena kita simple route per-account.
 *
 * Engine code reference: `agents.bindings-B_1zIV-E.js` `applyAgentBindings`
 * (verified 2026-05-02).
 */

export type RouteBinding = {
  type: "route";
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
  };
};

export type AnyBinding =
  | RouteBinding
  | { type?: string; [k: string]: unknown };

/**
 * Match key untuk binding — channel + accountId. Sama dengan engine's
 * `bindingMatchKey` tapi simplified (kita gak set peer/roles/guildId).
 */
function matchKeyFor(channelId: string, accountId: string): string {
  return JSON.stringify([channelId, accountId || "default"]);
}

function isRouteBinding(b: unknown): b is RouteBinding {
  if (!b || typeof b !== "object") return false;
  const cast = b as Partial<RouteBinding>;
  // Engine treats type=undefined as legacy "route". Align to safer side:
  // accept missing type, "route" type. Reject other types (e.g. "acp").
  if (cast.type !== undefined && cast.type !== "route") return false;
  if (typeof cast.agentId !== "string" || !cast.agentId) return false;
  if (!cast.match || typeof cast.match !== "object") return false;
  if (typeof cast.match.channel !== "string" || !cast.match.channel) return false;
  return true;
}

/**
 * Build a new bindings[] array with the given route upserted.
 * - Existing route untuk channel+accountId yang sama → diganti agentId baru.
 * - Tidak ada existing → append.
 * - Non-route bindings (e.g. acp) → preserved as-is.
 */
export function upsertRouteBinding(
  existingBindings: ReadonlyArray<AnyBinding> | undefined,
  route: RouteBinding,
): AnyBinding[] {
  const out: AnyBinding[] = [];
  const targetKey = matchKeyFor(
    route.match.channel,
    route.match.accountId ?? "default",
  );
  let replaced = false;
  for (const b of existingBindings ?? []) {
    if (isRouteBinding(b)) {
      const k = matchKeyFor(b.match.channel, b.match.accountId ?? "default");
      if (k === targetKey) {
        out.push({ ...b, agentId: route.agentId, match: { ...route.match } });
        replaced = true;
        continue;
      }
    }
    out.push(b);
  }
  if (!replaced) {
    out.push({
      type: "route",
      agentId: route.agentId,
      match: { ...route.match },
    });
  }
  return out;
}

/**
 * Find which agent is bound to a (channel, accountId). Returns null kalau
 * tidak ada explicit binding — caller treat sebagai "routed to default agent".
 */
export function findRouteBinding(
  bindings: ReadonlyArray<AnyBinding> | undefined,
  channelId: string,
  accountId: string = "default",
): string | null {
  if (!bindings) return null;
  const targetKey = matchKeyFor(channelId, accountId);
  for (const b of bindings) {
    if (!isRouteBinding(b)) continue;
    const k = matchKeyFor(b.match.channel, b.match.accountId ?? "default");
    if (k === targetKey) return b.agentId;
  }
  return null;
}

/**
 * Remove route binding untuk channel+accountId. Used saat user logout
 * channel — clean up routing entry juga.
 */
export function removeRouteBinding(
  bindings: ReadonlyArray<AnyBinding> | undefined,
  channelId: string,
  accountId: string = "default",
): AnyBinding[] {
  if (!bindings) return [];
  const targetKey = matchKeyFor(channelId, accountId);
  return bindings.filter((b) => {
    if (!isRouteBinding(b)) return true;
    const k = matchKeyFor(b.match.channel, b.match.accountId ?? "default");
    return k !== targetKey;
  });
}
