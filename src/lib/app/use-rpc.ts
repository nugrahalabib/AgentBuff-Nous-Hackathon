"use client";

/**
 * useRpc — generic hook for consuming Hermes JSON-RPC methods in tab
 * components. Pattern: component declares which method + params it needs;
 * hook fires the request on mount + whenever the connection transitions
 * back to "ready" (reconnect refetch), keeps loading/data/error state.
 *
 * Rationale: the M8 plan (ADR §D2) prescribes per-slice Zustand actions,
 * but scaffolding 17 slices up-front blocks the visible feature parity
 * the user demanded right now. This hook captures the minimum contract a
 * read-only tab needs while still respecting:
 *   - `getClient()` single transport (no duplicate WS).
 *   - Reconnect refetch via `status === "ready"` transition.
 *   - Stale-while-reload: previous `data` stays visible during refetch so
 *     tabs don't flash empty when the socket blips.
 *
 * Tabs that need event-driven live updates (cron, approvals, channels,
 * presence) also subscribe via `useRpcEvent` below, which hooks into the
 * GatewayClient's permanent `onEvent` listener without spawning new ones
 * (ADR §D5).
 *
 * Writes are NOT abstracted here — tabs call `getClient()?.request(...)`
 * directly for mutations, so error handling + optimistic update stays
 * local to the caller.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, getClient } from "./store";
import { GatewayError } from "@/lib/hermes/browser-gateway";

export type RpcState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T; loadedAt: number; stale?: boolean }
  | { kind: "error"; message: string };

export type UseRpcReturn<T> = {
  state: RpcState<T>;
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
};

export type UseRpcOptions<P> = {
  /** Method name (e.g. "agents.list"). */
  method: string;
  /** Params serialized fresh each render. Use `useMemo` to stabilize
   *  reference if params object is complex. */
  params?: P;
  /** Skip the call until this returns true. Default: always enabled. */
  enabled?: boolean;
  /** Re-fetch when any value in this array changes (shallow). Like
   *  TanStack Query's `queryKey`. Pass session key / tab-specific ids. */
  deps?: readonly unknown[];
};

export function useRpc<T, P = unknown>(
  opts: UseRpcOptions<P>,
): UseRpcReturn<T> {
  const { method, params, enabled = true, deps = [] } = opts;
  const status = useAppStore((s) => s.status);
  const [state, setState] = useState<RpcState<T>>({ kind: "idle" });
  const mountedRef = useRef(true);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // Monotonic request counter — guards against out-of-order resolutions. The
  // single WS transport dispatches handlers concurrently, so a slow earlier
  // request can resolve AFTER a newer one; without this, last-resolved-wins
  // would commit stale data (e.g. a pre-mutation poll landing after the
  // post-mutation refetch). Only the latest-issued request commits.
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!enabled) return;
    const client = getClient();
    if (!client) return;
    const seq = ++seqRef.current;
    setState((prev) =>
      prev.kind === "ready" ? { ...prev, stale: true } : { kind: "loading" },
    );
    try {
      const result = await client.request<T>(method, paramsRef.current);
      // Drop a resolution that a newer request has already superseded.
      if (!mountedRef.current || seq !== seqRef.current) return;
      setState({
        kind: "ready",
        data: result,
        loadedAt: Date.now(),
      });
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      const message =
        err instanceof GatewayError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Terjadi kesalahan tidak dikenal";
      setState({ kind: "error", message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, enabled]);

  // Initial fetch + refetch on ready transition + deps change.
  useEffect(() => {
    if (!enabled) return;
    if (status !== "ready") return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, run, enabled, ...deps]);

  return {
    state,
    data: state.kind === "ready" ? state.data : null,
    error: state.kind === "error" ? state.message : null,
    loading: state.kind === "loading",
    refetch: run,
  };
}

/**
 * Subscribe to gateway broadcast events scoped to the mounted tab.
 * Uses the single permanent `onEvent` subscription owned by GatewayClient.
 * The callback receives the event payload; return value is ignored.
 *
 * Important: DO NOT filter by sessionKey inside the callback unless you're
 * ready to match the namespaced form `"agent:<agentId>:<key>"` (G3). For
 * non-chat events the namespacing doesn't apply.
 */
export function useRpcEvent(
  eventName: string,
  handler: (payload: unknown) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    const off = client.onEvent((evt) => {
      if (evt.event !== eventName) return;
      handlerRef.current(evt.payload);
    });
    return () => {
      off();
    };
  }, [eventName]);
}
