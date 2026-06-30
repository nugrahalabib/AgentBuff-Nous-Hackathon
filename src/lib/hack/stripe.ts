// HACKATHON-only Stripe test-charge helper (single source of truth for both the
// agent buy endpoint and the earn seed script).
//
// CURRENCY: charges are in IDR so the Stripe dashboard reads the SAME number the
// app shows (e.g. "Rp 99.000"). Stripe treats IDR as a TWO-DECIMAL currency for
// this account — it interprets the raw `amount` as 1/100 rupiah — so a Rupiah
// price MUST be multiplied by 100:
//   amountRp = 99_000 (Rp 99.000)  ->  Stripe amount = 9_900_000  ->  "Rp 99.000".
// (Verified live: amount=99000 idr => "Rp 990,00 ~= $0.06" rejected under the $0.50
//  minimum; amount=9_900_000 idr => succeeded, dashboard "Rp 99.000".)
//
// CUSTOMER: when a customer descriptor is passed, the charge is attached to a real
// Stripe Customer (resolve-or-create by email, idempotent) so the dashboard
// "Pelanggan" column is populated instead of "—".
//
// INTEGRITY: returns ok=false when no real PaymentIntent was created, so callers
// can refuse to show a "purchased" state without a real charge behind it.
//
// NOTE: the displayed timestamp is Stripe's UTC `created` epoch rendered in the
// viewer's dashboard timezone — set the dashboard time zone to Asia/Jakarta to see
// WIB. The data is correct regardless; only the display offset is a viewer setting.

const IDR_MINOR_UNIT = 100;
const STRIPE_BASE = "https://api.stripe.com/v1";

export interface IdrChargeResult {
  /** Stripe PaymentIntent id (pi_...) when a real charge succeeded, else null. */
  id: string | null;
  /** True only when a real PaymentIntent was created. */
  ok: boolean;
  /** Human-readable failure reason when ok is false. */
  error?: string;
}

/** Stripe-hosted receipt URL for a PaymentIntent's latest charge (real proof of payment). */
export async function getStripeReceiptUrl(paymentIntentId: string): Promise<string | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !paymentIntentId) return null;
  try {
    const res = await fetch(
      `${STRIPE_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const j = (await res.json()) as { latest_charge?: { receipt_url?: string } };
    return j.latest_charge?.receipt_url ?? null;
  } catch {
    return null;
  }
}

function postHeaders(key: string): HeadersInit {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

// Resolve a Stripe Customer by email (idempotent), creating it once if absent, so
// repeated charges for the same buyer reuse one customer record.
async function ensureCustomer(key: string, name: string, email: string): Promise<string | null> {
  try {
    const found = await fetch(
      `${STRIPE_BASE}/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const fj = (await found.json()) as { data?: Array<{ id: string; name?: string | null }> };
    if (fj.data && fj.data.length > 0) {
      const existing = fj.data[0];
      // Keep the name in sync — an earlier charge may have created the customer
      // with a placeholder, or the user may have since changed their name.
      if ((existing.name ?? "") !== name) {
        await fetch(`${STRIPE_BASE}/customers/${existing.id}`, {
          method: "POST",
          headers: postHeaders(key),
          body: new URLSearchParams({ name }),
        }).catch(() => {});
      }
      return existing.id;
    }

    const created = await fetch(`${STRIPE_BASE}/customers`, {
      method: "POST",
      headers: postHeaders(key),
      body: new URLSearchParams({ name, email }),
    });
    const cj = (await created.json()) as { id?: string };
    return cj.id ?? null;
  } catch {
    return null;
  }
}

export async function stripeChargeIdr(params: {
  amountRp: number;
  description: string;
  metadata?: Record<string, string>;
  customer?: { name: string; email: string };
}): Promise<IdrChargeResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { id: null, ok: false, error: "STRIPE_SECRET_KEY tidak diset" };

  // Attach a real customer when asked (non-fatal if it can't be resolved).
  let customerId: string | null = null;
  if (params.customer?.email) {
    customerId = await ensureCustomer(key, params.customer.name, params.customer.email);
  }

  const body = new URLSearchParams({
    amount: String(Math.round(params.amountRp * IDR_MINOR_UNIT)),
    currency: "idr",
    "payment_method_types[]": "card",
    payment_method: "pm_card_visa",
    confirm: "true",
    description: params.description,
  });
  if (customerId) body.set("customer", customerId);
  for (const [k, v] of Object.entries(params.metadata ?? {})) {
    body.set(`metadata[${k}]`, v);
  }

  // One retry so a transient blip doesn't fake-fail a real demo purchase.
  let lastError = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${STRIPE_BASE}/payment_intents`, {
        method: "POST",
        headers: postHeaders(key),
        body,
      });
      const j = (await res.json()) as {
        id?: string;
        status?: string;
        error?: { message?: string };
      };
      if (j.error) {
        lastError = j.error.message ?? "Stripe error";
        continue;
      }
      if (j.id) return { id: j.id, ok: true };
      lastError = "Stripe tidak mengembalikan PaymentIntent id";
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { id: null, ok: false, error: lastError };
}
