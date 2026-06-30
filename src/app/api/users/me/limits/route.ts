import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { resolveUserLimits } from "@/lib/admin/limits";

// D7 — per-tier limits for the caller. Served to BOTH the /app client (UX caps)
// and the bridge TierLimitGate (real enforcement). Auth mirrors /api/users/me/
// energy: NextAuth session cookie OR Authorization: Bearer <gatewayToken> (the
// bridge, which lives on a loopback origin and can't share cookies). CORS limited
// to loopback / configured public host.
export const dynamic = "force-dynamic";

async function resolveUserId(req: Request): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;

  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+([a-f0-9]{32,256})$/i);
  if (!match) return null;
  const [row] = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.gatewayToken, match[1]))
    .limit(1);
  return row?.userId ?? null;
}

function corsHeaders(origin: string | null): HeadersInit {
  const host = hermesConfig.publicHost;
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
  const publicHostRe = new RegExp(`^https?://${host.replace(/\./g, "\\.")}(:\\d+)?$`);
  const allowed = origin && (loopback.test(origin) || publicHostRe.test(origin));
  return allowed
    ? {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        Vary: "Origin",
      }
    : {};
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function GET(req: Request) {
  const headers = corsHeaders(req.headers.get("origin"));
  try {
    const userId = await resolveUserId(req);
    if (!userId) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
    const limits = await resolveUserLimits(userId);
    return Response.json(limits, { headers });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500, headers });
  }
}
