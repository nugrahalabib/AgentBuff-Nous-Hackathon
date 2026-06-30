/**
 * GET /api/users/me/dashboard/today-stats
 *
 * Aggregate today vs yesterday metrics untuk dashboard Ringkasan zone 2.
 *
 * Architecture:
 * - Server-side aggregation (single source of truth, cross-platform reusable).
 * - Single REST hit dari client → server panggil gateway 1x (parallel health +
 *   sessions.usage), return shape lengkap.
 * - Cache: client TanStack Query stale=60s, server Cache-Control private 30s.
 * - Failure mode: container offline → return zeros + engineLive=false (no throw).
 *
 * Why not call gateway dari client langsung:
 * - Wire layer di portal (ws-proxy.ts) untuk chat, bukan untuk batch RPC.
 *   Endpoint ini sengaja server-side supaya logic aggregate bisa shared
 *   dengan future surface (mobile app, email digest, batch report).
 * - Hide gateway internals dari client (token rotation aman, RPC method
 *   names bukan public surface yang user bisa tau).
 */

import { auth } from "@/lib/auth.config";
import { computeTodayStats } from "@/lib/dashboard/today-stats-service";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const stats = await computeTodayStats(session.user.id);

    return Response.json(
      { stats },
      {
        headers: {
          // 30s server cache. Lebih agresif dari subscription (60s) karena
          // angka task carry / energy used cenderung user pengen liat lebih
          // sering refresh saat aktif.
          "Cache-Control": "private, max-age=30, must-revalidate",
        },
      },
    );
  } catch (err) {
    console.error("[/api/users/me/dashboard/today-stats] error:", err);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
