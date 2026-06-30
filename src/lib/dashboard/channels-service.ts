/**
 * Channels Service — single source of truth untuk dashboard "Saluran" tab.
 *
 * Production rationale:
 * 1. Aggregate multi-source di server (channels.status + sessions.usage byChannel
 *    + container row state) supaya client cuma render, gak business logic.
 * 2. Cache: TanStack Query stale 30s + Cache-Control private 30s — channel
 *    state berubah sedang sering (login/logout/reconnect via real-time event),
 *    jadi balance antara fresh + cost.
 * 3. Per-channel today's message count dari `sessions.usage.aggregates.byChannel`
 *    (OpenClaw native breakdown). Saat byChannel gak tersedia/empty, fall back ke 0.
 * 4. Available catalog (channel yang bisa di-connect tapi belum) dirakit
 *    di server berdasar config.schema OpenClaw — single source untuk "apa
 *    saja channel yang engine bisa handle", konsisten cross-surface.
 * 5. Container offline → return shape lengkap dengan empty arrays + flag.
 *    Tab tetap render placeholder daripada blank.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import {
  getSessionsUsage,
  withGateway,
  type GatewayClient,
  type SessionsUsageResult,
} from "@/lib/hermes/gateway-client";

// ── Wire types (mirror engine `channels.status` shape) ─────────────────

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  mode?: string;
  dmPolicy?: string;
  /** Human-facing account identity surfaced by the bridge so the UI shows the
   * real account instead of a placeholder. WhatsApp: phone (E.164 digits) +
   * displayName (pushname). Telegram: botId (numeric token prefix). */
  phone?: string | null;
  displayName?: string | null;
  botId?: string | null;
  /**
   * Agent yang handle akun ini berdasar `bindings[]` array di config.
   * null = pakai default agent (no explicit binding). Computed di server
   * supaya client tinggal render — gak perlu read config sendiri.
   */
  routedAgentId?: string | null;
  // Adapter-specific extras (passed through, opaque to service):
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
};

export type ChannelUiMeta = {
  id: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
};

export type ChannelsStatusResult = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMeta[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
  /** Per-agent synthetic-platform accounts (bridge `agentChannels`).
   *  Shape: { "<agentId>": { channels: { "<base>": { accounts: [...] } } } }.
   *  Drives the per-agen Saluran matrix + synthetic pairing verification. */
  agentChannels?: Record<string, unknown>;
};

// ── Output shape buat client ───────────────────────────────────────────

export type ChannelUsageToday = {
  /** Total inbound + outbound messages hari ini (proxy produktivitas). */
  totalToday: number;
  /** Inbound (pesan masuk dari user). */
  inboundToday: number;
  /** Outbound (pesan dari AI keluar). */
  outboundToday: number;
};

export type ChannelDashboardEntry = {
  channelId: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
  accounts: ChannelAccountSnapshot[];
  defaultAccountId?: string;
  /** Channel-level summary derived dari accounts. */
  summary: {
    totalAccounts: number;
    onlineAccounts: number;
    hasError: boolean;
    hasReconnectLoop: boolean;
  };
  usage: ChannelUsageToday;
  /** Agent yang handle channel ini berdasar `bindings[]` array di config.
   * null = pakai default agent (no explicit binding). */
  routedAgentId: string | null;
  /** Adapter-specific raw status (untuk WhatsApp QR pairing UI, dst). */
  rawStatus: unknown;
};

/** Per-profile channels snapshot (Fase 8 multi-profile reform). Each profile
 *  (= agent) has its own channels[] and bindings[]. Default profile mirrors
 *  the top-level connectedChannels for backward compat. Named profiles
 *  populate keys like "kak-tutor", "mbak-cs" etc.
 */
export type PerProfileChannelsSnapshot = {
  profileId: string;
  channels: ChannelDashboardEntry[];
  bindings: unknown[];
  totals: {
    channels: number;
    accounts: number;
    online: number;
  };
};

