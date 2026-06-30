/**
 * GET /api/skills/buffhub
 *
 * BuffHub marketplace catalog — list all items for the Item Shop UI
 * (`/app/shop`) and the landing-page Item Shop section.
 *
 * SINGLE SOURCE OF TRUTH: this reads from `@/lib/billing/skill-catalog`, the
 * SAME module the checkout (`/api/billing/skill`) + installer use. Previously
 * this route hardcoded a SEPARATE list with different slugs, which meant the
 * Shop could show items the checkout couldn't find ("SKILL_NOT_FOUND"). Unified
 * 2026-06-02 so listing == checkout == installer, always.
 *
 * No auth required (public catalog). The actual purchase + install is
 * authenticated separately at `/api/billing/skill` (POST), which refuses
 * `coming_soon` SKUs.
 */

import { NextResponse } from "next/server";
import { listSkills } from "@/lib/billing/skill-catalog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Optional `?q=` keyword filter (matches name + tagline + slug only, so a
  // search for "pos" returns only POS-relevant skills, not the whole catalog).
  // Server-side filtering keeps results deterministic regardless of how an agent
  // constructs its request.
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const kws = q.split(/\s+/).filter(Boolean);

  const all = (await listSkills()).map((s) => ({
    slug: s.key,
    name: s.title,
    tagline: s.tagline,
    description: s.description,
    category: s.category,
    priceRp: s.priceRp,
    icon: s.icon,
    unlock: s.unlock,
    status: s.status, // "available" | "coming_soon"
    byok: s.byok ?? false,
    billing: s.billing,
    version: s.version ?? null,
    // Marketplace display
    coverEmoji: s.coverEmoji,
    accent: s.accent,
    featured: s.featured ?? false,
    capabilities: s.capabilities,
  }));

  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blobOf = (it: (typeof all)[number]) =>
    `${it.name} ${it.tagline} ${it.slug}`.toLowerCase();

  let items = all;
  if (kws.length > 0) {
    // Pass 1 — word-boundary match so "pos" hits "Kasir POS UMKM" but NOT
    // "proposal". This is the precise path and covers all demo keywords.
    items = all.filter((it) =>
      kws.some((k) => new RegExp(`\\b${esc(k)}\\b`).test(blobOf(it))),
    );
    // Pass 2 — if a partial keyword matched no whole word, fall back to substring
    // so the user never sees a false "no results" for a real intent.
    if (items.length === 0) {
      items = all.filter((it) => kws.some((k) => blobOf(it).includes(k)));
    }
  }

  return NextResponse.json({
    skills: items,
    generatedAt: new Date().toISOString(),
    totalCount: items.length,
    availableCount: items.filter((i) => i.status === "available").length,
  });
}
