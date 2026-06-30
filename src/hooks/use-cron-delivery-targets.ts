"use client";

/**
 * useCronDeliveryTargets — fetch real channels + accounts + recipients untuk
 * dropdown di wizard "Kirim ke mana".
 *
 * Sources:
 *  - `channels.status { probe: false }` → channelOrder + channelLabels +
 *    channelAccounts (per-channel accounts dengan name/configured/linked).
 *  - `sessions.list { limit: 100 }` → derive distinct recipients per channel
 *    dari session.surface / session.subject / session.origin.{from,to}.
 *
 * Channel + account selalu di-list (engine truth). Recipient di-derive dari
 * sesi yang pernah ada — user tetep bisa input manual kalau peer-nya belum
 * pernah chat sebelumnya.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getClient, useAppStore } from "@/lib/app/store";

/* ── Channel + account shape (dari engine channels.status) ────────── */

export type ChannelOption = {
  id: string;
  label: string;
  configured: boolean;
  linked: boolean;
};

export type AccountOption = {
  accountId: string;
  label: string;
  configured: boolean;
  linked: boolean;
  running: boolean;
  lastError?: string | null;
};

export type RecipientOption = {
  /** Raw peer ID untuk delivery.to */
  value: string;
  /** Display label (contact name, group name, or fallback to ID) */
  label: string;
  /** "direct" | "group" — buat optional icon */
  kind?: "direct" | "group" | "unknown";
  /** Last activity timestamp for sorting */
  lastSeenAt?: number;
};

/* ── Raw channels.status types ─────────────────────────────────────── */

type ChannelEntry = {
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
};

type AccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  lastError?: string | null;
};

type ChannelsStatusResult = {
  ts: number;
  channels?: Record<string, ChannelEntry>;
  channelAccounts?: Record<string, AccountSnapshot[]>;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
};

/* ── Hook ──────────────────────────────────────────────────────────── */

export function useCronDeliveryTargets() {
  const status = useAppStore((s) => s.status);

  const channelsQ = useQuery<ChannelsStatusResult>({
    queryKey: ["cron-delivery-channels"],
    enabled: status === "ready",
    staleTime: 60_000,
    queryFn: async () => {
      const client = getClient();
      if (!client) throw new Error("Gateway belum tersambung");
      return await client.request<ChannelsStatusResult>("channels.status", {
        probe: false,
        timeoutMs: 8_000,
      });
    },
  });

  // sessions.list for recipient derivation
  type SessionsListRaw = {
    sessions?: Array<{
      key: string;
      kind?: string;
      label?: string;
      displayName?: string;
      derivedTitle?: string;
      subject?: string;
      room?: string;
      surface?: string;
      updatedAt?: number | null;
    }>;
  };
  const sessionsQ = useQuery<SessionsListRaw>({
    queryKey: ["cron-delivery-sessions"],
    enabled: status === "ready",
    staleTime: 60_000,
    queryFn: async () => {
      const client = getClient();
      if (!client) throw new Error("Gateway belum tersambung");
      return await client.request<SessionsListRaw>("sessions.list", {
        limit: 100,
        includeDerivedTitles: true,
        includeLastMessage: false,
      });
    },
  });

  // Connected channel ids (used to fetch each channel's allowlist).
  const connectedIds = useMemo(() => {
    const d = channelsQ.data;
    if (!d) return [];
    const order = d.channelOrder ?? Object.keys(d.channels ?? {});
    return order.filter((id) => {
      const ch = d.channels?.[id] ?? {};
      return ch.configured || ch.linked;
    });
  }, [channelsQ.data]);

  // Per channel (channels.getAccess): the allowlist users (people explicitly
  // allowed to chat the bot) + detected groups the bot is in. The engine keeps
  // no general contact book, but both are real, known recipients — surfaced for
  // "Kirim ke" so users pick instead of typing JIDs.
  const accessQ = useQuery<
    Record<string, { users: string[]; groups: Array<{ id: string; label: string }> }>
  >({
    queryKey: ["cron-delivery-access", connectedIds.join(",")],
    enabled: status === "ready" && connectedIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const client = getClient();
      if (!client) throw new Error("Gateway belum tersambung");
      const out: Record<
        string,
        { users: string[]; groups: Array<{ id: string; label: string }> }
      > = {};
      await Promise.all(
        connectedIds.map(async (id) => {
          try {
            const a = await client.request<{
              allowlist?: string[];
              groups?: Array<{ id?: string; label?: string }>;
            }>("channels.getAccess", { channel: id });
            const users = (a.allowlist ?? []).filter((x) => x && x !== "*");
            const groups = (a.groups ?? [])
              .filter((g) => g.id)
              .map((g) => ({ id: g.id as string, label: g.label || (g.id as string) }));
            if (users.length || groups.length) out[id] = { users, groups };
          } catch {
            /* per-channel best effort */
          }
        }),
      );
      return out;
    },
  });

  const channels: ChannelOption[] = useMemo(() => {
    const data = channelsQ.data;
    if (!data) return [];
    const order = data.channelOrder ?? Object.keys(data.channels ?? {});
    const labels = data.channelLabels ?? {};
    return order
      .map((id) => {
        const ch = data.channels?.[id] ?? {};
        return {
          id,
          label: labels[id] ?? humanizeChannelId(id),
          configured: !!ch.configured,
          linked: !!ch.linked,
        };
      })
      .filter((c) => c.configured || c.linked);
  }, [channelsQ.data]);

  const accountsByChannel: Record<string, AccountOption[]> = useMemo(() => {
    const data = channelsQ.data;
    if (!data || !data.channelAccounts) return {};
    const out: Record<string, AccountOption[]> = {};
    for (const [channelId, accounts] of Object.entries(data.channelAccounts)) {
      out[channelId] = accounts
        .filter((a) => a.configured || a.linked)
        .map((a) => ({
          accountId: a.accountId,
          label: a.name ?? a.accountId,
          configured: !!a.configured,
          linked: !!a.linked,
          running: !!a.running,
          lastError: a.lastError ?? null,
        }));
    }
    return out;
  }, [channelsQ.data]);

  const recipientsByChannel: Record<string, RecipientOption[]> = useMemo(() => {
    const sessions = sessionsQ.data?.sessions ?? [];
    const out: Record<string, RecipientOption[]> = {};
    for (const s of sessions) {
      const peer = extractPeer(s);
      if (!peer) continue;
      const list = (out[peer.channelId] ??= []);
      // Dedup by value
      const existing = list.find((r) => r.value === peer.value);
      if (existing) {
        if (peer.lastSeenAt && (!existing.lastSeenAt || peer.lastSeenAt > existing.lastSeenAt)) {
          existing.lastSeenAt = peer.lastSeenAt;
        }
        // Prefer better label if existing is just the raw value
        if (existing.label === existing.value && peer.label !== peer.value) {
          existing.label = peer.label;
        }
      } else {
        list.push({
          value: peer.value,
          label: peer.label,
          kind: peer.kind,
          lastSeenAt: peer.lastSeenAt,
        });
      }
    }
    // Merge allowlist users + detected groups (real, known recipients).
    const access = accessQ.data ?? {};
    for (const [channelId, entry] of Object.entries(access)) {
      const list = (out[channelId] ??= []);
      for (const g of entry.groups) {
        if (!list.some((r) => r.value === g.id)) {
          list.push({ value: g.id, label: g.label, kind: "group" });
        }
      }
      for (const u of entry.users) {
        if (!list.some((r) => r.value === u)) {
          list.push({ value: u, label: u, kind: "direct" });
        }
      }
    }
    // Sort each list by lastSeenAt desc (allowlist entries have none → go last).
    for (const list of Object.values(out)) {
      list.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    }
    return out;
  }, [sessionsQ.data, accessQ.data]);

  return {
    channels,
    accountsByChannel,
    recipientsByChannel,
    isLoading: channelsQ.isLoading || sessionsQ.isLoading,
    error:
      channelsQ.error || sessionsQ.error
        ? String(
            (channelsQ.error as Error)?.message ??
              (sessionsQ.error as Error)?.message ??
              "Gagal load",
          )
        : null,
    refetch: () => {
      void channelsQ.refetch();
      void sessionsQ.refetch();
    },
  };
}

