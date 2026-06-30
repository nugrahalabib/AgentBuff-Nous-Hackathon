"use client";

/**
 * useCronActions + useCronRunsList — wrappers untuk semua RPC cron.*.
 *
 * Engine RPCs verified `Reff/openclaw/src/gateway/server-methods/cron.ts`:
 *  - cron.add     { ...CronJobCreate }                        → CronJob
 *  - cron.update  { id, patch: CronJobPatch }                 → CronJob
 *  - cron.remove  { id }                                       → { removed }
 *  - cron.run     { id, mode?: "due" | "force" }              → { ok, ran, reason? }
 *  - cron.runs    { scope?, id?, limit?, offset?, statuses?,  → { entries, total?, hasMore? }
 *                   deliveryStatuses?, query?, sortDir? }
 *
 * Setiap mutasi auto-invalidate ["cron-list"] + ["cron-status"] biar UI sync
 * tanpa nunggu broadcast event.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getClient, useAppStore } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunStatus,
  CronRunsResult,
} from "@/components/app/cron/helpers";

export type CronActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function useCronActions() {
  const qc = useQueryClient();
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const invalidateAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["cron-list"] });
    void qc.invalidateQueries({ queryKey: ["cron-status"] });
  }, [qc]);

  const call = useCallback(
    async <T,>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<CronActionResult<T>> => {
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

  const add = useCallback(
    async (job: CronJobCreate): Promise<CronActionResult<CronJob>> => {
      setBusyAction("add");
      try {
        const res = await call<CronJob>("cron.add", job as Record<string, unknown>);
        if (res.ok) invalidateAll();
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, invalidateAll],
  );

  const update = useCallback(
    async (
      id: string,
      patch: CronJobPatch,
    ): Promise<CronActionResult<CronJob>> => {
      setBusyAction(`update-${id}`);
      try {
        const res = await call<CronJob>("cron.update", { id, patch });
        if (res.ok) invalidateAll();
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, invalidateAll],
  );

  const remove = useCallback(
    async (id: string): Promise<CronActionResult<{ removed: boolean }>> => {
      setBusyAction(`remove-${id}`);
      try {
        const res = await call<{ removed: boolean }>("cron.remove", { id });
        if (res.ok) invalidateAll();
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, invalidateAll],
  );

  const run = useCallback(
    async (
      id: string,
      mode: "due" | "force" = "force",
    ): Promise<CronActionResult<{ ok: boolean; ran: boolean; reason?: string }>> => {
      setBusyAction(`run-${id}`);
      try {
        const res = await call<{ ok: boolean; ran: boolean; reason?: string }>(
          "cron.run",
          { id, mode },
        );
        if (res.ok) invalidateAll();
        return res;
      } finally {
        setBusyAction(null);
      }
    },
    [call, invalidateAll],
  );

  const toggleEnabled = useCallback(
    async (id: string, next: boolean) => update(id, { enabled: next }),
    [update],
  );

  return {
    busyAction,
    isBusy: busyAction !== null,
    add,
    update,
    remove,
    run,
    toggleEnabled,
  };
}

/* ── Runs list (per-job or all) ─────────────────────────────────────── */

export type CronRunsListParams = {
  scope?: "job" | "all";
  jobId?: string;
  limit?: number;
  offset?: number;
  statuses?: CronRunStatus[];
  deliveryStatuses?: string[];
  query?: string;
  sortDir?: "asc" | "desc";
};

export function useCronRunsList(params: CronRunsListParams, enabled = true) {
  const status = useAppStore((s) => s.status);
  const stableKey = JSON.stringify(params);
  return useQuery<CronRunsResult>({
    queryKey: ["cron-runs", stableKey],
    enabled: status === "ready" && enabled,
    staleTime: 15_000,
    queryFn: async () => {
      const client = getClient();
      if (!client) throw new Error("Gateway belum tersambung");
      const body: Record<string, unknown> = {
        scope: params.scope ?? "all",
        limit: params.limit ?? 50,
        sortDir: params.sortDir ?? "desc",
      };
      if (params.jobId) body.id = params.jobId;
      if (params.offset) body.offset = params.offset;
      if (params.statuses?.length) body.statuses = params.statuses;
      if (params.deliveryStatuses?.length)
        body.deliveryStatuses = params.deliveryStatuses;
      if (params.query) body.query = params.query;
      return await client.request<CronRunsResult>("cron.runs", body);
    },
  });
}
