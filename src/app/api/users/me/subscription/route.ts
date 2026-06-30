/**
 * GET /api/users/me/subscription
 *
 * Return tier efektif + renewal info user yang sedang login. Surface untuk
 * dashboard, billing, dan gating middleware.
 *
 * Dipakai oleh:
 * - Tab Ringkasan (Greeting bar — tier badge + renewal date)
 * - Billing page (subscription history view)
 * - Future: tier-gated feature middleware
 *
 * Cache: client-side via TanStack Query stale=60s. Subscription state jarang
 * berubah — perubahan tier hanya dari Midtrans webhook flow, di mana client
 * akan invalidate cache lewat `billing-complete` postMessage.
 */
import { auth } from "@/lib/auth.config";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const subscription = await resolveSubscription(session.user.id);

    return Response.json(
      { subscription },
      {
        headers: {
          // 60s server cache — tier state changes infrequent; dashboard
          // reload lebih sering daripada billing event.
          "Cache-Control": "private, max-age=60, must-revalidate",
        },
      },
    );
  } catch (err) {
    console.error("[/api/users/me/subscription] error:", err);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
