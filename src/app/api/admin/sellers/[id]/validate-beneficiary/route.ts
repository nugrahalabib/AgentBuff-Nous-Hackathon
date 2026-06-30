import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import {
  isIrisConfigured,
  irisValidateBeneficiary,
  IrisError,
  IrisNotConfiguredError,
} from "@/lib/iris";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D4 — validate a 3rd-party seller's bank beneficiary via Iris before payout, so
// the admin confirms the account exists + the holder name matches. Admin-only.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.seller.validate", req, actor.id), 20, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  if (!isIrisConfigured()) {
    return Response.json({ error: "IRIS_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const { id } = await params;
    const [seller] = await db
      .select({ payoutInfo: schema.sellers.payoutInfo })
      .from(schema.sellers)
      .where(eq(schema.sellers.id, id))
      .limit(1);
    if (!seller) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    const p = (seller.payoutInfo ?? {}) as Record<string, unknown>;
    const bank = String(p.bankCode ?? "").trim();
    const account = String(p.accountNumber ?? "").trim();
    const expectedName = String(p.accountName ?? "").trim();
    if (!bank || !account) {
      return Response.json({ error: "NO_PAYOUT_INFO" }, { status: 400 });
    }

    try {
      const { accountName } = await irisValidateBeneficiary(bank, account);
      const matches =
        !!accountName &&
        !!expectedName &&
        accountName.trim().toLowerCase() === expectedName.toLowerCase();
      auditLog({
        event: "admin.seller.update",
        outcome: "ok",
        actor: actor.id,
        target: id,
        details: { op: "validate_beneficiary", matches },
      });
      return Response.json({ ok: true, accountName, expectedName, matches });
    } catch (e) {
      const code = e instanceof IrisNotConfiguredError ? "IRIS_NOT_CONFIGURED" : "IRIS_ERROR";
      const msg = e instanceof IrisError ? e.message : String(e);
      return Response.json(
        { error: code, message: msg.slice(0, 200) },
        { status: code === "IRIS_NOT_CONFIGURED" ? 503 : 502 },
      );
    }
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
