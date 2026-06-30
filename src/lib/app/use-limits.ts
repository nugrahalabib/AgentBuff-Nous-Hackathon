"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { setAttachmentLimits } from "./attachments";

// D7 — hydrate the per-tier media caps into the attachments module ONCE on /app
// load. Before this resolves (and on any failure) the composer uses the hardcoded
// defaults, so behavior is identical to today until the user's tier caps land.
// Cached 5 min; the bridge is the authoritative enforcer — this is UX only.

export type UserLimitsResponse = {
  tier: string;
  maxAgents: number;
  maxChannels: number;
  maxSkills: number;
  media: {
    imageMb: number;
    audioMb: number;
    videoMb: number;
    documentMb: number;
    filesPerMessage: number;
    totalMb: number;
  };
};

export function useLimitsHydration(): void {
  const { data } = useQuery({
    queryKey: ["app", "limits"],
    queryFn: async (): Promise<UserLimitsResponse> => {
      const res = await fetch("/api/users/me/limits");
      if (!res.ok) throw new Error("limits fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (data?.media) setAttachmentLimits(data.media);
  }, [data]);
}
