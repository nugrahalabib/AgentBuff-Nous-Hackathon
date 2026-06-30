/**
 * GET /api/skills/buffhub/[slug]
 *
 * Fetch metadata for a single BuffHub item (Item Shop detail drawer).
 *
 * SINGLE SOURCE OF TRUTH: reads from `@/lib/billing/skill-catalog` — the same
 * module the list route + checkout + installer use. (Previously this had its
 * own hardcoded copy with different slugs; unified 2026-06-02.)
 *
 * No auth required (public metadata).
 */

import { NextResponse } from "next/server";
import { getSkill } from "@/lib/billing/skill-catalog";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const s = await getSkill(slug);
  if (!s) {
    return NextResponse.json({ error: "skill not found" }, { status: 404 });
  }
  return NextResponse.json({
    slug: s.key,
    name: s.title,
    tagline: s.tagline,
    description: s.description,
    category: s.category,
    priceRp: s.priceRp,
    icon: s.icon,
    unlock: s.unlock,
    status: s.status,
    byok: s.byok ?? false,
    billing: s.billing,
    version: s.version ?? null,
    source: s.source,
  });
}
