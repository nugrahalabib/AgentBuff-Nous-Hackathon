"use client";

/**
 * GatewayProvider — owns the GatewayClient lifecycle for the /app surface.
 *
 * Pattern (per ADR §D5):
 *  - ONE permanent event listener subscribes to the TWO parallel streams
 *    OpenClaw's gateway emits for a single assistant turn (corrected
 *    2026-04-24, see rpc-types.ts + CLAUDE.md §3.7.1 G4):
 *      • `event: "chat"`  → text-only deltas (state: delta/final/aborted/error)
 *      • `event: "agent"` → tool / thinking / lifecycle activity per frame
 *    A client that only listens to `chat` never renders tool activity /
 *    thinking until the transcript is re-read via `sessions.get` on hard
 *    refresh — which was the exact realtime-rendering bug users hit pre-patch.
 *  - Listener MUST be permanent because OpenClaw emits chat deltas AFTER the
 *    `chat.send` `res` frame resolves (wire gotcha G2).
 *  - On connect-ready we subscribe to session lifecycle events so the
 *    sidebar refreshes automatically when sessions appear / disappear
 *    (another tab, a cron run, a compaction, etc.).
 *  - React 19 strict-mode double-mount is tolerated: `client.stop()` on
 *    teardown + `client.start()` on fresh mount is idempotent at the wire
 *    layer.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  GatewayClient,
  type GatewayEvent,
} from "@/lib/hermes/browser-gateway";
import type {
  AgentEventPayload,
  ChatEventPayload,
} from "@/lib/hermes/rpc-types";
import {
  attachClient,
  detachClient,
  useAppStore,
} from "./store";

export function GatewayProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  useEffect(() => {
    const store = useAppStore.getState();

    // Hermes-only after full decommission (2026-05-21).
    // The portal proxies all `/app` traffic to the per-user Hermes
    // container's bridge (port 18789 inside container, published as the
    // per-user host loopback port). Bridge translates Hermes events into
    // OpenClaw-shaped wire frames so this file + downstream UI stay
    // unchanged from the OpenClaw era.
    const wsUrl =
      typeof window !== "undefined"
        ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws/hermes`
        : undefined;

    const client = new GatewayClient({
      url: wsUrl,
      onOpen: () => useAppStore.getState()._setStatus("connecting"),
      onReady: (payload) => {
        // Capture engine snapshot dari proxy.ready payload (forwarded dari
        // upstream gateway connect response). Snapshot berisi uptimeMs,
        // authMode, runtimeVersion, dan policy.tickIntervalMs — dipakai
        // Detail Engine zone tanpa extra RPC roundtrip.
        const p = (payload ?? {}) as {
          snapshot?: {
            uptimeMs?: number;
            authMode?: string;
            runtimeVersion?: string;
          } | null;
          policy?: { tickIntervalMs?: number } | null;
        };
        const snap = p.snapshot ?? null;
        const policy = p.policy ?? null;
        if (snap || policy) {
          useAppStore.getState()._setEngineSnapshot({
            uptimeMs: snap?.uptimeMs ?? null,
            authMode: snap?.authMode ?? null,
            runtimeVersion: snap?.runtimeVersion ?? null,
            tickIntervalMs: policy?.tickIntervalMs ?? null,
            receivedAt: new Date().toISOString(),
          });
        }
        useAppStore.getState()._setStatus("ready");
        void bootstrapAfterReady();
      },
      onClose: () => {
        useAppStore.getState()._setStatus("reconnecting");
        useAppStore.getState()._handleConnectionDrop();
      },
    });

    attachClient(client);
    store._setStatus("connecting");
    client.start();
    // Expose a thin bridge.request helper for non-React modules
    // (reactions.ts uses this for fire-and-forget cross-channel sync).
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          __agentbuffBridgeRequest?: (m: string, p: unknown) => Promise<unknown>;
        }
      ).__agentbuffBridgeRequest = (method, params) =>
        client.request(method, params as Record<string, unknown>);
    }

    const offChat = client.onEvent((evt: GatewayEvent) => {
      if (evt.event === "chat") {
        const payload = (evt.payload ?? {}) as ChatEventPayload;
        useAppStore.getState()._applyChatEvent(payload);
        // Wave 6-4I: voice mode auto-play. When voiceMode is ON and the
        // final assistant text just landed, generate TTS via bridge and
        // auto-play. Fire-and-forget; failure logged but doesn't block.
        if (payload.state === "final") {
          const st = useAppStore.getState();
          if (st.voiceMode) {
            const textContent = Array.isArray(payload.message?.content)
              ? payload.message.content
                  .filter(
                    (b: { type?: string; text?: string }) =>
                      b?.type === "text" && typeof b.text === "string",
                  )
                  .map((b: { text?: string }) => b.text ?? "")
                  .join("\n")
                  .trim()
              : "";
            if (textContent) {
              void st.playTTS(textContent).then((url) => {
                if (url && typeof window !== "undefined") {
                  try {
                    const audio = new Audio(url);
                    audio.play().catch(() => {});
                  } catch {
                    /* swallow */
                  }
                }
              });
            }
          }
        }
        // When a reply finishes we may have bootstrapped a brand-new session
        // (first message into "main" on a fresh container). Refresh the
        // sidebar so titles + updatedAt stay current. Fire-and-forget.
        if (payload.state === "final" || payload.state === "error") {
          const state = useAppStore.getState();
          void state.refreshSessions();
          // Hermes Gemini doesn't stream pre-tool chat.delta — the
          // assistant msg with content + tool_calls in raw JSON has
          // text that NEVER appears in the live event stream. Pull a
          // fresh history snapshot for the active session so any
          // pre-tool text bubble that Hermes saved server-side gets
          // surfaced without requiring the user to refresh the page.
          const key = payload.sessionKey ?? state.activeSessionKey;
          if (key) {
            // Brief delay so Hermes has flushed the DB row before we
            // re-read (sessions.get goes via raw JSON file path).
            setTimeout(() => {
              void useAppStore.getState().loadHistory(key, { force: true });
            }, 200);
          }
        }
        return;
      }
      // Parallel `agent` stream carries tool / thinking / lifecycle activity.
      // MUST be handled here or tool cards + reasoning only appear after a
      // hard refresh (sessions.get rehydrates from the persisted transcript).
      // ws-proxy already advertises `caps: ["tool-events"]` so gateway auto-
      // registers us as a tool-event recipient — no client-side subscribe.
      if (evt.event === "agent") {
        const payload = (evt.payload ?? {}) as AgentEventPayload;
        useAppStore.getState()._applyAgentEvent(payload);
        return;
      }
      // Gateway ALSO mirrors tool events to session subscribers as
      // `session.tool` (see Reff/openclaw/src/gateway/server-chat.ts:957).
      // Same AgentEventPayload shape. Belt-and-suspenders path: if the
      // tool-events cap registration ever misses (e.g. upstream changes the
      // `onAgentRunStart` handshake check), we still catch tool events here
      // because we called `sessions.subscribe` in bootstrapAfterReady.
      if (evt.event === "session.tool") {
        const payload = (evt.payload ?? {}) as AgentEventPayload;
        useAppStore.getState()._applyAgentEvent(payload);
        return;
      }
      if (evt.event === "sessions.changed") {
        void useAppStore.getState().refreshSessions();
      }
      // Bridge `sessions.activity` watcher — realtime monitoring of CHANNEL
      // conversations (WhatsApp/Telegram) that run in a separate process and
      // never stream to /app. Carries `workingSids` (sessions mid-reply) for
      // the live "working" indicator + `changedSids` so an OPEN channel thread
      // re-pulls its transcript without a manual refresh.
      if (evt.event === "sessions.activity") {
        const payload = (evt.payload ?? {}) as {
          workingSids?: string[];
          workingAgentIds?: string[];
          changedSids?: string[];
        };
        const st = useAppStore.getState();
        st._applySessionsActivity(
          payload.workingSids ?? [],
          payload.workingAgentIds ?? [],
        );
        const changed = payload.changedSids ?? [];
        if (changed.length) {
          const activeKey = st.activeSessionKey;
          const activeRow = st.sessions.find((r) => r.key === activeKey);
          // Reload the OPEN thread only when the change came from OUTSIDE this
          // tab (a channel turn, or another device) — i.e. NOT while you are
          // locally chatting in it. The chat-event path already maintains the
          // active session's live transcript; reloading mid-stream would wipe
          // the streaming bubble and (pre-fix) fire a slow sessions.get storm.
          const locallyBusy =
            Boolean(st.streaming[activeKey]) || Boolean(st.sending[activeKey]);
          if (
            !locallyBusy &&
            activeRow?.sessionId &&
            changed.includes(activeRow.sessionId)
          ) {
            setTimeout(() => {
              const s2 = useAppStore.getState();
              if (s2.streaming[activeKey] || s2.sending[activeKey]) return;
              void s2.loadHistory(activeKey, { force: true });
            }, 150);
          }
        }
        return;
      }
      // Wave 6-2E: bridge broadcasts message.edited / message.deleted
      // when handle_messages_edit / handle_messages_delete mutate the
      // session JSON. Update local cache so OTHER connected /app
      // clients (e.g. chief on phone + laptop) see the change live.
      if (evt.event === "message.edited") {
        const payload = (evt.payload ?? {}) as {
          sessionKey?: string;
          messageId?: string;
          newText?: string;
          editedAt?: number;
        };
        if (payload.sessionKey && payload.messageId) {
          useAppStore.setState((s) => {
            const list = s.messages[payload.sessionKey!];
            if (!list) return s;
            return {
              messages: {
                ...s.messages,
                [payload.sessionKey!]: list.map((m) =>
                  m.id === payload.messageId
                    ? {
                        ...m,
                        content: payload.newText ?? m.content,
                        editedAt: payload.editedAt ?? Date.now(),
                      }
                    : m,
                ),
              },
            };
          });
        }
        return;
      }
      if (evt.event === "message.deleted") {
        const payload = (evt.payload ?? {}) as {
          sessionKey?: string;
          messageId?: string;
          deletedAt?: number;
        };
        if (payload.sessionKey && payload.messageId) {
          useAppStore.setState((s) => {
            const list = s.messages[payload.sessionKey!];
            if (!list) return s;
            return {
              messages: {
                ...s.messages,
                [payload.sessionKey!]: list.map((m) =>
                  m.id === payload.messageId
                    ? { ...m, deleted: true, deletedAt: payload.deletedAt ?? Date.now() }
                    : m,
                ),
              },
            };
          });
        }
        return;
      }
      // Wave 6-1D cross-channel sync — bridge broadcasts reaction
      // changes from /app instances OR from Telegram/Discord (when
      // an upstream channel adapter forwards a reaction event).
      if (evt.event === "reaction.changed") {
        const payload = (evt.payload ?? {}) as {
          sessionKey?: string;
          messageId?: string;
          emoji?: string;
          userId?: string;
          add?: boolean;
        };
        if (
          payload.sessionKey &&
          payload.messageId &&
          payload.emoji &&
          payload.userId
        ) {
          void import("./reactions").then((m) =>
            m.receiveReactionEvent(
              payload.sessionKey!,
              payload.messageId!,
              payload.emoji!,
              payload.userId!,
              payload.add ?? true,
            ),
          );
        }
        return;
      }
    });

    async function bootstrapAfterReady() {
      const s = useAppStore.getState();
      try {
        // Subscribe to session lifecycle events so future changes push to us.
        await client.request("sessions.subscribe", {}).catch(() => {
          /* method is optional; ignore if gateway rejects */
        });
        // R2 — Reconnect tool sync. After a WS drop, the cached `messages`
        // for non-active sessions may be stale (tool calls that completed
        // server-side during the disconnect). Invalidate the cache for
        // every session EXCEPT the active one (which is force-reloaded
        // explicitly below). Next setActiveSession() will trigger a fresh
        // sessions.get and pull the up-to-date transcript.
        useAppStore.setState((prev) => {
          const active = prev.activeSessionKey;
          const keptMsg = active in prev.messages
            ? { [active]: prev.messages[active] }
            : {};
          return { messages: keptMsg };
        });
        await s.refreshSessions();

        // Fetch user-defined session folders (AgentBuff foldering feature).
        // Fire-and-forget — UI gracefully handles foldersLoaded=false.
        void s.refreshFolders();

        // C6 — Stale activeSessionKey post-restart guard.
        // After a container destroy + re-provision the persisted
        // `activeSessionKey` in localStorage may not exist on the new
        // server. Loading history for a stale key emits NOT_FOUND error
        // and leaves the UI on an "empty" thread. Defense: after
        // refreshSessions populates the list, check whether the active
        // key is present; if not, fall back to the newest session row
        // (auto-jump back to "main" feel), or to the default key when
        // there are no sessions at all.
        const after = useAppStore.getState();
        const currentKey = after.activeSessionKey;
        const inList = after.sessions.some((row) => row.key === currentKey);
        if (!inList && after.sessions.length > 0) {
          // sessions[] is sorted by updatedAt desc in refreshSessions, so the
          // first entry is the most recently-touched thread.
          const fallback = after.sessions[0].key;
          await after.setActiveSession(fallback);
        } else if (!inList) {
          // Empty list — keep the persisted key. The store's createSession
          // path (Ctrl+K / "Thread baru" CTA) will materialize it on demand.
        }

        // Force-reload history on every ready (first connect OR reconnect)
        // so a reconnect after the gateway received messages in another tab
        // / via a cron doesn't leave us with stale transcript.
        await s.loadHistory(useAppStore.getState().activeSessionKey, {
          force: true,
        });
        // After engine restart (config.patch trigger SIGUSR1), TanStack
        // queries below get stale because event broadcast bisa miss saat WS
        // disconnect window. Invalidate ALL dashboard queries supaya tab
        // surface (Saluran, Agent, Skill, dll) auto-refetch dengan fresh
        // state dari engine yang baru restart.
        qc.invalidateQueries({ queryKey: ["dashboard-channels"] });
        qc.invalidateQueries({ queryKey: ["dashboard-overview"] });
        qc.invalidateQueries({ queryKey: ["agents-list"] });
        qc.invalidateQueries({ queryKey: ["skills-status"] });
        qc.invalidateQueries({ queryKey: ["usage-status"] });
        qc.invalidateQueries({ queryKey: ["cron-list"] });

        // No-brain detection: does the container have ANY usable LLM provider
        // (a set API key OR an OAuth login)? If not, the agent can't chat — flag
        // it so the composer + Penyedia nav can guide the user to add a brain.
        try {
          const [ec, oa] = await Promise.allSettled([
            client.request<{ vars?: { key: string; isSet?: boolean }[] }>(
              "providers.envCatalog",
              {},
            ),
            client.request<{ providers?: { status?: { loggedIn?: boolean } }[] }>(
              "providers.oauthList",
              {},
            ),
          ]);
          const vars = ec.status === "fulfilled" ? (ec.value.vars ?? []) : [];
          const hasKey = vars.some((v) => v.key.endsWith("_API_KEY") && v.isSet);
          const ops = oa.status === "fulfilled" ? (oa.value.providers ?? []) : [];
          const hasOAuth = ops.some((p) => p.status?.loggedIn);
          useAppStore.getState().setNeedsBrain(!hasKey && !hasOAuth);
        } catch {
          /* non-fatal — don't block bootstrap on a provider-check failure */
        }
      } catch (err) {
        useAppStore
          .getState()
          ._setSessionsError(
            err instanceof Error ? err.message : String(err),
          );
      }
    }

    return () => {
      offChat();
      useAppStore.getState()._setStatus("closed");
      client.stop();
      detachClient();
    };
  // qc dari useQueryClient di-memoize oleh provider — referenc stabil per
  // mount, deps array OK kosong. Tapi lint react-hooks/exhaustive-deps
  // mungkin warn — kita nyatakan eksplisit di [] supaya GatewayProvider
  // tidak unmount-remount tiap render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children}</>;
}
