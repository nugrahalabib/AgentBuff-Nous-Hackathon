import { count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { hashEmail } from "@/lib/crypto";

// D3 — anti-farm trial-grant ledger browse + email lookup. The table stores only
// sha256 email hashes (no raw emails), so the actionable lookup is "does this
// email already have a consumed trial?" — hash the entered email and match.
// Read-only (admin OR support). Delete is the [hash] sub-route.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const url = new URL(req.url);
    const email = (url.searchParams.get("email") ?? "").trim().slice(0, 200);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

    // Email lookup: hash + point-check. Returns the hash so the UI can delete it.
    if (email) {
      const h = hashEmail(email);
      const [hit] = await db
        .select({
          emailHash: schema.trialGrants.emailHash,
          grantedAt: schema.trialGrants.grantedAt,
        })
        .from(schema.trialGrants)
        .where(eq(schema.trialGrants.emailHash, h))
        .limit(1);
      return Response.json({
        lookup: {
          email,
          emailHash: h,
          found: !!hit,
          grantedAt: hit?.grantedAt ?? null,
        },
      });
    }

    const offset = (page - 1) * PAGE_SIZE;
    const rows = await db
      .select({
        emailHash: schema.trialGrants.emailHash,
        grantedAt: schema.trialGrants.grantedAt,
      })
      .from(schema.trialGrants)
      .orderBy(desc(schema.trialGrants.grantedAt))
      .limit(PAGE_SIZE)
      .offset(offset);
    const [totalRow] = await db.select({ total: count() }).from(schema.trialGrants);

    return Response.json({
      rows,
      page,
      pageSize: PAGE_SIZE,
      total: totalRow?.total ?? 0,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
