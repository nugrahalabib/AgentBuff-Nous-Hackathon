import { auth } from "@/lib/auth.config";
import { provisionContainer } from "@/lib/hermes/docker";
import { take } from "@/lib/security/rate-limit";

// provisionContainer spawns real docker work (1GB/CPU-capped containers on a
// shared host), so a loop must not thrash it. Key off the authenticated session
// user id (spoof-proof — not IP). The normal flow fires this at most a few times
// (once on the persona step + manual retries).
const LIMIT = 6;
const WINDOW_MS = 60_000;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = take(`container-retry:${userId}`, LIMIT, WINDOW_MS);
  if (!rl.ok) {
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  // Fire-and-forget so the browser can start polling immediately.
  provisionContainer(userId).catch((err) =>
    console.error("[retry] provision failed:", err),
  );

  return Response.json({ ok: true });
}
