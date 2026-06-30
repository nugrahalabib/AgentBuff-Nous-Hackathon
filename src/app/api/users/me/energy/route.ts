import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";

// Resolve userId by either NextAuth session (portal cookie) or by
// Authorization: Bearer <gatewayToken> (rebranded Control UI inside the
// container, which lives on a different origin and can't share cookies).
async function resolveUserId(req: Request): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;

  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+([a-f0-9]{32,256})$/i);
  if (!match) return null;
  const token = match[1];

  const [row] = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.gatewayToken, token))
    .limit(1);
  return row?.userId ?? null;
}

function corsHeaders(origin: string | null): HeadersInit {
  // Only reflect origins that match the loopback-port publish pattern our
  // containers use (or the configured public host). Anything else stays
  // off-allowlist — prevents random origins scraping balance via CORS.
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
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin")),
  });
}

export async function GET(req: Request) {
  const headers = corsHeaders(req.headers.get("origin"));
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
    }

    const [row] = await db
      .select()
      .from(schema.userEnergy)
      .where(eq(schema.userEnergy.userId, userId))
      .limit(1);

    if (!row) {
      return Response.json(
        { balance: 0, maxBalance: 0, lastTopupAt: null },
        { headers },
      );
    }

    return Response.json(
      {
        balance: row.balance,
        maxBalance: row.maxBalance,
        lastTopupAt: row.lastTopupAt,
      },
      { headers },
    );
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500, headers });
  }
}