export type ChannelsDashboardPayload = {
  /** Snapshot timestamp ISO. */
  generatedAt: string;
  /** Apakah container running + gateway responsif. */
  engineLive: boolean;
  /** Connected channels yang ada accounts (linked OR configured) — ROOT profile. */
  connectedChannels: ChannelDashboardEntry[];
  /** Per-profile breakdown — Fase 8 multi-agent matrix view consumer. */
  profiles?: Record<string, PerProfileChannelsSnapshot>;
  /** Total counters (ringkasan global). */
  totals: {
    channels: number;
    accounts: number;
    online: number;
    inboundToday: number;
    outboundToday: number;
  };
};

// ── Implementation ─────────────────────────────────────────────────────

const TODAY_DATE_FMT = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function isAccountOnline(acc: ChannelAccountSnapshot): boolean {
  // Channel WS-persistent (WhatsApp Baileys, Slack socket mode) set field
  // `connected` boolean. Channel polling-mode (Telegram polling, Discord
  // polling, dll) tidak — engine cuma set `running`. Aturan unified:
  //   - running + connected=true   → online (WS-persistent connected)
  //   - running + connected=undef  → online (polling-mode running tanpa indicator)
  //   - running + connected=false  → offline (WS-persistent gagal connect)
  //   - !running                   → offline
  // Plus: ada lastError yang non-null = treated as not online (degraded).
  if (!acc.running) return false;
  if (acc.connected === false) return false;
  if (acc.lastError) return false;
  return true;
}

function isAccountConfigured(acc: ChannelAccountSnapshot): boolean {
  return acc.configured === true || acc.linked === true;
}

function aggregateUsageByChannel(
  usage: SessionsUsageResult | null,
): Record<string, { total: number; user: number; assistant: number }> {
  if (!usage) return {};
  // OpenClaw `sessions.usage` returns aggregates.byChannel as either array
  // or record map, depending on version. Normalize both shapes.
  const raw = (usage.aggregates as Record<string, unknown> | undefined)
    ?.byChannel;
  const result: Record<string, { total: number; user: number; assistant: number }> = {};
  if (!raw) return result;

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as {
        channel?: string;
        channelId?: string;
        messages?: { total?: number; user?: number; assistant?: number };
      };
      const id = e.channel ?? e.channelId;
      if (!id) continue;
      result[id] = {
        total: e.messages?.total ?? 0,
        user: e.messages?.user ?? 0,
        assistant: e.messages?.assistant ?? 0,
      };
    }
  } else if (typeof raw === "object") {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as {
        messages?: { total?: number; user?: number; assistant?: number };
        total?: number;
        user?: number;
        assistant?: number;
      };
      result[id] = {
        total: v.messages?.total ?? v.total ?? 0,
        user: v.messages?.user ?? v.user ?? 0,
        assistant: v.messages?.assistant ?? v.assistant ?? 0,
      };
    }
  }
  return result;
}

/**
 * Bridge convention: channels.status mengirim `{channels: {<id>: {accounts:
 * [...], ...}}, bindings: [...], generatedAt: <iso>}`. Portal historically
 * expects flattened map: `channelOrder + channelAccounts + channelLabels +
 * channelDefaultAccountId`. Normalize disini biar downstream code (line ~379
 * `for (const channelId of status.channelOrder)`) gak meledak dengan
 * "channelOrder is not iterable" tiap kali bridge respond.
 *
 * Aman dipanggil dua kali — kalau bridge sudah kasih shape lengkap, fungsi
 * detect via `Array.isArray(raw.channelOrder)` dan return apa adanya.
 *
 * Account-level juga di-normalize: bridge pakai snake_case (`account_id`),
 * portal pakai camelCase (`accountId`). Plus mapping `running`→`connected`
 * untuk channel polling-mode (lihat memory `agentbuff_channels_ux.md` Bug 1).
 */
