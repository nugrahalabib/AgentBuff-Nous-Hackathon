import { createHash, timingSafeEqual } from "node:crypto";

const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === "true";

const BASE_URL = IS_PRODUCTION
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

// Snap lives on the app.* host (not api.*). One Snap token = a checkout that
// accepts EVERY payment method enabled in the Midtrans dashboard.
const SNAP_BASE_URL = IS_PRODUCTION
  ? "https://app.midtrans.com"
  : "https://app.sandbox.midtrans.com";

// Read the server key at the point of USE (not module load) so a missing key
// fails the payment path with a CLEAR error instead of silently sending
// "undefined:" as Basic-auth (the old `!` non-null assertion did exactly that).
// This never crashes the whole app at boot — only payment calls require it.
function serverKey(): string {
  const k = process.env.MIDTRANS_SERVER_KEY;
  if (!k) {
    throw new Error(
      "MIDTRANS_SERVER_KEY not configured — set it in the environment before charging or verifying payments.",
    );
  }
  return k;
}

const authHeader = (): string =>
  `Basic ${Buffer.from(serverKey() + ":").toString("base64")}`;

/**
 * Guard amounts before charging. Midtrans QRIS / e-wallet require gross_amount
 * to be a POSITIVE INTEGER in IDR (no decimals). A non-integer or non-positive
 * amount (e.g. a DB-driven bundle price gone wrong) would be silently rounded
 * or rejected by Midtrans — fail loudly here instead.
 */
export function assertPositiveIntegerIdr(amount: number, label = "amount"): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Invalid IDR ${label}: ${amount} (must be a positive integer)`);
  }
}

/**
 * Midtrans rejects a charge whose item_details sum doesn't equal gross_amount.
 * Assert it at the lib boundary so a future multi-line caller fails loudly here
 * instead of with an opaque gateway 400.
 */
function assertItemTotal(
  grossAmount: number,
  items?: { price: number; quantity: number }[],
): void {
  if (!items || items.length === 0) return;
  const sum = items.reduce((acc, it) => acc + it.price * it.quantity, 0);
  if (sum !== grossAmount) {
    throw new Error(
      `item_details total (${sum}) != gross_amount (${grossAmount})`,
    );
  }
}

/**
 * Read a Midtrans response body tolerantly. A 5xx / proxy error can return HTML
 * or an empty body; calling res.json() directly throws a SyntaxError that masks
 * the real status. Fall back to the raw text as status_message.
 */
async function parseMidtransResponse(
  res: Response,
): Promise<{ status_message?: string } & Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as { status_message?: string } & Record<
      string,
      unknown
    >;
  } catch {
    return { status_message: text.slice(0, 200) };
  }
}

async function midtransRequest<T>(
  path: string,
  method: "GET" | "POST" = "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await parseMidtransResponse(res);
  if (!res.ok) {
    throw Object.assign(new Error(data.status_message ?? `Midtrans HTTP ${res.status}`), { data });
  }
  return data as T;
}

// ── Charge (Core API) ────────────────────────

interface ChargeParams {
  orderId: string;
  grossAmount: number;
  paymentType: string;
  customerEmail?: string;
  customerName?: string;
  itemDetails?: { id: string; price: number; quantity: number; name: string }[];
}

export async function createCharge(params: ChargeParams) {
  assertPositiveIntegerIdr(params.grossAmount, "gross_amount");
  assertItemTotal(params.grossAmount, params.itemDetails);
  const payload: Record<string, unknown> = {
    payment_type: params.paymentType,
    transaction_details: {
      order_id: params.orderId,
      gross_amount: params.grossAmount,
    },
  };

  if (params.customerEmail || params.customerName) {
    payload.customer_details = {
      email: params.customerEmail,
      first_name: params.customerName,
    };
  }

  if (params.itemDetails) {
    payload.item_details = params.itemDetails;
  }

  // Payment-type-specific params
  if (params.paymentType === "qris") {
    payload.qris = { acquirer: "gopay" };
  } else if (params.paymentType === "gopay") {
    payload.gopay = { enable_callback: true };
  } else if (params.paymentType === "bank_transfer") {
    payload.bank_transfer = { bank: "bca" };
  }

  return midtransRequest<MidtransChargeResponse>("/charge", "POST", payload);
}

// ── Snap (one token = ALL payment methods) ───

interface SnapParams {
  orderId: string;
  grossAmount: number;
  customerEmail?: string;
  customerName?: string;
  itemDetails?: { id: string; price: number; quantity: number; name: string }[];
  enabledPayments?: string[];
}

export interface SnapTransaction {
  token: string;
  redirect_url: string;
}

/**
 * Create a Snap transaction token. The token drives snap.embed/snap.pay on the
 * client and lets the user pay with ANY method enabled in the Midtrans
 * dashboard (cards, every VA bank, GoPay/OVO/DANA/ShopeePay/LinkAja, QRIS,
 * PayLater, convenience store, ...). Settlement still arrives via the SAME
 * /api/billing/webhook (identical notification format + SHA512 signature) — only
 * charge creation differs from the Core API path.
 */
export async function createSnapTransaction(
  params: SnapParams,
): Promise<SnapTransaction> {
  assertPositiveIntegerIdr(params.grossAmount, "gross_amount");
  assertItemTotal(params.grossAmount, params.itemDetails);
  const payload: Record<string, unknown> = {
    transaction_details: {
      order_id: params.orderId,
      gross_amount: params.grossAmount,
    },
    credit_card: { secure: true },
  };
  if (params.customerEmail || params.customerName) {
    payload.customer_details = {
      email: params.customerEmail,
      first_name: params.customerName,
    };
  }
  if (params.itemDetails) payload.item_details = params.itemDetails;
  if (params.enabledPayments) payload.enabled_payments = params.enabledPayments;

  const res = await fetch(`${SNAP_BASE_URL}/snap/v1/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify(payload),
  });
  const data = await parseMidtransResponse(res);
  if (!res.ok) {
    throw Object.assign(
      new Error(data.status_message ?? `Midtrans Snap HTTP ${res.status}`),
      { data },
    );
  }
  return data as unknown as SnapTransaction;
}

