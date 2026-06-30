"use client";

/**
 * Helper untuk patch Hermes engine config via gateway RPC.
 *
 * REWRITTEN 2026-05-27 — bug fix "config base hash unavailable":
 *
 * Previous version mengasumsikan OpenClaw-style optimistic-concurrency
 * dengan `{hash, raw, baseHash}` shape. Bridge sekarang (channels_handler
 * + config_handler.py) sudah Hermes-native pakai contract berbeda:
 *
 *   - `config.get`  params={key?:string}      → { value: <subtree|whole> }
 *   - `config.patch` params={patch:object}    → { ok, config }
 *
 * No hash, no JSON5 string, no baseHash. ConfigHandler di bridge sudah
 * thread-safe via asyncio.Lock — atomic merge tanpa optimistic-concurrency
 * (single-user container, gak ada concurrent writers external).
 *
 * Schema patches yang ditulis ke ~/.hermes/config.yaml semantically:
 *   - Nested objects merge recursively (RFC 7396 merge-patch).
 *   - null values delete keys.
 *   - Lists REPLACE (no item merging — match Hermes engine behavior).
 *
 * Setiap config.patch trigger SIGUSR1 ke gateway subprocess via
 * gateway_runtime.py supervisor → hot-reload tanpa container restart.
 */

import { getClient } from "@/lib/app/store";

/**
 * Build nested partial config object dari path array + leaf value.
 * Example: buildPartial(["channels", "telegram", "botToken"], "abc")
 *   → { channels: { telegram: { botToken: "abc" } } }
 *
 * Path kosong + value object → return value as-is (untuk caller yang
 * sudah build composite patch sendiri, e.g. multi-key channel + bindings).
 */
function buildPartial(
  path: ReadonlyArray<string | number>,
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new Error("buildPartial requires non-empty path for non-object value");
  }
  const result: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    const next: Record<string, unknown> = {};
    cursor[key] = next;
    cursor = next;
  }
  const lastKey = String(path[path.length - 1]);
  cursor[lastKey] = value;
  return result;
}

/**
 * Patch Hermes config via deep path. Atomic + triggers SIGUSR1 reload.
 *
 * Examples:
 *   patchConfigPath(["channels", "telegram", "botToken"], "123:abc")
 *     → { channels: { telegram: { botToken: "123:abc" } } }
 *
 *   patchConfigPath([], { channels: {...}, bindings: [...] })
 *     → composite multi-key patch in one shot (one restart)
 *
 *   patchConfigPath(["channels"], { whatsapp: null })
 *     → delete channels.whatsapp namespace
 */
export async function patchConfigPath(
  path: ReadonlyArray<string | number>,
  value: unknown,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Gateway belum terhubung");
  const partial = buildPartial(path, value);
  await client.request("config.patch", { patch: partial });
}

/**
 * Read current config value at deep path. Returns undefined kalau path
 * tidak ada di config. Caller harus handle undefined sebagai "default".
 *
 * Bridge `config.get` accepts optional `key` parameter (dotted path).
 * - With key: returns just that subtree → `{value: <subtree>}`.
 * - Without key: returns whole config → `{value: <full-config-dict>}`.
 */
export async function readConfigPath<T = unknown>(
  path: ReadonlyArray<string | number>,
): Promise<T | undefined> {
  const client = getClient();
  if (!client) throw new Error("Gateway belum terhubung");
  if (path.length === 0) {
    const r = await client.request<{ value?: unknown }>("config.get", {});
    return r?.value as T | undefined;
  }
  const key = path.map(String).join(".");
  const r = await client.request<{ value?: unknown }>("config.get", { key });
  return (r?.value as T | undefined) ?? undefined;
}

/**
 * Read full config snapshot. Returns `{config, hash}` for backward-compat
 * with callers that read `.config` for current state — `hash` is empty
 * string (deprecated, kept for callsite type compatibility).
 *
 * If config.yaml doesn't exist yet, returns `{config: {}, hash: ""}`
 * instead of throwing — fresh installs need to be able to write first
 * config without read-before-write blowing up.
 */
export async function getConfigSnapshot(): Promise<{
  config: Record<string, unknown>;
  hash: string;
}> {
  const client = getClient();
  if (!client) throw new Error("Gateway belum terhubung");
  let value: unknown;
  try {
    const r = await client.request<{ value?: unknown }>("config.get", {});
    value = r?.value;
  } catch (err) {
    // Defensive: if config.get itself fails (e.g. file system issue),
    // treat as empty config rather than crashing the pairing flow.
    // The subsequent config.patch will create the file from scratch.
    const msg = err instanceof Error ? err.message : String(err);
    // Only swallow benign "no config yet" errors. Re-throw real ones.
    if (
      !/no config|file not found|not exist|empty/i.test(msg)
    ) {
      throw err;
    }
    value = {};
  }
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { config, hash: "" };
}