function normalizeBridgeChannelsStatus(
  raw: Record<string, unknown> | null,
): ChannelsStatusResult | null {
  if (!raw || typeof raw !== "object") return null;
  // Already in portal shape? pass through.
  if (Array.isArray((raw as { channelOrder?: unknown }).channelOrder)) {
    return raw as unknown as ChannelsStatusResult;
  }
  const channels = (raw as { channels?: Record<string, unknown> }).channels;
  if (!channels || typeof channels !== "object") {
    return {
      ts: Date.now(),
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
  }

  const channelOrder: string[] = [];
  const channelLabels: Record<string, string> = {};
  const channelAccounts: Record<string, ChannelAccountSnapshot[]> = {};
  const channelDefaultAccountId: Record<string, string> = {};
  const channelsOut: Record<string, unknown> = {};

  for (const [channelId, channelCfgRaw] of Object.entries(channels)) {
    if (!channelCfgRaw || typeof channelCfgRaw !== "object") continue;
    const channelCfg = channelCfgRaw as Record<string, unknown>;
    channelOrder.push(channelId);
    // Label: portal-side catalog has prettier names; here just fall back to
    // capitalized id since the dashboard layer doesn't import the catalog.
    channelLabels[channelId] =
      typeof channelCfg.label === "string"
        ? (channelCfg.label as string)
        : channelId.charAt(0).toUpperCase() + channelId.slice(1);

    const bridgeAccounts = Array.isArray(channelCfg.accounts)
      ? (channelCfg.accounts as Record<string, unknown>[])
      : [];
    const norm: ChannelAccountSnapshot[] = [];
    for (const acc of bridgeAccounts) {
      if (!acc || typeof acc !== "object") continue;
      const accountId =
        (acc.accountId as string | undefined) ??
        (acc.account_id as string | undefined) ??
        "default";
      const enabled =
        typeof acc.enabled === "boolean" ? acc.enabled : undefined;
      const configured =
        typeof acc.configured === "boolean" ? acc.configured : undefined;
      const running =
        typeof acc.running === "boolean" ? acc.running : undefined;
      // Bridge tidak track `connected` (no runtime probe). Treat running=true
      // as connected=true biar status badge di UI sehat untuk polling-mode
      // channel. Channel WS-persistent (WhatsApp/Slack socket) yang punya
      // explicit `connected` field tetap di-honor kalau bridge nanti tambah.
      const connected =
        typeof acc.connected === "boolean" ? acc.connected : running;
      norm.push({
        accountId,
        name: (acc.name as string | null | undefined) ?? null,
        enabled,
        configured,
        running,
        connected,
        linked: typeof acc.linked === "boolean" ? acc.linked : configured,
        lastError: (acc.lastError as string | null | undefined) ?? null,
        dmPolicy: typeof acc.dmPolicy === "string" ? (acc.dmPolicy as string) : undefined,
        phone: typeof acc.phone === "string" ? (acc.phone as string) : null,
        displayName:
          typeof acc.displayName === "string" ? (acc.displayName as string) : null,
        botId: typeof acc.botId === "string" ? (acc.botId as string) : null,
        routedAgentId:
          typeof acc.routedAgentId === "string"
            ? (acc.routedAgentId as string)
            : null,
      });
    }
    channelAccounts[channelId] = norm;
    if (norm.length > 0) {
      channelDefaultAccountId[channelId] = norm[0]!.accountId;
    }

    // Pass through channel-level state untuk downstream gating logic
    // (channels-service.ts line ~381). Strip accounts to avoid double-encode.
    channelsOut[channelId] = {
      configured: channelCfg.configured,
      enabled: channelCfg.enabled,
      running: channelCfg.running,
      linked: channelCfg.linked,
      routedAgentId: channelCfg.routedAgentId,
      lastError: channelCfg.lastError,
    };
  }

  // Pass through the bridge's per-agent synthetic-platform map untouched
  // (used downstream to build per-profile snapshots + verify synthetic pairs).
  const agentChannels = (raw as { agentChannels?: Record<string, unknown> })
    .agentChannels;

  // MERGE per-agent SYNTHETIC accounts (multichannel plugin) into the flat
  // channelAccounts so the connected list shows them — each tagged with the
  // agent it routes to. Without this, a synthetic account (e.g. the default
  // agent's whatsapp__default-1) lives ONLY in agentChannels and never appears
  // in the main connected list: the native channel reports 0 accounts and the
  // working account is invisible. (Bug verified 2026-06-04 — chief's WhatsApp.)
  if (agentChannels && typeof agentChannels === "object") {
    for (const [agentId, snapRaw] of Object.entries(agentChannels)) {
      // Only the DEFAULT agent's synthetic accounts go into the main connected
      // list (Zone 3). NAMED agents stay in agentChannels → the per-agent matrix
      // (Zone 2.5), so they aren't double-displayed. Clean default-vs-named split.
      if (agentId !== "default") continue;
      const chMap = (snapRaw as { channels?: Record<string, unknown> } | null)
        ?.channels;
      if (!chMap || typeof chMap !== "object") continue;
      for (const [base, chRaw] of Object.entries(chMap)) {
        const accs = (chRaw as { accounts?: Record<string, unknown>[] } | null)
          ?.accounts;
        if (!Array.isArray(accs) || accs.length === 0) continue;
        if (!channelOrder.includes(base)) {
          channelOrder.push(base);
          channelLabels[base] = base.charAt(0).toUpperCase() + base.slice(1);
        }
        const list = channelAccounts[base] ?? (channelAccounts[base] = []);
        for (const acc of accs) {
          if (!acc || typeof acc !== "object") continue;
          const accountId =
            (acc.accountId as string | undefined) ??
            (acc.account_id as string | undefined) ??
            "default";
          if (list.some((x) => x.accountId === accountId)) continue; // dedup
          const running =
            typeof acc.running === "boolean" ? acc.running : undefined;
          const configured =
            typeof acc.configured === "boolean" ? acc.configured : undefined;
          list.push({
            accountId,
            name: (acc.name as string | null | undefined) ?? null,
            enabled: typeof acc.enabled === "boolean" ? acc.enabled : undefined,
            configured,
            running,
            connected:
              typeof acc.connected === "boolean" ? acc.connected : running,
            linked: typeof acc.linked === "boolean" ? acc.linked : configured,
            lastError: (acc.lastError as string | null | undefined) ?? null,
            dmPolicy:
              typeof acc.dmPolicy === "string"
                ? (acc.dmPolicy as string)
                : undefined,
            phone: typeof acc.phone === "string" ? (acc.phone as string) : null,
            displayName:
              typeof acc.displayName === "string"
                ? (acc.displayName as string)
                : null,
            botId: typeof acc.botId === "string" ? (acc.botId as string) : null,
            // Synthetic account routes to THIS agent (multichannel plugin).
            routedAgentId: agentId,
          });
        }
        if (!channelDefaultAccountId[base] && list.length > 0) {
          channelDefaultAccountId[base] = list[0]!.accountId;
        }
      }
    }
  }

  return {
    ts: Date.now(),
    channelOrder,
    channelLabels,
    channels: channelsOut,
    channelAccounts,
    channelDefaultAccountId,
    agentChannels:
      agentChannels && typeof agentChannels === "object"
        ? agentChannels
        : undefined,
  };
}

async function fetchChannelsStatus(
  client: GatewayClient,
): Promise<ChannelsStatusResult | null> {
  try {
    const result = await client.call<Record<string, unknown>>(
      "channels.status",
      { probe: false, timeoutMs: 8_000 },
      { timeoutMs: 12_000 },
    );
    return normalizeBridgeChannelsStatus(result);
  } catch (err) {
    console.error(
      "[channels-service] channels.status failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function emptyPayload(): ChannelsDashboardPayload {
  return {
    generatedAt: new Date().toISOString(),
    engineLive: false,
    connectedChannels: [],
    totals: {
      channels: 0,
      accounts: 0,
      online: 0,
      inboundToday: 0,
      outboundToday: 0,
    },
  };
}

/**
 * Compute channels dashboard untuk satu user. Server-side; harus dipanggil
 * dari trusted REST endpoint setelah auth check. Tidak melempar error untuk
 * container offline — kembalikan shape lengkap dengan engineLive=false.
 */
export async function computeChannelsDashboard(
  userId: string,
): Promise<ChannelsDashboardPayload> {
  const [container] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  if (!container || container.status !== "running") {
    return emptyPayload();
  }

  const url = `ws://${hermesConfig.publicHost}:${container.port}/`;

  try {
    return await withGateway(
      {
        url,
        token: container.gatewayToken,
        clientId: "agentbuff-portal",
        instanceId: `channels-dashboard-${userId.slice(0, 8)}`,
        connectTimeoutMs: 6_000,
        defaultCallTimeoutMs: 12_000,
      },
      async (client) => {
        const today = TODAY_DATE_FMT(new Date());

        // Parallel fetch: channels status + today's per-channel usage breakdown
        // + config snapshot (untuk extract bindings array → routedAgentId).
        // sessions.usage limit=1 (gateway requires >=1). Yang kita butuh ada
        // di aggregates.byChannel.
        const [channelsResult, usageResult, configResult] = await Promise.all([
          fetchChannelsStatus(client),
          getSessionsUsage(client, {
            startDate: today,
            endDate: today,
            limit: 1,
          }).catch((err) => {
            console.error(
              "[channels-service] sessions.usage failed:",
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }),
          client
            .call<{ config?: { bindings?: unknown[] } }>("config.get", {})
            .catch((err) => {
              console.error(
                "[channels-service] config.get failed:",
                err instanceof Error ? err.message : String(err),
              );
              return null;
            }),
        ]);

        if (!channelsResult) {
          return { ...emptyPayload(), engineLive: false };
        }

        return assemblePayload(channelsResult, usageResult, configResult);
      },
    );
  } catch (err) {
    console.error(
      `[channels-service] gateway call failed for user ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return emptyPayload();
  }
}

/**
 * Inline binding lookup — reads cfg.bindings[] array and finds the agentId
 * routed to (channelId, accountId). Mirrors `findRouteBinding` di
 * `src/components/app/channels/bindings.ts` tapi standalone untuk service
 * layer (server-side gak boleh import client component).
 */
function findRoutedAgent(
  bindings: unknown[] | undefined,
  channelId: string,
  accountId: string = "default",
): string | null {
  if (!Array.isArray(bindings)) return null;
  for (const b of bindings) {
    if (!b || typeof b !== "object") continue;
    const cast = b as {
      type?: string;
      agentId?: string;
      match?: { channel?: string; accountId?: string };
    };
    // Engine treats type=undefined as legacy "route". Skip non-route bindings.
    if (cast.type !== undefined && cast.type !== "route") continue;
    if (typeof cast.agentId !== "string" || !cast.agentId) continue;
    if (cast.match?.channel !== channelId) continue;
    const matchAcct = cast.match.accountId ?? "default";
    if (matchAcct !== accountId) continue;
    return cast.agentId;
  }
  return null;
}

function assemblePayload(
  status: ChannelsStatusResult,
  usage: SessionsUsageResult | null,
  configResult: { config?: { bindings?: unknown[] } } | null,
): ChannelsDashboardPayload {
  const usageByChannel = aggregateUsageByChannel(usage);
  const bindings = configResult?.config?.bindings;

  const entries: ChannelDashboardEntry[] = [];
  let totalAccounts = 0;
  let totalOnline = 0;
  let totalInbound = 0;
  let totalOutbound = 0;

  // OpenClaw engine ALWAYS auto-creates a "default" account row per loaded
  // channel plugin (whatsapp/telegram/discord/slack). Tanpa filter, tab UI
  // bakal show semua plugin sebagai "Saluran Aktif" walaupun belum ada
  // satupun yang user pair — bohong + bikin user bingung.
  //
  // Gating rule: pakai CHANNEL-level state (status.channels[id].configured ||
  // status.channels[id].linked) sebagai primary signal — engine set ini ke
  // true HANYA kalau channel benar-benar punya credentials valid (bot token
  // saved untuk Telegram/Discord/Slack, atau WhatsApp QR scanned + linked).
  //
  // Account-level `configured` tidak cukup karena WhatsApp set account
  // configured=true cuma karena auth dir dibuat saat web.login.start —
  // walaupun user gak pernah scan QR (linked=false). Gating account-level
  // bakal include WhatsApp pre-link sebagai "Saluran Aktif" yang misleading.
  //
  // Channel yang plugin-nya loaded tapi belum di-pair → stay di catalog
  // "Tambah Saluran Baru" (Zone 4) dengan CTA Hubungkan.
  for (const channelId of status.channelOrder) {
    const accounts = status.channelAccounts[channelId] ?? [];
    const channelStateRaw = status.channels[channelId] as
      | { configured?: boolean; linked?: boolean }
      | undefined;
    const channelLevelPaired =
      channelStateRaw?.configured === true || channelStateRaw?.linked === true;
    // Multi-account fallback: kalau channel-level gak set tapi ada account
    // yang explicitly linked=true (bukan cuma configured=true via auth dir),
    // tetap masuk. Pattern ini muncul kalau engine future-proof multi-account.
    const anyAccountLinked = accounts.some((a) => a.linked === true);
    if (!channelLevelPaired && !anyAccountLinked) continue;

    const onlineAccounts = accounts.filter(isAccountOnline).length;
    const hasError = accounts.some((a) => a.lastError != null);
    const hasReconnectLoop = accounts.some(
      (a) => typeof a.reconnectAttempts === "number" && a.reconnectAttempts >= 3,
    );

    const usageEntry = usageByChannel[channelId];
    const inboundToday = usageEntry?.user ?? 0;
    const outboundToday = usageEntry?.assistant ?? 0;
    const totalToday = usageEntry?.total ?? inboundToday + outboundToday;

    totalAccounts += accounts.length;
    totalOnline += onlineAccounts;
    totalInbound += inboundToday;
    totalOutbound += outboundToday;

    // Resolve per-account routedAgentId — supaya UI bisa display + edit
    // binding per akun. Channel-level routedAgentId = binding ke default
    // account (untuk backward compat di chip header).
    const defaultAccountId =
      status.channelDefaultAccountId[channelId] ?? "default";
    const accountsWithRouting: ChannelAccountSnapshot[] = accounts.map(
      (acc) => ({
        ...acc,
        // Synthetic accounts already carry their agent (set during the merge
        // above); only fall back to the bindings lookup for native accounts.
        routedAgentId:
          acc.routedAgentId ??
          findRoutedAgent(bindings, channelId, acc.accountId),
      }),
    );

    entries.push({
      channelId,
      label: status.channelLabels[channelId] ?? channelId,
      detailLabel: status.channelDetailLabels?.[channelId],
      systemImage: status.channelSystemImages?.[channelId],
      accounts: accountsWithRouting,
      defaultAccountId: status.channelDefaultAccountId[channelId],
      summary: {
        totalAccounts: accounts.length,
        onlineAccounts,
        hasError,
        hasReconnectLoop,
      },
      usage: { totalToday, inboundToday, outboundToday },
      routedAgentId: findRoutedAgent(bindings, channelId, defaultAccountId),
      rawStatus: status.channels[channelId] ?? null,
    });
  }

  // Per-agent synthetic-platform breakdown. The bridge `channels.status` emits
  // `agentChannels: {<agentId>: {channels: {<base>: {accounts: [...]}}}}` (R5).
  // Each agent's entry is shape-compatible with the per-profile parser below
  // (channels map + account list). Legacy `profiles` key kept as a fallback for
  // an un-rebuilt bridge. Missing both → no per-agent matrix (graceful).
  const rawProfiles =
    status.agentChannels ??
    (status as unknown as { profiles?: Record<string, unknown> })?.profiles;
  let perProfile: Record<string, PerProfileChannelsSnapshot> | undefined;
  if (rawProfiles && typeof rawProfiles === "object") {
    perProfile = {};
    for (const [profileId, snap] of Object.entries(rawProfiles)) {
      if (!snap || typeof snap !== "object") continue;
      const snapObj = snap as {
        channels?: Record<string, unknown>;
        bindings?: unknown[];
      };
      const chMap = snapObj.channels || {};
      // Reuse the normalizer pattern to build entries for this profile
      const profileEntries: ChannelDashboardEntry[] = [];
      let pChannels = 0, pAccounts = 0, pOnline = 0;
      for (const [chId, chDataRaw] of Object.entries(chMap)) {
        if (!chDataRaw || typeof chDataRaw !== "object") continue;
        const chData = chDataRaw as {
          configured?: boolean;
          enabled?: boolean;
          accounts?: Record<string, unknown>[];
          routedAgentId?: string | null;
        };
        const rawAccounts = Array.isArray(chData.accounts) ? chData.accounts : [];
        const accountsNormalized: ChannelAccountSnapshot[] = [];
        for (const acc of rawAccounts) {
          if (!acc || typeof acc !== "object") continue;
          const a = acc as Record<string, unknown>;
          const accountId =
            (a.accountId as string | undefined) ??
            (a.account_id as string | undefined) ??
            "default";
          accountsNormalized.push({
            accountId,
            enabled: typeof a.enabled === "boolean" ? (a.enabled as boolean) : undefined,
            configured: typeof a.configured === "boolean" ? (a.configured as boolean) : undefined,
            running: typeof a.running === "boolean" ? (a.running as boolean) : undefined,
            connected: typeof a.connected === "boolean" ? (a.connected as boolean) : undefined,
            linked: typeof a.linked === "boolean" ? (a.linked as boolean) : undefined,
            lastError: (a.lastError as string | null | undefined) ?? null,
            dmPolicy: typeof a.dmPolicy === "string" ? (a.dmPolicy as string) : undefined,
            routedAgentId: typeof a.routedAgentId === "string" ? (a.routedAgentId as string) : null,
          });
        }
        if (!chData.configured && !chData.enabled && accountsNormalized.length === 0) {
          continue;
        }
        const onlineCount = accountsNormalized.filter(isAccountOnline).length;
        pChannels += 1;
        pAccounts += accountsNormalized.length;
        pOnline += onlineCount;
        profileEntries.push({
          channelId: chId,
          label: chId.charAt(0).toUpperCase() + chId.slice(1),
          accounts: accountsNormalized,
          summary: {
            totalAccounts: accountsNormalized.length,
            onlineAccounts: onlineCount,
            hasError: accountsNormalized.some((a) => a.lastError != null),
            hasReconnectLoop: false,
          },
          usage: { totalToday: 0, inboundToday: 0, outboundToday: 0 },
          routedAgentId: chData.routedAgentId ?? null,
          rawStatus: chData,
        });
      }
      perProfile[profileId] = {
        profileId,
        channels: profileEntries,
        bindings: Array.isArray(snapObj.bindings) ? snapObj.bindings : [],
        totals: { channels: pChannels, accounts: pAccounts, online: pOnline },
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    engineLive: true,
    connectedChannels: entries,
    profiles: perProfile,
    totals: {
      channels: entries.length,
      accounts: totalAccounts,
      online: totalOnline,
      inboundToday: totalInbound,
      outboundToday: totalOutbound,
    },
  };
}
