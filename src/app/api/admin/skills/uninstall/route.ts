import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, uninstallSkill, GatewayRpcError } from "@/lib/hermes/gateway-client";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D4 — admin FORCE-UNINSTALL a skill from one user OR all users (massal). For
// moderation: pull a malicious/broken skill from running containers and stop the
// self-heal from resurrecting it on reprovision (adminUninstalledAt marker on the
// paid transaction). Admin-only mutation.
export const dynamic = "force-dynamic";

const MAX_BULK = 500;

type Outcome = {
  userId: string;
  ok: boolean;
  detail: string;
};

async function uninstallForUser(
  userId: string,
  skillKey: string,
): Promise<Outcome> {
  // 1. Look up the container. If it's running, best-effort uninstall from the
  //    live engine; if not, we still remove the DB record + block reinstall.
  const [c] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  let engineDetail = "container not running (db record removed)";
  // ok reflects the REAL moderation outcome: false only when the skill is still
  // live in a running engine (uninstall RPC failed) — so the bulk 'failed' tally
  // and per-user flags don't lie. DB cleanup + reinstall-block happen regardless.
  let engineFailed = false;
  if (c && c.status === "running" && c.gatewayToken) {
    try {
      await withGateway(
        {
          url: `ws://${hermesConfig.bindHost}:${c.port}/`,
          token: c.gatewayToken,
          clientId: "agentbuff-skill-uninstaller",
          role: "operator",
          userAgent: "agentbuff-portal/skill-uninstaller",
          connectTimeoutMs: 10_000,
          defaultCallTimeoutMs: 120_000,
        },
        async (client) => uninstallSkill(client, skillKey, { timeoutMs: 120_000 }),
      );
      engineDetail = "uninstalled from running container";
    } catch (e) {
      // Engine uninstall failed — still remove the DB record so the portal stops
      // advertising it; the skill files drop on the next reprovision (fresh volume).
      engineFailed = true;
      engineDetail =
        e instanceof GatewayRpcError
          ? `engine uninstall failed (rpc ${e.code}); db record removed, STILL LIVE in engine`
          : `engine uninstall failed (${e instanceof Error ? e.message : "unknown"}); db record removed, STILL LIVE in engine`;
    }
  }

  // 2. Remove the container_skill record + block self-heal reinstall by stamping
  //    the linked paid transaction. Do both regardless of engine reachability.
  const [removed] = await db
    .delete(schema.containerSkills)
    .where(
      and(
        eq(schema.containerSkills.userId, userId),
        eq(schema.containerSkills.skillKey, skillKey),
      ),
    )
    .returning({ transactionId: schema.containerSkills.transactionId });

  if (removed?.transactionId) {
    await db
      .update(schema.transactions)
      .set({ adminUninstalledAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.transactions.id, removed.transactionId));
  } else {
    // No transactionId link (bundled/legacy) — stamp any matching paid skill-install
    // tx for this user so a reprovision doesn't resurrect it via the sku path.
    await db
      .update(schema.transactions)
      .set({ adminUninstalledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.type, "skill-install"),
          eq(schema.transactions.sku, skillKey),
        ),
      );
  }

  return { userId, ok: !engineFailed, detail: engineDetail };
}

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  // Destructive cross-user op — rate-limit per admin.
  const rl = take(keyFromRequest("admin.skill.uninstall", req, actor.id), 10, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      skillKey?: string;
      userId?: string;
      all?: boolean;
    };
    const skillKey = (body.skillKey ?? "").trim().slice(0, 120);
    if (!skillKey) {
      return Response.json({ error: "MISSING_SKILL_KEY" }, { status: 400 });
    }
    const singleUser = body.userId?.trim();
    if (!singleUser && !body.all) {
      return Response.json(
        { error: "SCOPE_REQUIRED", hint: "pass userId for one user or all:true for massal" },
        { status: 400 },
      );
    }

    // Resolve the target user set from container_skill rows holding this skill.
    const rows = await db
      .select({ userId: schema.containerSkills.userId })
      .from(schema.containerSkills)
      .where(
        singleUser
          ? and(
              eq(schema.containerSkills.skillKey, skillKey),
              eq(schema.containerSkills.userId, singleUser),
            )
          : eq(schema.containerSkills.skillKey, skillKey),
      )
      // Deterministic order so a truncated massal run converges: re-invoking
      // all:true after fixing whatever blocked the first batch processes the
      // same leading set, then the next, rather than a random 500 each time.
      .orderBy(asc(schema.containerSkills.userId))
      .limit(MAX_BULK + 1);

    const userIds = [...new Set(rows.map((r) => r.userId))];
    if (userIds.length === 0) {
      return Response.json({
        ok: true,
        attempted: 0,
        removed: 0,
        failed: 0,
        results: [],
      });
    }
    const truncated = userIds.length > MAX_BULK;
    const targets = truncated ? userIds.slice(0, MAX_BULK) : userIds;

    // Sequential to avoid hammering many container gateways at once; per-user
    // failures are captured, never abort the batch.
    const results: Outcome[] = [];
    for (const uid of targets) {
      try {
        results.push(await uninstallForUser(uid, skillKey));
      } catch (e) {
        results.push({
          userId: uid,
          ok: false,
          detail: e instanceof Error ? e.message : "unknown error",
        });
      }
    }

    const removed = results.filter((r) => r.ok).length;
    const failed = results.length - removed;
    auditLog({
      event: "admin.skill.force_uninstall",
      outcome: failed > 0 ? "error" : "ok",
      actor: actor.id,
      target: skillKey,
      details: {
        scope: singleUser ? "single" : "massal",
        attempted: results.length,
        removed,
        failed,
        truncated,
      },
    });

    return Response.json({
      ok: true,
      // attempted = users we tried; removed = fully removed (incl. live engine);
      // failed = still live in a running engine. truncated => >500 holders, re-run
      // all:true to continue (deterministic order makes it converge).
      attempted: results.length,
      removed,
      failed,
      truncated,
      results,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
