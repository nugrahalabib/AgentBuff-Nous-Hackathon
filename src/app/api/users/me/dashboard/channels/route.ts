/**
 * GET /api/users/me/dashboard/channels
 *
 * Aggregate channels state (status + today usage) untuk dashboard tab Saluran.
 *
 * Architecture mirror tab Ringkasan:
 * - Server-side aggregation (single source of truth, cross-platform reusable)
 * - Single REST hit dari client → server panggil gateway 1x parallel
 * - Cache: client TanStack Query stale=30s, server Cache-Control private 30s
 * - Failure mode: container offline → return shape lengkap + engineLive=false
 *
 * Why not direct `channels.status` RPC dari client:
 * - Server-side combine dengan sessions.usage aggregates.byChannel untuk
 *   per-channel message count (real-time data) tanpa double round-trip
 * - Future surface (mobile, email digest) reusable
 */
import { auth } from "@/lib/auth.config";
import { computeChannelsDashboard } from "@/lib/dashboard/channels-service";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const payload = await computeChannelsDashboard(session.user.id);

    return Response.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=30, must-revalidate",
      },
    });
  } catch (err) {
    console.error("[/api/users/me/dashboard/channels] error:", err);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