/* ── Session → peer extraction ─────────────────────────────────────── */

type ExtractedPeer = {
  channelId: string;
  value: string;
  label: string;
  kind: "direct" | "group" | "unknown";
  lastSeenAt?: number;
};

/** Engine session keys take various forms:
 *   - "agent:main:main" (dashboard webchat)
 *   - "agent:main:whatsapp:+62812..." (WA DM)
 *   - "agent:main:whatsapp:group:120363...@g.us"
 *   - "agent:main:telegram:12345" (TG chat)
 *   - "agent:main:discord:userId" (DM)
 *   - "agent:main:discord:guild:123:channel:456"
 *
 * We parse the channel slug + the peer-id remainder. label prefers
 * displayName/derivedTitle/label > raw peer id.
 */
function extractPeer(s: {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  subject?: string;
  room?: string;
  surface?: string;
  updatedAt?: number | null;
}): ExtractedPeer | null {
  const parts = s.key.split(":");
  // Try to find the channel slug (3rd part typically for `agent:main:<channel>:...`)
  if (parts.length < 4) {
    // No channel info — skip (dashboard webchat sessions don't apply)
    return null;
  }
  const channelId = parts[2];
  if (!channelId) return null;
  // Skip webchat / dashboard sessions
  if (channelId === "main" || channelId === "dashboard") return null;

  // The rest forms the peer ID. Engine sometimes inserts "group:" prefix.
  const remainder = parts.slice(3);
  const isGroup = remainder[0] === "group";
  const peerRaw = isGroup ? remainder.slice(1).join(":") : remainder.join(":");
  if (!peerRaw) return null;

  // Display label: prefer human-friendly fields
  const label =
    s.displayName?.trim() ||
    s.derivedTitle?.trim() ||
    s.label?.trim() ||
    peerRaw;

  return {
    channelId,
    value: peerRaw,
    label,
    kind: isGroup ? "group" : s.kind === "group" ? "group" : "direct",
    lastSeenAt: s.updatedAt ?? undefined,
  };
}

function humanizeChannelId(id: string): string {
  const map: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack",
    googlechat: "Google Chat",
    "google-chat": "Google Chat",
    webchat: "Chat AgentBuff",
    web: "Chat AgentBuff",
    agentbuff: "Chat AgentBuff",
  };
  return map[id.toLowerCase()] ?? id;
}
