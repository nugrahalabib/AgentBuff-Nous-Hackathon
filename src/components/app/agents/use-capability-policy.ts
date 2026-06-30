"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { setCapabilityPolicy, type CapabilityPolicy } from "./capability-tiers";

// D13 — hydrate the capability predicate store (capability-tiers.ts) with the
// admin policy ONCE. Defaults are empty (mirror engine), so before this resolves
// the picker shows everything as today; once it lands, any admin hide/lock applies
// on the next render. Cached 5 min; fails silently (predicates keep their default).
export function useCapabilityPolicyHydration(): void {
  const { data } = useQuery({
    queryKey: ["app", "capability-policy"],
    queryFn: async (): Promise<CapabilityPolicy> => {
      const res = await fetch("/api/app/capability-policy");
      if (!res.ok) throw new Error("capability-policy fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (data) setCapabilityPolicy(data);
  }, [data]);
}
