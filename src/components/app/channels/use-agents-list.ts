"use client";

/**
 * useAgentsList — fetch daftar agent dari engine via WS RPC `agents.list`.
 *
 * Pattern: TanStack Query keyed pada gateway connection status. Refetch
 * otomatis setelah engine restart (status balik ke "ready"). Dedup
 * cross-component (pairing dialog, connected card, settings) via queryKey.
 *
 * Engine RPC response shape (verified `agents.list` 2026-05-02):
 *   { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [...] }
 * Default fallback: kalau user belum declare agents.list di config, engine
 * still report 1 implicit "main" agent.
 */
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/lib/app/store";
import { getClient } from "@/lib/app/store";

export type AgentSummary = {
  id: string;
  name?: string;
  workspace?: string;
  model?: { primary?: string; fallbacks?: string[] } | string;
  isDefault?: boolean;
};

export type AgentsListPayload = {
  defaultId: string;
  mainKey: string;
  scope?: string;
  agents: AgentSummary[];
};

export function useAgentsList() {
  const status = useAppStore((s) => s.status);
  return useQuery({
    queryKey: ["gateway", "agents", "list"],
    enabled: status === "ready",
    staleTime: 30_000,
    queryFn: async (): Promise<AgentsListPayload> => {
      const client = getClient();
      if (!client) throw new Error("Gateway belum terhubung");
      const raw = await client.request<{
        defaultId?: string;
        mainKey?: string;
        scope?: string;
        agents?: AgentSummary[];
      }>("agents.list", {});
      const agents = Array.isArray(raw?.agents) ? raw.agents : [];
      return {
        defaultId: raw?.defaultId ?? "main",
        mainKey: raw?.mainKey ?? "main",
        scope: raw?.scope,
        agents,
      };
    },
  });
}

/**
 * Format agent display name. Untuk implicit "main" agent (id === defaultId
 * dan name kosong), pakai i18n-friendly default. Untuk user-declared agent,
 * pakai `name ?? id`.
 */
export function formatAgentLabel(
  agent: AgentSummary,
  isDefault: boolean,
): string {
  const base = agent.name?.trim() || agent.id;
  return isDefault ? `${base} (default)` : base;
}