// ── Status ───────────────────────────────────

export async function getTransactionStatus(orderId: string) {
  return midtransRequest<MidtransStatusResponse>(`/${orderId}/status`, "GET");
}

// ── Cancel ───────────────────────────────────

export async function cancelTransaction(orderId: string) {
  return midtransRequest(`/${orderId}/cancel`, "POST");
}

// ── Webhook Signature Verification ───────────

export function verifySignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  signatureKey: string | null | undefined,
): boolean {
  // A missing/empty signature can never be valid — and reading .length off an
  // undefined value (e.g. a Get-Status 404 response with no signature_key) used
  // to throw and abort the whole reconcile sweep. Treat absent as invalid.
  if (!signatureKey) return false;
  const input = orderId + statusCode + grossAmount + serverKey();
  const hash = createHash("sha512").update(input).digest("hex");
  // Constant-time compare. Length-guard first — timingSafeEqual throws on a
  // length mismatch, and an attacker controls signatureKey's length.
  if (hash.length !== signatureKey.length) return false;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(signatureKey));
}

// ── Types ────────────────────────────────────

export interface MidtransChargeResponse {
  status_code: string;
  status_message: string;
  transaction_id: string;
  order_id: string;
  gross_amount: string;
  payment_type: string;
  transaction_status: string;
  transaction_time: string;
  // QRIS specific
  actions?: { name: string; method: string; url: string }[];
  qr_string?: string;
  // GoPay specific
  // Bank transfer specific
  va_numbers?: { bank: string; va_number: string }[];
  // General
  fraud_status?: string;
}

export interface MidtransStatusResponse {
  status_code: string;
  transaction_status: string;
  order_id: string;
  gross_amount: string;
  payment_type: string;
  transaction_time: string;
  signature_key: string;
  // Returned by the Get-Status API on the wire — used by the reconcile worker
  // so a reconcile-settled payment keeps the authoritative gateway reference.
  transaction_id?: string;
  fraud_status?: string;
  // Bank for a VA payment — captured so the receipt can name the bank.
  va_numbers?: { bank?: string }[];
}

export type MidtransTransactionStatus =
  | "capture"
  | "settlement"
  | "pending"
  | "deny"
  | "cancel"
  | "expire"
  | "refund";
