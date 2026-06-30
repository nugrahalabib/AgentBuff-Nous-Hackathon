import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { isEditableKey, validateBlockValue, getBlock, shapeMatches } from "@/lib/cms/blocks";
import { getAtPath } from "@/lib/i18n/apply-overrides";
import { invalidateCmsCache } from "@/lib/cms/resolve";
import { id } from "@/lib/i18n/dictionaries/id";
import { en } from "@/lib/i18n/dictionaries/en";
import { auditLog } from "@/lib/security/audit-log";

// D8 CMS — single editable block: GET current published/draft + the hardcoded
// default (for "current default" + reset), PUT to save a draft, publish, or
// reset to default. Read = admin/support; write = admin only. Key is validated
// against the editable allowlist (src/lib/cms/blocks.ts) — unknown keys 404.
export const dynamic = "force-dynamic";

function localeFrom(req: Request): "id" | "en" {
  const l = new URL(req.url).searchParams.get("locale");
  return l === "en" ? "en" : "id";
}
function dictFor(locale: "id" | "en") {
  return locale === "en" ? en : id;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const { key } = await params;
  if (!isEditableKey(key))
    return Response.json({ error: "UNKNOWN_KEY" }, { status: 404 });
  const locale = localeFrom(req);
  try {
    const [row] = await db
      .select({
        value: schema.cmsContent.value,
        draft: schema.cmsContent.draft,
        version: schema.cmsContent.version,
        publishedAt: schema.cmsContent.publishedAt,
      })
      .from(schema.cmsContent)
      .where(
        and(
          eq(schema.cmsContent.key, key),
          eq(schema.cmsContent.locale, locale),
        ),
      );
    return Response.json({
      key,
      locale,
      value: row?.value ?? null,
      draft: row?.draft ?? null,
      version: row?.version ?? 0,
      publishedAt: row?.publishedAt ?? null,
      // The compiled-in i18n value at this path — shown as the fallback and used
      // by "reset to default".
      defaultValue: getAtPath(dictFor(locale), key) ?? null,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const { key } = await params;
  if (!isEditableKey(key))
    return Response.json({ error: "UNKNOWN_KEY" }, { status: 404 });
  const locale = localeFrom(req);

  try {
    let body: { draft?: unknown; publish?: boolean; reset?: boolean };
    try {
      body = (await req.json()) as {
        draft?: unknown;
        publish?: boolean;
        reset?: boolean;
      };
    } catch {
      // Fail fast on an unparseable body instead of silently treating it as {}
      // (which would create a stray empty row downstream).
      return Response.json({ error: "INVALID_BODY" }, { status: 400 });
    }

    // Reset to default = remove the override entirely; landing falls back to the
    // hardcoded dictionary.
    if (body.reset) {
      await db
        .delete(schema.cmsContent)
        .where(
          and(
            eq(schema.cmsContent.key, key),
            eq(schema.cmsContent.locale, locale),
          ),
        );
      invalidateCmsCache();
      auditLog({
        event: "admin.cms.update",
        outcome: "ok",
        actor: actor.id,
        target: key,
        details: { key, locale, action: "reset" },
      });
      return Response.json({ ok: true, action: "reset" });
    }

    const hasDraft = Object.prototype.hasOwnProperty.call(body, "draft");
    const publish = body.publish === true;

    // Nothing actionable supplied — don't create a ghost row.
    if (!hasDraft && !publish)
      return Response.json({ ok: true, action: "noop" });

    // The value to validate/store: the supplied draft when present, else the
    // existing draft (publish-only call).
    const [existing] = await db
      .select({
        value: schema.cmsContent.value,
        draft: schema.cmsContent.draft,
      })
      .from(schema.cmsContent)
      .where(
        and(
          eq(schema.cmsContent.key, key),
          eq(schema.cmsContent.locale, locale),
        ),
      );

    const candidate = hasDraft ? body.draft : (existing?.draft ?? null);

    // Validate any non-null candidate. scalar/array use the block's zod schema;
    // json blocks are structurally checked against the compiled-in default node
    // (same keys/types) so a whole-section edit can't break the landing's shape.
    if (candidate != null) {
      const block = getBlock(key);
      if (block?.kind === "json") {
        const def = getAtPath(dictFor(locale), key);
        if (!shapeMatches(def, candidate))
          return Response.json({ error: "INVALID_VALUE", key }, { status: 400 });
      } else {
        const v = validateBlockValue(key, candidate);
        if (!v.ok)
          return Response.json({ error: "INVALID_VALUE", key }, { status: 400 });
      }
    }
    if (publish && candidate == null)
      return Response.json({ error: "NOTHING_TO_PUBLISH" }, { status: 400 });

    const now = new Date();
    await db.transaction(async (tx) => {
      if (publish) {
        // Promote candidate -> published value, clear the draft, bump version.
        await tx
          .insert(schema.cmsContent)
          .values({
            key,
            locale,
            value: candidate,
            draft: null,
            version: 1,
            publishedAt: now,
            updatedBy: actor.id,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.cmsContent.key, schema.cmsContent.locale],
            set: {
              value: candidate,
              draft: null,
              version: sql`${schema.cmsContent.version} + 1`,
              publishedAt: now,
              updatedBy: actor.id,
              updatedAt: now,
            },
          });
      } else {
        // Save draft only (published value untouched).
        await tx
          .insert(schema.cmsContent)
          .values({
            key,
            locale,
            draft: candidate,
            updatedBy: actor.id,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.cmsContent.key, schema.cmsContent.locale],
            set: { draft: candidate, updatedBy: actor.id, updatedAt: now },
          });
      }
    });

    invalidateCmsCache();
    auditLog({
      event: "admin.cms.update",
      outcome: "ok",
      actor: actor.id,
      target: key,
      details: { key, locale, action: publish ? "publish" : "draft" },
    });
    return Response.json({ ok: true, action: publish ? "publish" : "draft" });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
