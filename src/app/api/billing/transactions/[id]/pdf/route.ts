import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { generateReceiptPdf, receiptNumber } from "@/lib/billing/receipt-pdf";

// Official receipt = proof that MONEY WAS RECEIVED. "install_failed" is included
// because the payment settled (only the post-payment skill install failed) — the
// user paid, so they're entitled to a struk for verification.
const PAID = new Set(["completed", "installed", "install_failed"]);

// Stream the official receipt PDF for ONE transaction the caller owns. The
// (id + userId) match is the access gate — a user can only download their own
// receipt (no IDOR). The receipt number is derived from the tx id so it is
// stable + unique per payment.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    const { id } = await params;

    const [row] = await db
      .select({
        tx: schema.transactions,
        email: schema.users.email,
        name: schema.users.name,
        locale: schema.userProfiles.locale,
      })
      .from(schema.transactions)
      .leftJoin(schema.users, eq(schema.users.id, schema.transactions.userId))
      .leftJoin(
        schema.userProfiles,
        eq(schema.userProfiles.userId, schema.transactions.userId),
      )
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.userId, userId),
        ),
      )
      .limit(1);

    if (!row?.tx) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    const tx = row.tx;
    if (!PAID.has(tx.status))
      return Response.json({ error: "NOT_PAID" }, { status: 400 });

    const locale = row.locale === "en" ? "en" : "id";
    // Number from the IMMUTABLE createdAt (identical everywhere); displayed date
    // is the PAID date so the struk matches the emailed one exactly.
    const receiptNo = receiptNumber(tx.id, tx.createdAt);
    // paidAt = authoritative payment moment. For rows predating that column,
    // fall back to the IMMUTABLE createdAt — NOT updatedAt, which a skill-install
    // retry can bump hours/days after payment (wrong "paid" date on the struk).
    const paidDate = tx.paidAt ?? tx.createdAt;
    const pdf = await generateReceiptPdf({
      receiptNo,
      dateIso: paidDate.toISOString(),
      description: tx.description,
      amountRp: tx.amountRp,
      paymentRef: tx.paymentRef,
      paymentMethod: tx.paymentMethod,
      orderId: tx.midtransOrderId,
      billedToEmail: row.email ?? session.user.email ?? "",
      billedToName: row.name ?? null,
      locale,
    });

    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Struk-${receiptNo}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
