"use client";

/**
 * AgentPicker — dropdown untuk pilih agent yang akan handle channel.
 *
 * Engine model: `agents.list[]` declared di config + 1 implicit "main"
 * fallback. Pairing dialog harus eksplisit minta user pilih supaya gak
 * surprise routing default. Kalau cuma 1 agent (typical fresh install),
 * tetep tampilkan dropdown disabled dengan "main (default)" — transparency
 * lebih penting dari "smart hide".
 *
 * Future: button "Buat agent baru" link ke /app/agents (belum dibangun).
 */
import { useEffect } from "react";
import { Bot, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useAppStore } from "@/lib/app/store";
import {
  useAgentsList,
  formatAgentLabel,
  type AgentSummary,
} from "./use-agents-list";

export type AgentPickerProps = {
  value: string;
  onChange: (agentId: string) => void;
  disabled?: boolean;
};

export function AgentPicker({ value, onChange, disabled }: AgentPickerProps) {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const { data, isLoading, error } = useAgentsList();

  // Auto-select default agent saat hook return data + value masih kosong.
  // Pairing dialog mount value='' → pertama kali data ready, isi dengan
  // defaultId. Setelah itu user bisa override.
  useEffect(() => {
    if (!data || value) return;
    onChange(data.defaultId);
  }, [data, value, onChange]);

  const isGatewayDown = status !== "ready";
  const agents: AgentSummary[] = data?.agents ?? [];
  const defaultId = data?.defaultId ?? "main";

  return (
    <div>
      <label className="block">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
          {t.app.channels.pairing.agentPickerLabel}
        </span>
        <div
          className={`mt-1.5 flex items-center gap-2 rounded-lg border bg-black/40 px-3 py-2 transition ${
            disabled || isGatewayDown
              ? "border-white/10 opacity-60"
              : "border-white/10 focus-within:border-cyan-400/50"
          }`}
        >
          <Bot className="size-3.5 shrink-0 text-cyan-300/70" aria-hidden />
          {isLoading || isGatewayDown ? (
            <span className="flex items-center gap-1.5 text-sm text-white/55">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t.app.channels.pairing.agentPickerLoading}
            </span>
          ) : error || agents.length === 0 ? (
            <span className="text-sm text-amber-200/85">
              {t.app.channels.pairing.agentPickerNoAgents}
            </span>
          ) : (
            <select
              value={value}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              className="flex-1 cursor-pointer appearance-none border-0 bg-transparent text-sm text-white outline-none disabled:cursor-not-allowed"
            >
              {agents.map((agent) => (
                <option
                  key={agent.id}
                  value={agent.id}
                  className="bg-[#0B0E14] text-white"
                >
                  {formatAgentLabel(agent, agent.id === defaultId)}
                </option>
              ))}
            </select>
          )}
        </div>
      </label>
      <p className="mt-1.5 text-[11px] text-white/40">
        {t.app.channels.pairing.agentPickerHelp}
      </p>
    </div>
  );
}
