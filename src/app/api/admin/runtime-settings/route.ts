import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { resolveSetting, invalidateSettingCache } from "@/lib/admin/settings";
import { hermesConfig } from "@/lib/hermes/config";
import { auditLog } from "@/lib/security/audit-log";

// Admin runtime limits (D6/D7). Per-tier container resource caps + global trial
// duration, stored in admin_setting and read via resolveSetting (the matching ENV
// stays the fallback, so an unset key behaves exactly as today — zero regression).
// Read = admin/support; write = admin only.
//   Caps apply on the NEXT provision/restart (baked into docker run flags; running
//   containers keep their build-time caps — surfaced in the UI).
//   Trial duration applies to trials created AFTER the change; existing trials keep
//   their endsAt.
// Energy/rate-limit knobs are intentionally NOT here: energy is OFF (those knobs
// would control nothing today) and rate limits are abuse controls, not product
// knobs. See Docs/admin-prd.md.
const TIERS = ["starter", "op_buff", "guild_master"] as const;
// Memory cap bounds. Floor 256m avoids Docker's 6MB reject AND the "0m =
// unlimited" silent-uncap footgun (Docker treats --memory 0 as no limit);
// ceiling 64g is a sane upper bound. cpus/pids have their own floors below.
const MEM_MIN_MB = 256;
const MEM_MAX_MB = 65536; // 64g
function memMb(v: string): number | null {
  const m = /^(\d+)(m|g)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "g" ? n * 1024 : n;
}
const CAP_KEYS = [
  "limit.container.memory",
  "limit.container.cpus",
  "limit.container.pids",
] as const;
const CAP_FIELD: Record<string, "memory" | "cpus" | "pids"> = {
  "limit.container.memory": "memory",
  "limit.container.cpus": "cpus",
  "limit.container.pids": "pids",
};

export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    // Return the RAW per-tier override rows (not the resolved/effective value) so
    // the form pre-fills an input ONLY when a real override exists; a blank input
    // then means "use the env default" and saving it deletes the override. This
    // avoids writing override rows equal to the current default that would later
    // shadow a future env-default change.
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
          inArray(schema.adminSettings.key, [...CAP_KEYS]),
        ),
      );
    const overrides: Record<
      string,
      { memory?: string; cpus?: string; pids?: number }
    > = {};
    for (const r of rows) {
      const field = CAP_FIELD[r.key];
      if (!field) continue;
      (overrides[r.scopeId] ??= {})[field] = r.value as never;
    }

    const trialDurationDays = await resolveSetting(
      "limit.trial.durationDays",
      14,
      {},
    );
    return Response.json({
      overrides,
      trialDurationDays,
      defaults: {
        memory: hermesConfig.memoryLimit,
        cpus: hermesConfig.cpuLimit,
        pids: hermesConfig.pidsLimit,
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
  value: string | number | null; // null = delete the override (revert to ENV)
};

export async function PUT(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      caps?: Record<
        string,
        { memory?: unknown; cpus?: unknown; pids?: unknown }
      >;
      trialDurationDays?: unknown;
    };

    const ops: Op[] = [];
    const errors: string[] = [];

    for (const tier of TIERS) {
      const c = body.caps?.[tier];
      if (!c) continue;

      if (c.memory !== undefined) {
        const v = String(c.memory ?? "").trim().toLowerCase();
        if (v === "")
          ops.push({ key: "limit.container.memory", scope: "tier", scopeId: tier, value: null });
        else {
          const mb = memMb(v);
          if (mb !== null && mb >= MEM_MIN_MB && mb <= MEM_MAX_MB)
            ops.push({ key: "limit.container.memory", scope: "tier", scopeId: tier, value: v });
          else errors.push(`${tier}.memory`);
        }
      }

      if (c.cpus !== undefined) {
        const raw = String(c.cpus ?? "").trim();
        if (raw === "")
          ops.push({ key: "limit.container.cpus", scope: "tier", scopeId: tier, value: null });
        else {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0.25 && n <= 16)
            ops.push({ key: "limit.container.cpus", scope: "tier", scopeId: tier, value: String(n) });
          else errors.push(`${tier}.cpus`);
        }
      }

      if (c.pids !== undefined) {
        if (c.pids === "" || c.pids === null)
          ops.push({ key: "limit.container.pids", scope: "tier", scopeId: tier, value: null });
        else {
          const n = Math.trunc(Number(c.pids));
          if (Number.isFinite(n) && n >= 64 && n <= 8192)
            ops.push({ key: "limit.container.pids", scope: "tier", scopeId: tier, value: n });
          else errors.push(`${tier}.pids`);
        }
      }
    }

    if (body.trialDurationDays !== undefined) {
      const n = Math.trunc(Number(body.trialDurationDays));
      if (Number.isFinite(n) && n >= 1 && n <= 90)
        ops.push({ key: "limit.trial.durationDays", scope: "global", scopeId: "", value: n });
      else errors.push("trialDurationDays");
    }

    if (errors.length) {
      return Response.json({ error: "INVALID_VALUES", fields: errors }, { status: 400 });
    }

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
      details: { area: "runtime", count: ops.length },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
