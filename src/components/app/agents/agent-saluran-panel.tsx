"use client";

/**
 * AgentSaluranPanel — Tab "Saluran" (per-agent channels, INLINE).
 *
 *   - Lists every channel+account routed to THIS agent — native (bindings /
 *     default fallback) AND synthetic per-agent accounts (platforms.<base>__<agent>).
 *   - "Pasang Saluran" → compact channel picker → PairingDialog locked to THIS
 *     agent (defaultAgentId) so the new account binds here, not to default.
 *   - Per-account "Putuskan":
 *       · synthetic → direct channels.logout RPC (bridge removes ONLY the
 *         platforms.<base>__<account> block; native channel untouched).
 *       · native    → LogoutDialog full flow (namespace wipe + binding cleanup).
 *
 * This per-agent panel is now the ONLY channel-management surface — the
 * standalone /app/channels tab was deleted (2026-06-08). All actions (pair,
 * Putuskan, Akses, Tambah Akun) live here, scoped to this agent.
 */
import {
  Loader2,
  Plus,
  Radio,
  Shield,
  Star,
  Unplug,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useChannelsDashboard } from "@/hooks/use-api";
import type {
  ChannelAccountResponse,
  ChannelDashboardEntryResponse,
} from "@/hooks/use-api";
import { getClient } from "@/lib/app/store";
import {
  CHANNEL_CATALOG,
  getChannelCatalog,
  type ChannelCatalogEntry,
} from "@/components/app/channels/channel-catalog";
import { PairingDialog } from "@/components/app/channels/pairing-dialog";
import {
  LogoutDialog,
  type LogoutTarget,
} from "@/components/app/channels/logout-dialog";
import { AccessControlDialog } from "@/components/app/channels/access-control";
import { getAgentDisplayName, type AgentRow } from "./helpers";

/** Channels with a sender allowlist gate editable post-pairing (mirrors bridge
 *  _CHANNEL_ALLOW_ENV). WhatsApp's allowlist is container-GLOBAL (Baileys bridge
 *  reads one WHATSAPP_ALLOWED_USERS for all WA numbers) — the dialog still works,
 *  it just sets the gate for every WA account at once. */
const ACCESS_CAPABLE = new Set(["telegram", "discord", "slack", "whatsapp"]);

type AccessTarget = {
  channelId: string;
  channelLabel: string;
  accountId: string;
  agentId?: string;
};

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

/** Channels that support per-agent (synthetic) pairing — mirrors the bridge
 *  SYNTHETIC_SUPPORTED set. A non-default agent can only pair these. */
const SYNTHETIC_SUPPORTED = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "google_chat",
  "email",
]);

type RoutedAccount = {
  accountId: string;
  accountLabel: string;
  connected: boolean;
  reason: "explicit" | "default";
  synthetic: boolean;
  phone?: string | null;
  botId?: string | null;
  displayName?: string | null;
};

/** Human-facing identity line per account — number / bot-id + the account slug,
 *  so the user knows EXACTLY which account is connected (multi-account safe).
 *  Works for every channel: WA → phone, Telegram → bot id, others → slug. */
function formatAccountIdentity(acc: RoutedAccount): string | null {
  const parts: string[] = [];
  if (acc.phone) parts.push(`+${String(acc.phone).replace(/^\+/, "")}`);
  if (acc.botId) parts.push(`Bot ID ${acc.botId}`);
  if (acc.displayName && acc.displayName !== acc.accountLabel) {
    parts.push(acc.displayName);
  }
  parts.push(`account: ${acc.accountId}`);
  return parts.join(" · ");
}
type RoutedChannel = {
  channelId: string;
  channelLabel: string;
  emoji?: string;
  entry: ChannelDashboardEntryResponse;
  accounts: RoutedAccount[];
};

