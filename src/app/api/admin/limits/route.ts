import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { invalidateSettingCache } from "@/lib/admin/settings";
import { LIMIT_KEYS, LIMIT_DEFAULTS } from "@/lib/admin/limits";
import { auditLog } from "@/lib/security/audit-log";

// D7 — per-tier entitlement + media limits matrix. Stored in admin_setting
// (scope=tier), read by resolveUserLimits (the marketing-baseline defaults are
// the fallback, so a blank override behaves exactly as the default). Entitlement
// limits apply at the bridge enforcement gate; media caps apply on the next
// provision/restart + client UX. Read = admin/support; write = admin only.
export const dynamic = "force-dynamic";

const TIERS = ["starter", "op_buff", "guild_master"] as const;

// field name -> admin_setting key + validation bounds. -1 = unlimited for counts.
type FieldName =
  | "maxAgents" | "maxChannels" | "maxSkills"
  | "imageMb" | "audioMb" | "videoMb" | "documentMb" | "filesPerMessage" | "totalMb";

const FIELDS: Record<FieldName, { key: string; min: number; max: number }> = {
  maxAgents: { key: LIMIT_KEYS.maxAgents, min: -1, max: 10000 },
  maxChannels: { key: LIMIT_KEYS.maxChannels, min: -1, max: 10000 },
  maxSkills: { key: LIMIT_KEYS.maxSkills, min: -1, max: 10000 },
  imageMb: { key: LIMIT_KEYS.imageMb, min: 1, max: 4096 },
  audioMb: { key: LIMIT_KEYS.audioMb, min: 1, max: 4096 },
  videoMb: { key: LIMIT_KEYS.videoMb, min: 1, max: 4096 },
  documentMb: { key: LIMIT_KEYS.documentMb, min: 1, max: 4096 },
  filesPerMessage: { key: LIMIT_KEYS.filesPerMessage, min: 1, max: 100 },
  totalMb: { key: LIMIT_KEYS.totalMb, min: 1, max: 8192 },
};
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];
const KEY_TO_FIELD = new Map(FIELD_NAMES.map((f) => [FIELDS[f].key, f]));

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    // Raw per-tier override rows only — a field pre-fills ONLY when a real
    // override exists; blank = use the marketing-baseline default.
    const rows = await db
      .select({
        key: schema.adminSettings.key,
        scopeId: schema.adminSettings.scopeId,
        value: schema.adminSettings.value,
      })
      .from(schema.adminSettings)
      .where(
        and(
          eq(schema.adminSettings.scope, "tier"),
          inArray(schema.adminSettings.key, FIELD_NAMES.map((f) => FIELDS[f].key)),
        ),
      );
    const overrides: Record<string, Partial<Record<FieldName, number>>> = {};
    for (const r of rows) {
      const field = KEY_TO_FIELD.get(r.key);
      if (!field) continue;
      (overrides[r.scopeId] ??= {})[field] = r.value as number;
    }
    return Response.json({ overrides, defaults: LIMIT_DEFAULTS });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

type Op = { key: string; scopeId: string; value: number | null };

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      limits?: Record<string, Partial<Record<FieldName, unknown>>>;
    };
    const ops: Op[] = [];
    const errors: string[] = [];

    for (const tier of TIERS) {
      const t = body.limits?.[tier];
      if (!t) continue;
      for (const field of FIELD_NAMES) {
        if (!(field in t)) continue;
        const raw = t[field];
        // "" / null => delete the override (revert to the baseline default).
        if (raw === "" || raw === null || raw === undefined) {
          ops.push({ key: FIELDS[field].key, scopeId: tier, value: null });
          continue;
        }
        const n = Math.trunc(Number(raw));
        const { min, max } = FIELDS[field];
        if (Number.isFinite(n) && n >= min && n <= max)
          ops.push({ key: FIELDS[field].key, scopeId: tier, value: n });
        else errors.push(`${tier}.${field}`);
      }
    }

    if (errors.length)
      return Response.json({ error: "INVALID_VALUES", fields: errors }, { status: 400 });

    const now = new Date();
    for (const op of ops) {
      if (op.value === null) {
        await db
          .delete(schema.adminSettings)
          .where(
            and(
              eq(schema.adminSettings.key, op.key),
              eq(schema.adminSettings.scope, "tier"),
              eq(schema.adminSettings.scopeId, op.scopeId),
            ),
          );
      } else {
        await db
          .insert(schema.adminSettings)
          .values({
            key: op.key,
            scope: "tier",
            scopeId: op.scopeId,
            value: op.value,
            updatedBy: actor.id,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.adminSettings.key,
              schema.adminSettings.scope,
              schema.adminSettings.scopeId,
            ],
            set: { value: op.value, updatedBy: actor.id, updatedAt: now },
          });
      }
    }

    invalidateSettingCache();
    auditLog({
      event: "admin.settings.update",
      outcome: "ok",
      actor: actor.id,
      details: { area: "limits", count: ops.length },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
