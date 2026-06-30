import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { FLAG_CATALOG, isKnownFlag, invalidateFlagCache } from "@/lib/admin/flags";
import { auditLog } from "@/lib/security/audit-log";

// D13 feature/dev flags. Admin toggles runtime switches (global scope) read by
// resolveFlag — first consumer is maintenance mode (gates /app for non-staff).
// Read = admin/support; write = admin only. Keys are constrained to FLAG_CATALOG.
const VALUE_MAX = 2000;

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const keys = FLAG_CATALOG.map((f) => f.key);
    const rows = keys.length
      ? await db
          .select({
            key: schema.featureFlags.key,
            enabled: schema.featureFlags.enabled,
            value: schema.featureFlags.value,
          })
          .from(schema.featureFlags)
          .where(
            and(
              eq(schema.featureFlags.scope, "global"),
              inArray(schema.featureFlags.key, keys),
            ),
          )
      : [];
    const flags: Record<string, { enabled: boolean; value: unknown }> = {};
    for (const r of rows) flags[r.key] = { enabled: r.enabled, value: r.value };
    return Response.json({ catalog: FLAG_CATALOG, flags });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    let body: { key?: unknown; enabled?: unknown; value?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "INVALID_BODY" }, { status: 400 });
    }

    // A missing/non-string key is a malformed body (400), not a missing
    // resource (404) — keep the classification honest + consistent with the
    // enabled/value checks below.
    if (typeof body.key !== "string")
      return Response.json({ error: "INVALID_BODY" }, { status: 400 });
    const key = body.key;
    if (!isKnownFlag(key))
      return Response.json({ error: "UNKNOWN_FLAG" }, { status: 404 });
    if (typeof body.enabled !== "boolean")
      return Response.json({ error: "INVALID_ENABLED" }, { status: 400 });

    // Optional value: string (capped) or null. Anything else is rejected so a
    // value-bearing flag can't be stuffed with arbitrary payloads.
    let value: string | null = null;
    if (body.value !== undefined && body.value !== null) {
      if (typeof body.value !== "string" || body.value.length > VALUE_MAX)
        return Response.json({ error: "INVALID_VALUE" }, { status: 400 });
      value = body.value;
    }

    const now = new Date();
    await db
      .insert(schema.featureFlags)
      .values({
        key,
        scope: "global",
        scopeId: "",
        enabled: body.enabled,
        value,
        updatedBy: actor.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.featureFlags.key,
          schema.featureFlags.scope,
          schema.featureFlags.scopeId,
        ],
        set: { enabled: body.enabled, value, updatedBy: actor.id, updatedAt: now },
      });

    invalidateFlagCache();
    auditLog({
      event: "admin.flag.update",
      outcome: "ok",
      actor: actor.id,
      target: key,
      details: { key, enabled: body.enabled, value },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
