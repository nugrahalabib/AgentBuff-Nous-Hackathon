import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/constants";

// Public surface only. /loby + /billing/* + /api/* are auth-gated or
// server-only (robots.ts also disallows them). Patch notes get a higher
// changeFrequency because release cadence means they move most often.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteConfig.url;
  // Pinned content-snapshot date, NOT `new Date()`. A request-time timestamp
  // tells crawlers every page changed "just now" on every fetch, which is a
  // misleading lastModified signal. Bump this on meaningful content releases.
  const lastUpdated = new Date("2026-06-13");

  return [
    {
      url: `${base}/`,
      lastModified: lastUpdated,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${base}/login`,
      lastModified: lastUpdated,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${base}/register`,
      lastModified: lastUpdated,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/patch-notes`,
      lastModified: lastUpdated,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${base}/privacy`,
      lastModified: lastUpdated,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/terms`,
      lastModified: lastUpdated,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
