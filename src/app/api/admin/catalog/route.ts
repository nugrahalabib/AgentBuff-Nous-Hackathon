import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { listSkills, invalidateCatalogCache } from "@/lib/billing/skill-catalog";
import { auditLog } from "@/lib/security/audit-log";

// D13 — first-party skill/app catalog admin CRUD. GET seeds (on first call) +
// lists; POST creates. Read = admin/support, write = admin only.
export const dynamic = "force-dynamic";

const CATEGORY = ["umkm", "creator", "produktivitas", "operasional", "riset"] as const;
const UNLOCK = ["skill", "tool", "plugin", "connector", "app"] as const;
const STATUS = ["available", "coming_soon"] as const;
const BILLING = ["one_time", "subscription"] as const;
const SOURCE = ["clawhub", "direct"] as const;
const ACCENT = ["cyan", "fuchsia", "amber", "emerald", "violet", "rose"] as const;

export const catalogEntrySchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string().trim().min(1).max(80),
  tagline: z.string().trim().max(120).default(""),
  description: z.string().trim().max(2000).default(""),
  priceRp: z.number().int().min(0).max(100_000_000),
  category: z.enum(CATEGORY),
  icon: z.string().trim().max(40).default("Package"),
  unlock: z.enum(UNLOCK).default("connector"),
  status: z.enum(STATUS).default("coming_soon"),
  byok: z.boolean().default(false),
  billing: z.enum(BILLING).default("one_time"),
  source: z.enum(SOURCE).default("direct"),
  version: z.string().trim().max(40).nullable().optional(),
  coverEmoji: z.string().trim().max(8).default("📦"),
  accent: z.enum(ACCENT).default("cyan"),
  featured: z.boolean().default(false),
  capabilities: z.array(z.string().trim().max(160)).max(12).default([]),
});

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    // listSkills seeds the table on first call, then returns the DB rows.
    const items = await listSkills();
    return Response.json({ items });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const parsed = catalogEntrySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    const d = parsed.data;
    try {
      await db.insert(schema.skillCatalog).values({
        key: d.key,
        title: d.title,
        tagline: d.tagline,
        description: d.description,
        priceRp: d.priceRp,
        category: d.category,
        icon: d.icon,
        unlock: d.unlock,
        status: d.status,
        byok: d.byok,
        billing: d.billing,
        source: d.source,
        version: d.version ?? null,
        coverEmoji: d.coverEmoji,
        accent: d.accent,
        featured: d.featured,
        capabilities: d.capabilities,
        updatedBy: actor.id,
      });
    } catch {
      return Response.json({ error: "KEY_EXISTS" }, { status: 409 });
    }
    invalidateCatalogCache();
    auditLog({
      event: "admin.catalog.create",
      outcome: "ok",
      actor: actor.id,
      target: d.key,
      details: { status: d.status, priceRp: d.priceRp },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
