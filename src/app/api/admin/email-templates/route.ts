import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";
import {
  TEMPLATE_KEYS,
  emailTemplateDefault,
  loadEmailCopyOverrides,
  type Locale,
  type TemplateKey,
} from "@/lib/email/templates";

// D15 — admin email-template copy editor. Per (templateKey, locale) override of
// the compiled-in Variant; GET shows defaults + overrides, PUT upserts, DELETE
// resets. Templates read the override via an in-memory cache reloaded here.
export const dynamic = "force-dynamic";

const LOCALES: Locale[] = ["id", "en"];
const isKey = (k: string): k is TemplateKey =>
  TEMPLATE_KEYS.includes(k as TemplateKey);

// A field override: each optional, body as a string array. Empty/absent = use
// the compiled default for that field.
const fieldsSchema = z.object({
  subject: z.string().max(300).optional(),
  preheader: z.string().max(400).optional(),
  badge: z.string().max(80).optional(),
  heading: z.string().max(300).optional(),
  body: z.array(z.string().max(2000)).max(8).optional(),
  cta: z.string().max(80).optional(),
});

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const overrides = await db.select().from(schema.emailTemplateOverrides);
    const ovMap = new Map(
      overrides.map((o) => [`${o.templateKey}:${o.locale}`, o.fields]),
    );
    const templates = [];
    for (const key of TEMPLATE_KEYS) {
      for (const locale of LOCALES) {
        templates.push({
          templateKey: key,
          locale,
          default: emailTemplateDefault(locale, key),
          override: ovMap.get(`${key}:${locale}`) ?? null,
        });
      }
    }
    return Response.json({ templates });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      templateKey?: string;
      locale?: string;
      fields?: unknown;
    };
    const templateKey = String(body.templateKey ?? "");
    const locale = String(body.locale ?? "");
    if (!isKey(templateKey) || (locale !== "id" && locale !== "en")) {
      return Response.json({ error: "INVALID_TARGET" }, { status: 400 });
    }
    const parsed = fieldsSchema.safeParse(body.fields);
    if (!parsed.success) {
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    // Drop empty fields so a blank input falls back to the compiled default.
    const fields = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) =>
        Array.isArray(v) ? v.some((s) => s.trim()) : String(v ?? "").trim(),
      ),
    );

    const now = new Date();
    if (Object.keys(fields).length === 0) {
      // Nothing to override -> behave like a reset (remove the row).
      await db
        .delete(schema.emailTemplateOverrides)
        .where(
          and(
            eq(schema.emailTemplateOverrides.templateKey, templateKey),
            eq(schema.emailTemplateOverrides.locale, locale),
          ),
        );
    } else {
      await db
        .insert(schema.emailTemplateOverrides)
        .values({ templateKey, locale, fields, updatedBy: actor.id, updatedAt: now })
        .onConflictDoUpdate({
          target: [
            schema.emailTemplateOverrides.templateKey,
            schema.emailTemplateOverrides.locale,
          ],
          set: { fields, updatedBy: actor.id, updatedAt: now },
        });
    }
    await loadEmailCopyOverrides(); // immediate effect (single-process)
    auditLog({
      event: "admin.settings.update",
      outcome: "ok",
      actor: actor.id,
      target: `${templateKey}:${locale}`,
      details: { op: "email_template", fields: Object.keys(fields) },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const url = new URL(req.url);
    const templateKey = url.searchParams.get("templateKey") ?? "";
    const locale = url.searchParams.get("locale") ?? "";
    if (!isKey(templateKey) || (locale !== "id" && locale !== "en")) {
      return Response.json({ error: "INVALID_TARGET" }, { status: 400 });
    }
    await db
      .delete(schema.emailTemplateOverrides)
      .where(
        and(
          eq(schema.emailTemplateOverrides.templateKey, templateKey),
          eq(schema.emailTemplateOverrides.locale, locale),
        ),
      );
    await loadEmailCopyOverrides();
    auditLog({
      event: "admin.settings.update",
      outcome: "ok",
      actor: actor.id,
      target: `${templateKey}:${locale}`,
      details: { op: "email_template_reset" },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
