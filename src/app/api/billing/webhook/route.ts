import { z } from "zod/v4";
import { verifySignature } from "@/lib/midtrans";
import { applySettlement, markTransactionFailed } from "@/lib/billing/settle";
import { midtransMethodString } from "@/lib/billing/payment-method";
import { auditLog, clientIpFromRequest, shortId } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// Midtrans webhook payload (only the fields we rely on). We accept the full
// payload but ignore extras; zod strips unknown keys by default.
const midtransPayloadSchema = z.object({
  order_id: z.string().min(1).max(200),
  status_code: z.string().min(1).max(10),
  gross_amount: z.string().min(1).max(30),
  signature_key: z.string().min(1).max(256),
  transaction_status: z.string().min(1).max(30),
  transaction_id: z.string().min(1).max(120).optional(),
  fraud_status: z.string().optional(),
  // Payment provenance — captured for the receipt + history so every payment is
  // verifiable ("paid via what / from which bank").
  payment_type: z.string().max(40).optional(),
  va_numbers: z
    .array(z.object({ bank: z.string().max(20).nullable().optional() }))
    .optional(),
});

// Official Midtrans transaction_status values (docs.midtrans.com):
//   capture · settlement · pending · deny · cancel · expire · failure
//   · refund · partial_refund · authorize.
// SETTLED = money in (run effects). CANCELED/failure = terminal-fail (mark
// failed). REFUNDED = log only (Chief policy 2026-06-16: no auto-cancel, no
// refund UI yet). pending/authorize = interim no-op; Midtrans retries. The
// reconcile-worker (Get-Status poll) is the safety net for lost webhooks.
const SETTLED = new Set(["settlement", "capture"]);
const CANCELED = new Set(["deny", "cancel", "expire", "failure"]);
const REFUNDED = new Set(["refund", "partial_refund"]);

// Always return 200 so Midtrans doesn't hammer us with retries after a
// transient internal error. We log loudly on our side and the reconcile
// worker catches anything that slipped through.
const OK = () => Response.json({ status: "ok" });

// Rate-limit webhook at 120 hits per source IP per minute. Legitimate Midtrans
// traffic is well under this; signature verification is the real security gate.
const WEBHOOK_LIMIT = 120;
const WEBHOOK_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  const ip = clientIpFromRequest(req);
  const rl = take(keyFromRequest("webhook", req), WEBHOOK_LIMIT, WEBHOOK_WINDOW_MS);
  if (!rl.ok) {
    auditLog({
      event: "rate_limit.exceeded",
      outcome: "reject",
      ip,
      details: { ns: "webhook" },
    });
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = midtransPayloadSchema.safeParse(body);
  if (!parsed.success) {
    auditLog({
      event: "billing.webhook.rejected",
      outcome: "reject",
      ip,
      details: { reason: "schema" },
    });
    return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  }
  const {
    order_id: orderId,
    status_code: statusCode,
    gross_amount: grossAmount,
    signature_key: signatureKey,
    transaction_status: txStatus,
    transaction_id: paymentRef,
    fraud_status: fraudStatus,
    payment_type: paymentType,
    va_numbers: vaNumbers,
  } = parsed.data;

  // THE security gate. signature_key = SHA512(order_id + status_code +
  // gross_amount + ServerKey). gross_amount is the RAW string from the payload.
  if (!verifySignature(orderId, statusCode, grossAmount, signatureKey)) {
    auditLog({
      event: "billing.webhook.signature_mismatch",
      outcome: "reject",
      target: orderId,
      ip,
    });
    return Response.json({ error: "INVALID_SIGNATURE" }, { status: 403 });
  }

  auditLog({
    event: "billing.webhook.received",
    outcome: "ok",
    target: orderId,
    ip,
    details: { txStatus, fraudStatus: fraudStatus ?? null, orderPrefix: orderId.slice(0, 8) },
  });

  // Midtrans fraud_status=challenge → do NOT credit yet. Treat as pending.
  if (fraudStatus === "challenge") {
    auditLog({ event: "billing.webhook.fraud_challenge", outcome: "ok", target: orderId, ip });
    return OK();
  }
  if (fraudStatus === "deny") {
    await markTransactionFailed(orderId);
    auditLog({ event: "billing.webhook.fraud_deny", outcome: "ok", target: orderId, ip });
    return OK();
  }

  try {
    if (SETTLED.has(txStatus)) {
      // Shared idempotent + amount-checked settlement (same path the
      // reconcile-worker uses). gross_amount passed for the cross-check;
      // payment method captured for the receipt/history provenance.
      await applySettlement(
        orderId,
        grossAmount,
        paymentRef ?? null,
        ip,
        midtransMethodString(paymentType, vaNumbers),
      );
    } else if (CANCELED.has(txStatus)) {
      await markTransactionFailed(orderId);
    } else if (REFUNDED.has(txStatus)) {
      // Chief policy (2026-06-16): log + audit only, no auto-cancel (no refund
      // UI yet — handle manually). Revisit when a refund flow exists.
      auditLog({
        event: "billing.webhook.refund",
        outcome: "ok",
        target: orderId,
        ip,
        details: { txStatus },
      });
    }
    // "pending"/"authorize"/other interim — no-op; Midtrans will call again.
  } catch (e) {
    console.error("[webhook] handler failed for order", shortId(orderId), e);
  }
  return OK();
}