export function AgentSaluranPanel({
  agent,
  defaultId,
  setToast,
}: {
  agent: AgentRow;
  defaultId: string;
  setToast: ToastSetter;
}) {
  const dashboard = useChannelsDashboard();
  const isDefault = agent.id === defaultId;
  const agentLabel = getAgentDisplayName(agent);

  const [showPicker, setShowPicker] = useState(false);
  const [pairingEntry, setPairingEntry] = useState<ChannelCatalogEntry | null>(
    null,
  );
  const [logoutTarget, setLogoutTarget] = useState<LogoutTarget | null>(null);
  const [accessTarget, setAccessTarget] = useState<AccessTarget | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Merge native (connectedChannels) + synthetic (profiles[agent.id]) accounts
  // routed to THIS agent. Dedup by channelId+accountId.
  const routedChannels = useMemo<RoutedChannel[]>(() => {
    const data = dashboard.data;
    if (!data) return [];
    const byChannel = new Map<string, RoutedChannel>();
    const seen = new Set<string>();

    const pushAccount = (
      entry: ChannelDashboardEntryResponse,
      acc: ChannelAccountResponse,
      reason: "explicit" | "default",
      synthetic: boolean,
    ) => {
      const dedupeKey = `${entry.channelId}::${acc.accountId}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      let row = byChannel.get(entry.channelId);
      if (!row) {
        const catalog = getChannelCatalog(entry.channelId);
        row = {
          channelId: entry.channelId,
          channelLabel: entry.label,
          emoji: catalog?.emoji,
          entry,
          accounts: [],
        };
        byChannel.set(entry.channelId, row);
      }
      row.accounts.push({
        accountId: acc.accountId,
        accountLabel: acc.name || acc.displayName || acc.accountId,
        connected: !!acc.connected || !!acc.running,
        reason,
        synthetic,
        phone: acc.phone,
        botId: acc.botId,
        displayName: acc.displayName,
      });
    };

    // 1) Native channels — routes to this agent via binding or default.
    for (const channel of data.connectedChannels) {
      for (const acc of channel.accounts) {
        const effective = acc.routedAgentId ?? defaultId;
        if (effective !== agent.id) continue;
        pushAccount(
          channel,
          acc,
          acc.routedAgentId ? "explicit" : "default",
          false,
        );
      }
    }

    // 2) Synthetic per-agent accounts — platforms.<base>__<agent>.
    const mine = data.profiles?.[agent.id];
    if (mine) {
      for (const channel of mine.channels) {
        for (const acc of channel.accounts) {
          pushAccount(channel, acc, "explicit", true);
        }
      }
    }

    return Array.from(byChannel.values());
  }, [dashboard.data, agent.id, defaultId]);

  // Per-agent channel attention (error / reconnect-loop / disconnected) —
  // surfaces WHY a channel is down. Migrated from /app/channels' AttentionBanner,
  // scoped to THIS agent's routed channels.
  const attention = useMemo(() => {
    const items: Array<{
      channelId: string;
      label: string;
      reason: string;
      critical: boolean;
    }> = [];
    for (const ch of routedChannels) {
      const s = ch.entry.summary;
      if (s?.hasError) {
        items.push({
          channelId: ch.channelId,
          label: ch.channelLabel,
          reason: "Token / connection issue",
          critical: false,
        });
      } else if (s?.hasReconnectLoop) {
        items.push({
          channelId: ch.channelId,
          label: ch.channelLabel,
          reason: "Repeated reconnect loop",
          critical: false,
        });
      } else if (
        ch.accounts.length > 0 &&
        ch.accounts.every((a) => !a.connected)
      ) {
        items.push({
          channelId: ch.channelId,
          label: ch.channelLabel,
          reason: "Disconnected — not online",
          critical: true,
        });
      }
    }
    return items;
  }, [routedChannels]);

  // Channels offered in the "Pasang Saluran" picker.
  const pickerChannels = useMemo(() => {
    return CHANNEL_CATALOG.filter((c) => {
      if (c.comingSoon) return false;
      // Non-default agents can only pair channels with synthetic support.
      if (!isDefault && !SYNTHETIC_SUPPORTED.has(c.id)) return false;
      return true;
    });
  }, [isDefault]);

  const existingAccountIdsFor = (channelId: string): string[] => {
    const row = routedChannels.find((r) => r.channelId === channelId);
    return row ? row.accounts.map((a) => a.accountId) : [];
  };

  // Direct synthetic logout — removes ONLY platforms.<base>__<account>.
  const handleSyntheticLogout = async (
    channelId: string,
    accountId: string,
    label: string,
  ) => {
    const key = `${channelId}::${accountId}`;
    setBusyKey(key);
    try {
      const client = getClient();
      if (!client) throw new Error("Gateway not connected");
      await client.request("channels.logout", {
        channel: channelId,
        accountId,
        agentId: agent.id,
      });
      setToast({ kind: "success", text: `"${label}" disconnected` });
    } catch (err) {
      setToast({
        kind: "error",
        text: `Failed to disconnect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      setBusyKey(null);
      setConfirmKey(null);
      void dashboard.refetch();
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Header */}
      <section className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.06] via-[#0B0E14]/40 to-fuchsia-400/[0.04] p-5">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-white">
              Channels for this agent
            </h3>
            <p className="mt-1 text-[12.5px] text-white/65">
              WhatsApp/Telegram/etc. routed to{" "}
              <span className="font-semibold text-white/85">{agentLabel}</span>.
              Connect and manage them right here.
              {isDefault ? (
                <>
                  {" "}
                  Since this is the default agent, accounts without an explicit
                  binding are included automatically.
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPicker((v) => !v)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-3.5 py-1.5 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.5)] transition hover:brightness-110"
            >
              <Plus className="size-3.5" aria-hidden />
              Connect Channel
            </button>
          </div>
        </header>

        {/* Inline channel picker */}
        {showPicker ? (
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              Choose a channel for {agentLabel}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {pickerChannels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setPairingEntry(c);
                    setShowPicker(false);
                  }}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-cyan-400/40 hover:bg-white/[0.06]"
                >
                  <span className="text-lg">{c.emoji}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-white/90">
                      {c.label}
                    </span>
                    {c.multiAccount ? (
                      <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-cyan-200/60">
                        multi-account
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            {!isDefault ? (
              <p className="mt-2 text-[11px] text-white/45">
                Other channels (Signal/iMessage/etc.) can only be connected on
                the default agent.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Per-agent attention — why a channel is down (error/reconnect/offline) */}
      {attention.length > 0 ? (
        <div className="space-y-1.5">
          {attention.map((a) => (
            <div
              key={`${a.channelId}-${a.reason}`}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]",
                a.critical
                  ? "border-red-500/40 bg-red-500/[0.08] text-red-100"
                  : "border-amber-400/40 bg-amber-400/[0.08] text-amber-100",
              )}
            >
              <span
                className={cn(
                  "inline-block size-1.5 shrink-0 rounded-full",
                  a.critical ? "bg-red-400" : "bg-amber-400",
                )}
                aria-hidden
              />
              <span className="font-semibold">{a.label}</span>
              <span className="text-white/70">— {a.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Routed channels */}
      {dashboard.isLoading && routedChannels.length === 0 ? (
        <div className="space-y-2">
          <div className="h-24 animate-pulse rounded-xl bg-white/[0.02]" />
          <div className="h-24 animate-pulse rounded-xl bg-white/[0.02]" />
        </div>
      ) : routedChannels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-10 text-center">
          <Radio className="mx-auto size-8 text-white/30" aria-hidden />
          <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
            No channels yet
          </div>
          <p className="mt-1 max-w-sm mx-auto text-[12.5px] text-white/55">
            Connect a WhatsApp/Telegram/etc. account to {agentLabel} — incoming
            messages will be answered automatically by this agent.
          </p>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-2 text-[12px] font-bold text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.5)] transition hover:brightness-110"
          >
            <Plus className="size-3.5" aria-hidden />
            Connect Channel
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {routedChannels.map((ch) => (
            <li
              key={ch.channelId}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-lg">
                  {ch.emoji || (
                    <Radio className="size-4 text-cyan-300" aria-hidden />
                  )}
                </div>
                <div className="flex-1">
                  <div className="text-[13.5px] font-semibold text-white/90">
                    {ch.channelLabel}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                    {ch.accounts.length} account{ch.accounts.length !== 1 ? "s" : ""}
                  </div>
                </div>
                {SYNTHETIC_SUPPORTED.has(ch.channelId) ? (
                  <button
                    type="button"
                    onClick={() => {
                      const entry = getChannelCatalog(ch.channelId);
                      if (entry) setPairingEntry(entry);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-cyan-100 transition hover:border-cyan-400/50 hover:bg-cyan-400/15"
                    title="Add another account"
                  >
                    <Plus className="size-3" aria-hidden />
                    Account
                  </button>
                ) : null}
              </div>

              <ul className="mt-3 space-y-1.5">
                {ch.accounts.map((acc) => {
                  const key = `${ch.channelId}::${acc.accountId}`;
                  const confirming = confirmKey === key;
                  const busy = busyKey === key;
                  return (
                    <li
                      key={acc.accountId}
                      className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                    >
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          acc.connected
                            ? "bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]"
                            : "bg-white/30",
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-white/85">
                          {acc.accountLabel}
                        </div>
                        <div className="truncate font-mono text-[10px] text-white/45">
                          {formatAccountIdentity(acc)}
                        </div>
                      </div>
                      {acc.reason === "explicit" ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-400/[0.06] px-2 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-200/85">
                          bound
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/[0.06] px-2 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-200/85">
                          <Star className="size-2.5 fill-current" aria-hidden />
                          via default
                        </span>
                      )}

                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        {/* Atur akses — siapa yang boleh chat (allowlist).
                            Available for sender-gated channels, BOTH explicit
                            and "ikut default" accounts (the gate is per channel
                            env, editable without re-pairing). */}
                        {ACCESS_CAPABLE.has(ch.channelId) ? (
                          <button
                            type="button"
                            onClick={() =>
                              setAccessTarget({
                                channelId: ch.channelId,
                                channelLabel: ch.channelLabel,
                                accountId: acc.accountId,
                                agentId: acc.synthetic ? agent.id : "default",
                              })
                            }
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-200/85 transition hover:border-cyan-400/50 hover:bg-cyan-400/15"
                            title="Manage who can chat"
                          >
                            <Shield className="size-2.5" aria-hidden />
                            Access
                          </button>
                        ) : null}

                        {/* Putuskan — disconnect this account. "ikut default"
                            accounts appear ONLY in the default agent's view and
                            ARE its own native channels, so the default bot's
                            channel is removable here too (native LogoutDialog;
                            synthetic → channels.logout). */}
                        {confirming ? (
                            <div className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/15 px-1.5 py-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  if (acc.synthetic) {
                                    void handleSyntheticLogout(
                                      ch.channelId,
                                      acc.accountId,
                                      acc.accountLabel,
                                    );
                                  } else {
                                    setConfirmKey(null);
                                    setLogoutTarget({
                                      kind: "single-account",
                                      entry: ch.entry,
                                      accountId: acc.accountId,
                                      accountLabel: acc.accountLabel,
                                    });
                                  }
                                }}
                                disabled={busy}
                                className="inline-flex items-center gap-1 rounded bg-red-500 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
                              >
                                {busy ? (
                                  <Loader2
                                    className="size-3 animate-spin"
                                    aria-hidden
                                  />
                                ) : null}
                                Confirm?
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmKey(null)}
                                className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
                                aria-label="Cancel"
                              >
                                <X className="size-2.5" aria-hidden />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmKey(key)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-500/25 bg-red-500/[0.06] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-red-200/85 transition hover:border-red-500/50 hover:bg-red-500/15"
                              title="Disconnect this account"
                            >
                              <Unplug className="size-2.5" aria-hidden />
                              Disconnect
                            </button>
                          )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {/* Inline pairing — locked to this agent */}
      {pairingEntry ? (
        <PairingDialog
          open={!!pairingEntry}
          entry={pairingEntry}
          existingAccountIds={existingAccountIdsFor(pairingEntry.id)}
          defaultAgentId={agent.id}
          onClose={() => setPairingEntry(null)}
          onSuccess={(info) => {
            setPairingEntry(null);
            setToast({
              kind: "success",
              text: `${info.channelLabel} connected to ${agentLabel}`,
            });
            void dashboard.refetch();
          }}
        />
      ) : null}

      {/* Native logout (default agent's channels) */}
      <LogoutDialog
        open={!!logoutTarget}
        target={logoutTarget}
        onClose={() => {
          setLogoutTarget(null);
          void dashboard.refetch();
        }}
      />

      {/* Edit who-may-chat (allowlist) for an already-paired account */}
      <AccessControlDialog
        open={!!accessTarget}
        channelId={accessTarget?.channelId ?? ""}
        channelLabel={accessTarget?.channelLabel ?? ""}
        accountId={accessTarget?.accountId}
        agentId={accessTarget?.agentId}
        onClose={() => setAccessTarget(null)}
        onSaved={() => {
          setToast({ kind: "success", text: "Chat access saved" });
          void dashboard.refetch();
        }}
      />
    </div>
  );
}
