import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/constants";

// /basecamp is a design reference mock (CLAUDE.md §3.1) — not production,
// not a real product surface. Keep it out of the index so search traffic
// doesn't land on stale copy. /api/* is server-only. /loby + /billing/*
// require auth so they're worthless to crawlers; excluding saves crawl
// budget. /login + /register stay indexable for branded-search landing.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/basecamp", "/basecamp/", "/loby", "/billing/"],
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
    host: siteConfig.url,
  };
}
