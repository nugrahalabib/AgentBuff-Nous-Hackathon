import { auth } from "@/lib/auth.config";
import { getContainerStatus, destroyContainer } from "@/lib/hermes/docker";
import { take } from "@/lib/security/rate-limit";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const row = await getContainerStatus(session.user.id);
  if (!row) return Response.json({ status: "none" });
  return Response.json({
    status: row.status,
    port: row.port,
    containerName: row.containerName,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    lastHealthAt: row.lastHealthAt,
  });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;
  // Per-user rate limit (session-keyed) — destroy is expensive + pairs with the
  // retry route to prevent destroy↔re-provision thrash on the shared host.
  const rl = take(`container-delete:${userId}`, 4, 60_000);
  if (!rl.ok) {
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  await destroyContainer(userId);
  return Response.json({ ok: true });
}
