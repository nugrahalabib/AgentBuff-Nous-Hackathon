import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// Admin container fleet list (D5). Read-only — admin AND support may read.
export async function GET() {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const rows = await db
      .select({
        userId: schema.userContainers.userId,
        email: schema.users.email,
        status: schema.userContainers.status,
        port: schema.userContainers.port,
        containerName: schema.userContainers.containerName,
        imageVersion: schema.userContainers.imageVersion,
        errorMessage: schema.userContainers.errorMessage,
        provisionAttempts: schema.userContainers.provisionAttempts,
        lastHealthAt: schema.userContainers.lastHealthAt,
        balanceThrottledAt: schema.userContainers.balanceThrottledAt,
        createdAt: schema.userContainers.createdAt,
      })
      .from(schema.userContainers)
      .leftJoin(schema.users, eq(schema.users.id, schema.userContainers.userId))
      .orderBy(desc(schema.userContainers.createdAt))
      .limit(500);

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

    const [poolTotal] = await db
      .select({ c: count() })
      .from(schema.containerPortSlots);
    const [poolClaimed] = await db
      .select({ c: count() })
      .from(schema.containerPortSlots)
      .where(sql`${schema.containerPortSlots.userId} IS NOT NULL`);

    return Response.json({
      rows,
      counts,
      pool: { total: poolTotal?.c ?? 0, claimed: poolClaimed?.c ?? 0 },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
