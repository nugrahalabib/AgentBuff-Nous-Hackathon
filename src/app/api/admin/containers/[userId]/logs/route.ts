import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";
import { runDockerSilent } from "@/lib/hermes/docker";

// D5 — container log tail. GET the last N lines of `docker logs` for a user's
// container. Read-only (admin OR support). runDockerSilent so a stopped/missing
// container returns empty rather than 500.
export const dynamic = "force-dynamic";

const MAX_TAIL = 1000;
const DEFAULT_TAIL = 200;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { userId } = await params;
    if (!userId || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const url = new URL(req.url);
    const tail = Math.min(
      MAX_TAIL,
      Math.max(1, Number(url.searchParams.get("tail") ?? DEFAULT_TAIL) || DEFAULT_TAIL),
    );

    const [row] = await db
      .select({ containerName: schema.userContainers.containerName })
      .from(schema.userContainers)
      .where(eq(schema.userContainers.userId, userId))
      .limit(1);
    if (!row?.containerName) {
      return Response.json({ logs: "", note: "no container" });
    }

    // `docker logs` writes to both stdout (app stdout) and stderr (app stderr);
    // runDockerSilent captures both and never throws.
    const { stdout, stderr } = await runDockerSilent([
      "logs",
      "--tail",
      String(tail),
      "--timestamps",
      row.containerName,
    ]);
    const logs = [stdout, stderr].filter(Boolean).join("\n").slice(-200_000);
    return Response.json({ logs });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
