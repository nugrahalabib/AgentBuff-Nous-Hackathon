import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// D8 CMS — list publish state for every (key, locale) row so the editor picker
// can badge what is published / has a pending draft. The editable-block catalog
// itself lives in src/lib/cms/blocks.ts (the editor imports it directly); this
// route only reports per-key state. Read = admin/support.
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const rows = await db
      .select({
        key: schema.cmsContent.key,
        locale: schema.cmsContent.locale,
        value: schema.cmsContent.value,
        draft: schema.cmsContent.draft,
        publishedAt: schema.cmsContent.publishedAt,
        updatedAt: schema.cmsContent.updatedAt,
      })
      .from(schema.cmsContent);

    return Response.json({
      rows: rows.map((r) => ({
        key: r.key,
        locale: r.locale,
        hasPublished: r.value != null,
        hasDraft: r.draft != null,
        publishedAt: r.publishedAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
