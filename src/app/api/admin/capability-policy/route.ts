import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { invalidateSettingCache } from "@/lib/admin/settings";
import {
  resolveCapabilityPolicy,
  CAPABILITY_KEYS,
  type CapabilityPolicy,
} from "@/lib/admin/capability-policy";
import { auditLog } from "@/lib/security/audit-log";

// D13 — capability policy admin editor. Optional hide/lock lists for the /app
// agent picker. Read = admin/support; write = admin only. Empty list = no
// override (the row is deleted, behavior reverts to mirror-engine default).
export const dynamic = "force-dynamic";

// Bare keys/skill names: lowercase letters, digits, dash/underscore/dot/slash.
const keyArray = z
  .array(z.string().trim().toLowerCase().regex(/^[\w.\-/]{1,80}$/))
  .max(200);

const putSchema = z.object({
  hiddenSkills: keyArray.optional(),
  hiddenToolsets: keyArray.optional(),
  essentialToolsets: keyArray.optional(),
  essentialSkills: keyArray.optional(),
});

const FIELD_KEY: Record<keyof CapabilityPolicy, string> = {
  hiddenSkills: CAPABILITY_KEYS.hiddenSkills,
  hiddenToolsets: CAPABILITY_KEYS.hiddenToolsets,
  essentialToolsets: CAPABILITY_KEYS.essentialToolsets,
  essentialSkills: CAPABILITY_KEYS.essentialSkills,
};

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    return Response.json(await resolveCapabilityPolicy());
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );

    const now = new Date();
    const fields = Object.keys(parsed.data) as (keyof CapabilityPolicy)[];
    for (const field of fields) {
      const arr = parsed.data[field];
      if (arr === undefined) continue;
      const key = FIELD_KEY[field];
      // Dedupe; empty -> delete the override (revert to mirror-engine default).
      const unique = [...new Set(arr)];
      if (unique.length === 0) {
        await db
          .delete(schema.adminSettings)
          .where(
            and(
              eq(schema.adminSettings.key, key),
              eq(schema.adminSettings.scope, "global"),
              eq(schema.adminSettings.scopeId, ""),
            ),
          );
      } else {
        await db
          .insert(schema.adminSettings)
          .values({
            key,
            scope: "global",
            scopeId: "",
            value: unique,
            updatedBy: actor.id,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.adminSettings.key,
              schema.adminSettings.scope,
              schema.adminSettings.scopeId,
            ],
            set: { value: unique, updatedBy: actor.id, updatedAt: now },
          });
      }
    }

    invalidateSettingCache();
    auditLog({
      event: "admin.capability.update",
      outcome: "ok",
      actor: actor.id,
      details: { fields },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
