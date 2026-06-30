// Midtrans Iris payout client (C3 Phase C). Iris is a SEPARATE product from the
// Snap/Core charge API: its own base host + its own creator/approver API keys
// (NOT MIDTRANS_SERVER_KEY). Dual-control: the CREATOR key creates a payout
// batch, a DIFFERENT operator's APPROVER key approves it.
//
// MONEY-MOVEMENT BOUNDARY: this is admin-triggered only. Until both keys exist,
// isIrisConfigured() is false and the admin routes return IRIS_NOT_CONFIGURED
// (no live call is ever attempted). Sandbox base unless production + both keys.
import "server-only";

const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === "true";

const IRIS_BASE = IS_PRODUCTION
  ? "https://app.midtrans.com/iris/api/v1"
  : "https://app.sandbox.midtrans.com/iris/api/v1";

export class IrisNotConfiguredError extends Error {
  code = "IRIS_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "Iris payout keys not configured — set MIDTRANS_IRIS_CREATOR_KEY and MIDTRANS_IRIS_APPROVER_KEY.",
    );
  }
}

export class IrisError extends Error {
  code: string;
  data: unknown;
  constructor(message: string, code = "IRIS_ERROR", data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function creatorKey(): string {
  const k = process.env.MIDTRANS_IRIS_CREATOR_KEY;
  if (!k) throw new IrisNotConfiguredError();
  return k;
}
function approverKey(): string {
  const k = process.env.MIDTRANS_IRIS_APPROVER_KEY;
  if (!k) throw new IrisNotConfiguredError();
  return k;
}

/** True only when BOTH keys are present — routes gate on this so we never
 *  attempt a live disbursement (or pretend to) without real credentials. */
export function isIrisConfigured(): boolean {
  return Boolean(
    process.env.MIDTRANS_IRIS_CREATOR_KEY &&
      process.env.MIDTRANS_IRIS_APPROVER_KEY,
  );
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error_message: text.slice(0, 200) };
  }
}

async function irisRequest<T>(
  path: string,
  method: "GET" | "POST",
  key: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${IRIS_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await parse(res);
  if (!res.ok) {
    const msg =
      (data.error_message as string) ??
      (Array.isArray(data.errors) ? data.errors.join("; ") : null) ??
      `Iris HTTP ${res.status}`;
    throw new IrisError(msg, `IRIS_HTTP_${res.status}`, data);
  }
  return data as T;
}

export interface IrisBeneficiary {
  name: string;
  account: string;
  bank: string;
  alias_name: string;
  email?: string;
}

/** Register a payee. Returns Iris's confirmation; we store alias_name on the
 *  seller for later payouts. */
export async function irisAddBeneficiary(
  b: IrisBeneficiary,
): Promise<{ status?: string }> {
  return irisRequest("/beneficiaries", "POST", creatorKey(), {
    name: b.name,
    account: b.account,
    bank: b.bank,
    alias_name: b.alias_name,
    email: b.email,
  });
}

/** Validate a bank account before payout (D4). Iris returns the registered
 *  account holder name so the admin can confirm it matches the seller. Throws
 *  IrisNotConfiguredError when live keys aren't set (Chief: deploy-phase). */
export async function irisValidateBeneficiary(
  bank: string,
  account: string,
): Promise<{ accountName: string | null; raw: Record<string, unknown> }> {
  const data = await irisRequest<Record<string, unknown>>(
    `/account_validation?bank=${encodeURIComponent(bank)}&account=${encodeURIComponent(account)}`,
    "GET",
    creatorKey(),
  );
  const accountName =
    (data.account_name as string) ?? (data.name as string) ?? null;
  return { accountName, raw: data };
}

export interface IrisPayoutItem {
  beneficiary_name: string;
  beneficiary_account: string;
  beneficiary_bank: string;
  beneficiary_email?: string;
  amount: number;
  notes: string;
  /** Our idempotent reference (the payout_batch.id). */
  reference_no: string;
}

export interface IrisCreateResult {
  payouts: { status: string; reference_no: string }[];
}

/** CREATOR key. Creates one or more payouts (status queued until approved). */
export async function irisCreatePayout(
  items: IrisPayoutItem[],
): Promise<IrisCreateResult> {
  return irisRequest("/payouts", "POST", creatorKey(), {
    payouts: items.map((p) => ({
      beneficiary_name: p.beneficiary_name,
      beneficiary_account: p.beneficiary_account,
      beneficiary_bank: p.beneficiary_bank,
      beneficiary_email: p.beneficiary_email,
      // Iris expects the amount as a string.
      amount: String(p.amount),
      notes: p.notes,
      reference_no: p.reference_no,
    })),
  });
}

/** APPROVER key (must be a DIFFERENT operator than the creator — enforced by
 *  the route, not Iris). Approves queued payouts by reference_no. */
export async function irisApprovePayout(
  referenceNos: string[],
): Promise<Record<string, unknown>> {
  return irisRequest("/payouts/approve", "POST", approverKey(), {
    reference_nos: referenceNos,
  });
}

export interface IrisPayoutStatus {
  amount?: string;
  beneficiary_name?: string;
  status?: string; // queued | processed | completed | failed | rejected
  reference_no?: string;
}

/** Poll a payout's status for reconciliation. */
export async function irisGetPayout(
  referenceNo: string,
): Promise<IrisPayoutStatus> {
  return irisRequest(
    `/payouts/${encodeURIComponent(referenceNo)}`,
    "GET",
    creatorKey(),
  );
}
