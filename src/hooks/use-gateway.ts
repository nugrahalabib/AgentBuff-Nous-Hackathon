"use client";

import { useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useGateway,
  useGatewayEvent,
} from "@/components/basecamp/bridge-provider";
import type { GatewayEvent } from "@/lib/hermes/browser-gateway";

// ───────────────────────────────────────────────────────────
// Chat / sessions — streaming
// ───────────────────────────────────────────────────────────

export interface ChatSendResult {
  sessionId?: string;
  reply?: string;
  role?: string;
}

/**
 * Submit a prompt to OpenClaw and collect streamed deltas. Returns the final
 * text. The caller subscribes to event frames via `onDelta`; the final `res`
 * carries the authoritative `reply` string.
 */
export function useGatewayChat() {
  const { client, status } = useGateway();
  const qc = useQueryClient();

  const sendStreaming = useCallback(
    async (prompt: string, onDelta?: (text: string) => void) => {
      if (!client) throw new Error("gateway not available");
      let accumulated = "";
      const handler = (evt: GatewayEvent) => {
        if (
          evt.event === "chat.delta" ||
          evt.event === "sessions.message.delta"
        ) {
          const payload = evt.payload as { text?: string } | undefined;
          if (payload?.text) {
            accumulated += payload.text;
            onDelta?.(accumulated);
          }
        }
      };
      try {
        const result = await client.stream<ChatSendResult | string>(
          "chat.send",
          { message: prompt, prompt },
          handler,
        );
        qc.invalidateQueries({ queryKey: ["energy"] });
        if (typeof result === "string") return result;
        return result?.reply ?? accumulated;
      } catch (err) {
        throw err;
      }
    },
    [client, qc],
  );

  return { sendStreaming, status, isReady: status === "ready" };
}

// ───────────────────────────────────────────────────────────
// Agents — list / create / update / delete
// ───────────────────────────────────────────────────────────

export interface GatewayAgent {
  id: string;
  name: string;
  role?: string;
  description?: string;
  icon?: string;
  color?: string;
  status?: string;
  channels?: string[];
  instructions?: string;
}

export function useGatewayAgents() {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "agents"],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      const res = await client.request<{ agents?: GatewayAgent[] } | GatewayAgent[]>(
        "agents.list",
      );
      return Array.isArray(res) ? res : (res?.agents ?? []);
    },
    enabled: status === "ready",
  });
}

export function useCreateGatewayAgent() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<GatewayAgent>) => {
      if (!client) throw new Error("gateway not available");
      return client.request<GatewayAgent>("agents.create", data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gateway", "agents"] }),
  });
}

export function useUpdateGatewayAgent() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: { id: string } & Partial<GatewayAgent>) => {
      if (!client) throw new Error("gateway not available");
      return client.request<GatewayAgent>("agents.update", { id, ...data });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gateway", "agents"] }),
  });
}

export function useDeleteGatewayAgent() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!client) throw new Error("gateway not available");
      return client.request<void>("agents.delete", { id });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gateway", "agents"] }),
  });
}

// ───────────────────────────────────────────────────────────
// Models / config — engine config
// ───────────────────────────────────────────────────────────

export interface GatewayModel {
  id: string;
  alias?: string;
  provider?: string;
}

export function useGatewayModels() {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "models"],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      const res = await client.request<{ models?: GatewayModel[] } | GatewayModel[]>(
        "models.list",
      );
      return Array.isArray(res) ? res : (res?.models ?? []);
    },
    enabled: status === "ready",
  });
}

export function useGatewayConfig() {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "config"],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      return client.request<Record<string, unknown>>("config.get");
    },
    enabled: status === "ready",
  });
}

export function usePatchGatewayConfig() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      if (!client) throw new Error("gateway not available");
      return client.request<Record<string, unknown>>("config.patch", patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gateway", "config"] }),
  });
}

// ───────────────────────────────────────────────────────────
// Channels — status / logout (login flow uses wizard.*)
// ───────────────────────────────────────────────────────────

export interface ChannelStatus {
  channel: string;
  connected: boolean;
  identity?: string;
  qr?: string;
}

export function useGatewayChannels() {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "channels"],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      const res = await client.request<{ channels?: ChannelStatus[] } | ChannelStatus[]>(
        "channels.status",
      );
      return Array.isArray(res) ? res : (res?.channels ?? []);
    },
    enabled: status === "ready",
  });
}

export function useLogoutGatewayChannel() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channel: string) => {
      if (!client) throw new Error("gateway not available");
      return client.request<void>("channels.logout", { channel });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gateway", "channels"] }),
  });
}

// ───────────────────────────────────────────────────────────
// Skills — search / install / status
// ───────────────────────────────────────────────────────────

export interface GatewaySkill {
  key: string;
  title?: string;
  description?: string;
  installed?: boolean;
}

export function useGatewaySkills(query?: string) {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "skills", query ?? ""],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      const res = await client.request<{ skills?: GatewaySkill[] } | GatewaySkill[]>(
        "skills.search",
        query ? { query } : undefined,
      );
      return Array.isArray(res) ? res : (res?.skills ?? []);
    },
    enabled: status === "ready",
  });
}

export function useInstallGatewaySkill() {
  const { client } = useGateway();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      if (!client) throw new Error("gateway not available");
      return client.request<GatewaySkill>("skills.install", { key });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gateway", "skills"] });
      qc.invalidateQueries({ queryKey: ["gateway", "agents"] });
    },
  });
}

// ───────────────────────────────────────────────────────────
// Usage / health
// ───────────────────────────────────────────────────────────

export function useGatewayUsage() {
  const { client, status } = useGateway();
  return useQuery({
    queryKey: ["gateway", "usage"],
    queryFn: async () => {
      if (!client) throw new Error("gateway not available");
      await client.waitReady();
      return client.request<Record<string, unknown>>("usage.status");
    },
    enabled: status === "ready",
  });
}

/**
 * Re-exports the event subscription hook for convenience so components can
 * import from a single module.
 */
export { useGatewayEvent };
