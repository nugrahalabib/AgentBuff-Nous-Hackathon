/**
 * GET /api/users/me/dashboard/attention
 *
 * Aggregate attention items (alert yang butuh user action). Server-side
 * single source of truth. Aman untuk dipanggil dari client untuk render
 * "Perlu Perhatian" section di dashboard Ringkasan.
 *
 * Returns items terurut by severity (critical → warning → info). Empty
 * array kalau gak ada masalah. Client TIDAK render section kalau items.length === 0.
 */
import { auth } from "@/lib/auth.config";
import { aggregateAttention } from "@/lib/dashboard/attention-aggregator";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const payload = await aggregateAttention(session.user.id);

    return Response.json(payload, {
      headers: {
        // 30s cache — alert state cepat berubah (energy debit, container
        // status). Lebih agresif dari subscription endpoint.
        "Cache-Control": "private, max-age=30, must-revalidate",
      },
    });
  } catch (err) {
    console.error("[/api/users/me/dashboard/attention] error:", err);
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
