import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import { auditLog } from "@/lib/security/audit-log";

const STATUSES = new Set(["active", "suspended"]);

function clampPct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Bank details used by Iris payout (Phase C). Returns a sanitized object, null
// to clear, or false on invalid input (so the caller can 400).
type PayoutInfo = {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  email?: string;
};
function parsePayoutInfo(v: unknown): PayoutInfo | null | false {
  if (v === null) return null;
  if (typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const bankCode = String(o.bankCode ?? "").trim().toLowerCase().slice(0, 24);
  const accountNumber = String(o.accountNumber ?? "").trim().slice(0, 40);
  const accountName = String(o.accountName ?? "").trim().slice(0, 120);
  if (!bankCode || !accountNumber || !accountName) return false;
  if (!/^[0-9]+$/.test(accountNumber)) return false;
  const email = typeof o.email === "string" ? o.email.trim().slice(0, 120) : undefined;
  return { bankCode, accountNumber, accountName, ...(email ? { email } : {}) };
}

// Edit a seller (Fase C / D4 C2). Mutation — admin only.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const [seller] = await db
      .select({ type: schema.sellers.type })
      .from(schema.sellers)
      .where(eq(schema.sellers.id, id))
      .limit(1);
    if (!seller) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      commissionPct?: unknown;
      displayName?: string;
      payoutInfo?: unknown;
    };
    const updates: {
      status?: string;
      commissionPct?: number | null;
      displayName?: string;
      payoutInfo?: PayoutInfo | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (body.status !== undefined) {
      if (!STATUSES.has(body.status)) {
        return Response.json({ error: "INVALID_STATUS" }, { status: 400 });
      }
      if (seller.type === "first_party" && body.status !== "active") {
        return Response.json({ error: "CANNOT_SUSPEND_HOUSE" }, { status: 400 });
      }
      updates.status = body.status;
    }
    if (body.commissionPct !== undefined) {
      updates.commissionPct = clampPct(body.commissionPct);
    }
    if (typeof body.displayName === "string") {
      const name = body.displayName.trim().slice(0, 80);
      if (name) updates.displayName = name;
    }
    if (body.payoutInfo !== undefined) {
      const pi = parsePayoutInfo(body.payoutInfo);
      if (pi === false)
        return Response.json({ error: "INVALID_PAYOUT_INFO" }, { status: 400 });
      updates.payoutInfo = pi;
    }

    await db.update(schema.sellers).set(updates).where(eq(schema.sellers.id, id));
    auditLog({
      event: "admin.seller.update",
      outcome: "ok",
      actor: actor.id,
      target: id,
      details: {
        status: updates.status,
        commissionPct: updates.commissionPct,
        // Don't log bank details — just that they changed.
        payoutInfoUpdated: updates.payoutInfo !== undefined,
      },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
