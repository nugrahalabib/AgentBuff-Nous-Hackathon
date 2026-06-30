"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { apiFetch } from "./primitives";
import { errorToBahasa } from "./enums";
import { useToast } from "./overlay";

/** Standard admin list/detail query: apiFetch + keepPreviousData (no pagination
 *  flicker) + short staleTime. Pass a custom queryFn for non-GET shapes. */
export function useAdminQuery<T>(
  key: QueryKey,
  url: string,
  opts?: { enabled?: boolean; refetchInterval?: number; queryFn?: () => Promise<T> },
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: opts?.queryFn ?? (() => apiFetch<T>(url)),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled: opts?.enabled,
    refetchInterval: opts?.refetchInterval,
  });
}

/** Standard admin mutation: runs the call, toasts success/error (Bahasa), and
 *  invalidates the given query keys so the table/detail refreshes. */
export function useAdminMutation<TVars, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  opts?: {
    successMessage?: string | ((data: TData, vars: TVars) => string);
    invalidate?: QueryKey[];
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (err: unknown, vars: TVars) => void;
  },
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<TData, unknown, TVars>({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      const msg =
        typeof opts?.successMessage === "function"
          ? opts.successMessage(data, vars)
          : opts?.successMessage;
      if (msg) toast(msg, { tone: "ok" });
      opts?.invalidate?.forEach((k) => void qc.invalidateQueries({ queryKey: k }));
      opts?.onSuccess?.(data, vars);
    },
    onError: (err, vars) => {
      toast(errorToBahasa(err), { tone: "bad" });
      opts?.onError?.(err, vars);
    },
  });
}
