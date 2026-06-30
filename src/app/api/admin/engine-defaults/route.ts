import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { invalidateSettingCache } from "@/lib/admin/settings";
import { ENGINE_DEFAULT_KEYS } from "@/lib/hermes/engine-defaults";
import { hermesConfig } from "@/lib/hermes/config";
import { auditLog } from "@/lib/security/audit-log";

// Admin engine defaults (D6). Per-tier model + lean-engine + auto-update, plus a
// global timezone default, stored in admin_setting and read by provisionContainer
// (resolveEngineDefaults) — the matching env stays the fallback, so an unset key
// behaves exactly as today (zero regression). Caps apply on the NEXT
// provision/restart; running containers keep their build-time env.
// Read = admin/support; write = admin only. seedDefaultKey (BYOK gate) is NOT
// exposed here — it stays an env-only safety control.
export const dynamic = "force-dynamic";

const TIERS = ["starter", "op_buff", "guild_master"] as const;
type Tier = (typeof TIERS)[number];

// Per-tier keys (model/lean/autoUpdate). timezone is global-only.
const TIER_KEYS = [
  ENGINE_DEFAULT_KEYS.model,
  ENGINE_DEFAULT_KEYS.leanEngine,
  ENGINE_DEFAULT_KEYS.autoUpdate,
] as const;
const TIER_FIELD: Record<string, "model" | "leanEngine" | "autoUpdate"> = {
  [ENGINE_DEFAULT_KEYS.model]: "model",
  [ENGINE_DEFAULT_KEYS.leanEngine]: "leanEngine",
  [ENGINE_DEFAULT_KEYS.autoUpdate]: "autoUpdate",
};

// A model id like "google/gemini-2.5-flash" or "anthropic/claude-opus-4-8". No
// spaces; the engine validates the rest. Length-capped.
const MODEL_RE = /^[\w.\-/:]{1,100}$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    // Raw per-tier override rows (not the resolved value) so an input pre-fills
    // ONLY when a real override exists; blank then means "use env default" and
    // saving it deletes the override.
    const tierRows = await db
      .select({
        key: schema.adminSettings.key,
        scopeId: schema.adminSettings.scopeId,
        value: schema.adminSettings.value,
      })
      .from(schema.adminSettings)
      .where(
        and(
          eq(schema.adminSettings.scope, "tier"),
          inArray(schema.adminSettings.key, [...TIER_KEYS]),
        ),
      );
    const overrides: Record<
      string,
      { model?: string; leanEngine?: boolean; autoUpdate?: boolean }
    > = {};
    for (const r of tierRows) {
      const field = TIER_FIELD[r.key];
      if (!field) continue;
      (overrides[r.scopeId] ??= {})[field] = r.value as never;
    }

    const [tzRow] = await db
      .select({ value: schema.adminSettings.value })
      .from(schema.adminSettings)
      .where(
        and(
          eq(schema.adminSettings.scope, "global"),
          eq(schema.adminSettings.scopeId, ""),
          eq(schema.adminSettings.key, ENGINE_DEFAULT_KEYS.timezone),
        ),
      );

    return Response.json({
      overrides,
      timezone: (tzRow?.value as string | undefined) ?? "",
      defaults: {
        model: hermesConfig.defaultModel,
        timezone: hermesConfig.timezone,
        leanEngine: hermesConfig.leanEngine,
        autoUpdate: hermesConfig.autoUpdate,
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

type Op = {
  key: string;
  scope: "global" | "tier";
  scopeId: string;
  value: string | boolean | null; // null = delete the override (revert to env)
};

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      engine?: Record<
        string,
        { model?: unknown; leanEngine?: unknown; autoUpdate?: unknown }
      >;
      timezone?: unknown;
    };

    const ops: Op[] = [];
    const errors: string[] = [];

    const boolOp = (key: string, tier: Tier, raw: unknown): void => {
      // null / "" / "default" => delete (revert to env). true/false => store.
      if (raw === null || raw === "" || raw === "default")
        ops.push({ key, scope: "tier", scopeId: tier, value: null });
      else if (typeof raw === "boolean")
        ops.push({ key, scope: "tier", scopeId: tier, value: raw });
      else errors.push(`${tier}.${TIER_FIELD[key]}`);
    };

    for (const tier of TIERS) {
      const e = body.engine?.[tier];
      if (!e) continue;

      if (e.model !== undefined) {
        const v = String(e.model ?? "").trim();
        if (v === "")
          ops.push({ key: ENGINE_DEFAULT_KEYS.model, scope: "tier", scopeId: tier, value: null });
        else if (MODEL_RE.test(v))
          ops.push({ key: ENGINE_DEFAULT_KEYS.model, scope: "tier", scopeId: tier, value: v });
        else errors.push(`${tier}.model`);
      }
      if (e.leanEngine !== undefined)
        boolOp(ENGINE_DEFAULT_KEYS.leanEngine, tier, e.leanEngine);
      if (e.autoUpdate !== undefined)
        boolOp(ENGINE_DEFAULT_KEYS.autoUpdate, tier, e.autoUpdate);
    }

    if (body.timezone !== undefined) {
      const v = String(body.timezone ?? "").trim();
      if (v === "")
        ops.push({ key: ENGINE_DEFAULT_KEYS.timezone, scope: "global", scopeId: "", value: null });
      else if (isValidTimezone(v))
        ops.push({ key: ENGINE_DEFAULT_KEYS.timezone, scope: "global", scopeId: "", value: v });
      else errors.push("timezone");
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
              eq(schema.adminSettings.scope, op.scope),
              eq(schema.adminSettings.scopeId, op.scopeId),
            ),
          );
      } else {
        await db
          .insert(schema.adminSettings)
          .values({
            key: op.key,
            scope: op.scope,
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
      details: { area: "engine-defaults", count: ops.length },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
