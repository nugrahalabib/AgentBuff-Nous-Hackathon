"use client";

/**
 * useSessionActions — wrappers untuk RPC sessions.{patch,reset,compact}.
 *
 * Bridge handlers (docker/hermes-bridge/rpc_router.py):
 *  - sessions.patch    { key, label?, thinkingLevel?, fastMode?, verboseLevel?, reasoningLevel? }
 *                      → label = direct SQLite UPDATE on sessions.title
 *                      → 4 behavior fields = slash commands (/reasoning, /fast,
 *                        /verbose) via Hermes slash.exec; persist to ~/.hermes/config.yaml
 *  - sessions.reset    { key, reason } → direct SQLite DELETE messages + reset counters
 *  - sessions.compact  { key } → forward to Hermes session.compress
 *
 * NOTE: sessions.compaction.{list,branch,restore} removed — Hermes engine doesn't
 * support session-level checkpoint lineage. Snapshots tab hidden in UI.
 *
 * Setiap action AUTO-refresh sessions list di store setelah sukses biar UI
 * sync (mis. token count update, label change visible di card).
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getClient, useAppStore } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import type { SessionsPatchPayload } from "@/lib/hermes/rpc-types";

export type ActionResult = { ok: true } | { ok: false; error: string };

export function useSessionActions() {
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const qc = useQueryClient();
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<ActionResult & { data?: T }> => {
      const client = getClient();
      if (!client) return { ok: false, error: "Gateway belum tersambung" };
      try {
        const data = await client.request<T>(method, params);
        return { ok: true, data };
      } catch (err) {
        const msg =
          err instanceof GatewayError
            ? err.message
            : err instanceof Error
              ? err.message
              : "RPC error";
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const patch = useCallback(
    async (
      key: string,
      payload: SessionsPatchPayload,
    ): Promise<ActionResult> => {
      setBusyAction("patch");
      try {
        const res = await call("sessions.patch", { key, ...payload });
        if (res.ok) {
          await refreshSessions();
        }
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, refreshSessions],
  );

  const rename = useCallback(
    async (key: string, label: string | null): Promise<ActionResult> => {
      // Empty string → null (clears manual label, falls back to derived title)
      const normalizedLabel = label === null || label.trim() === "" ? null : label.trim();
      return patch(key, { label: normalizedLabel });
    },
    [patch],
  );

  const reset = useCallback(
    async (
      key: string,
      reason: "new" | "reset" = "reset",
    ): Promise<ActionResult> => {
      setBusyAction("reset");
      try {
        const res = await call("sessions.reset", { key, reason });
        if (res.ok) {
          await refreshSessions();
        }
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, refreshSessions],
  );

  const compact = useCallback(
    async (key: string, maxLines?: number): Promise<ActionResult> => {
      setBusyAction("compact");
      try {
        const params: Record<string, unknown> = { key };
        if (maxLines != null) params.maxLines = maxLines;
        const res = await call("sessions.compact", params);
        if (res.ok) {
          await refreshSessions();
          // Invalidate compaction list cache for this key
          void qc.invalidateQueries({
            queryKey: ["session-compaction", key],
          });
        }
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, refreshSessions, qc],
  );

  return {
    busyAction,
    isBusy: busyAction !== null,
    patch,
    rename,
    reset,
    compact,
  };
}
