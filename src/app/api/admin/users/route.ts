import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

const PAGE_SIZE = 25;
const MAX_Q = 100;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

// Clamp client-supplied pageSize to a fixed allowlist — never trust the client.
function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])
    ? n
    : PAGE_SIZE;
}

// Admin user list (D1 User Hub). Read-only — admin AND support may read.
// Joins one-per-user tables (profile/container/trial) + the single active
// subscription (guarded by the partial-unique index, so the join yields ≤1 row).
export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = clampPageSize(url.searchParams.get("pageSize"));
    const offset = (page - 1) * pageSize;

    const search = q
      ? or(
          ilike(schema.users.email, `%${q}%`),
          ilike(schema.users.name, `%${q}%`),
        )
      : undefined;

    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        suspended: schema.users.suspended,
        createdAt: schema.users.createdAt,
        onboarded: schema.userProfiles.onboarded,
        nickname: schema.userProfiles.nickname,
        containerStatus: schema.userContainers.status,
        trialStatus: schema.userTrials.status,
        subTier: schema.subscriptions.tier,
        subStatus: schema.subscriptions.status,
      })
      .from(schema.users)
      .leftJoin(
        schema.userProfiles,
        eq(schema.userProfiles.userId, schema.users.id),
      )
      .leftJoin(
        schema.userContainers,
        eq(schema.userContainers.userId, schema.users.id),
      )
      .leftJoin(
        schema.userTrials,
        eq(schema.userTrials.userId, schema.users.id),
      )
      .leftJoin(
        schema.subscriptions,
        and(
          eq(schema.subscriptions.userId, schema.users.id),
          eq(schema.subscriptions.status, "active"),
        ),
      )
      .where(search)
      .orderBy(desc(schema.users.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [totalRow] = await db
      .select({ total: count() })
      .from(schema.users)
      .where(search);

    return Response.json({
      rows,
      page,
      pageSize,
      total: totalRow?.total ?? 0,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
