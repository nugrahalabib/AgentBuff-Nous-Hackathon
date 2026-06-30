// Structured, PII-safe audit logger for security-relevant events.
//
// Writes to stdout as single-line JSON — easy to grep, trivially ingestable
// by any log pipeline (Loki, Datadog, Papertrail, etc.) once we wire one up.
//
// Rules:
// 1. No email, full userId, full IP, full order_id, full token — ever.
// 2. All identifiers get passed through `redact()` which short-hashes them.
// 3. Callers supply `event` (enum of known events) + `outcome` + optional
//    `details` object. Extra keys are kept as-is but callers must not put
//    raw PII in them.
//
// For now we also mirror to console.* so existing log streams see it.

import crypto from "node:crypto";
import { db } from "@/lib/db";
import { auditLogs as auditLogTable } from "@/lib/db/schema";

export type AuditOutcome = "ok" | "reject" | "error";

export type AuditEvent =
  | "auth.register"
  | "auth.register.blocked"
  | "auth.login"
  | "auth.logout"
  | "billing.charge.create"
  | "billing.webhook.received"
  | "billing.webhook.rejected"
  | "billing.webhook.signature_mismatch"
  | "billing.webhook.fraud_deny"
  | "billing.webhook.fraud_challenge"
  | "billing.settlement.applied"
  | "billing.settlement.replay_ignored"
  | "billing.settlement.order_not_found"
  | "billing.settlement.amount_mismatch"
  | "billing.settlement.tier_downgrade_blocked"
  | "billing.receipt.sent"
  | "billing.receipt.failed"
  | "billing.webhook.refund"
  | "billing.reconcile.settled"
  | "billing.reconcile.abandoned"
  | "billing.reconcile.fraud_challenge"
  | "billing.skill.install_started"
  | "billing.skill.install_completed"
  | "billing.skill.install_failed"
  | "billing.throttle.applied"
  | "billing.throttle.cleared"
  | "early_access.lead"
  | "onboarding.key_staged"
  | "onboarding.restart"
  | "onboarding.completed"
  | "rate_limit.exceeded"
  | "admin.access.denied"
  | "admin.container.action"
  | "admin.settings.update"
  | "admin.pricing.update"
  | "admin.cms.update"
  | "admin.flag.update"
  | "admin.coupon.create"
  | "admin.coupon.update"
  | "admin.catalog.create"
  | "admin.catalog.update"
  | "admin.capability.update"
  | "billing.payout.create"
  | "billing.payout.approve"
  | "billing.payout.sync"
  | "admin.rpc.test"
  | "admin.lead.update"
  | "admin.listing.create"
  | "admin.listing.update"
  | "admin.user.action"
  | "admin.announcement.send"
  | "admin.seller.create"
  | "admin.seller.update"
  | "admin.commission.update"
  | "admin.transaction.refund"
  | "admin.transaction.reconcile"
  | "admin.support.reply"
  | "admin.skill.force_uninstall"
  | "admin.impersonate.start"
  | "admin.impersonate.stop"
  | "admin.container.backup"
  | "admin.container.restore";

export type AuditRecord = {
  ts: string;
  event: AuditEvent;
  outcome: AuditOutcome;
  actorHash: string | null;
  targetHash: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
};

// Non-reversible short fingerprint. 10 hex chars of sha256 — collision rate
// is negligible for audit correlation, and it's not reversible back to the
// original id/email/ip without the full hash space.
export function redact(value: string | null | undefined): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}

// Stable short prefix of a userId — matches shortUid() in usage-poller so
// logs from different subsystems correlate visually without giving up PII.
export function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

// Pull the client IP from `x-real-ip`, which server.ts stamps from the real
// TCP socket (not client-spoofable). We deliberately ignore the
// client-controlled x-forwarded-for so a forged header can't poison the audit
// trail. We redact the value before it leaves this module.
export function clientIpFromRequest(req: Request): string | null {
  return req.headers.get("x-real-ip")?.trim() || null;
}

// F3 — dual-write the audit record to the audit_log table so the admin audit
// viewer can query/filter (the stdout line stays the durable fallback).
// Fire-and-forget + fail-safe: audit persistence must never break the request.
function persistAudit(record: AuditRecord): void {
  void db
    .insert(auditLogTable)
    .values({
      ts: new Date(record.ts),
      event: record.event,
      outcome: record.outcome,
      actorHash: record.actorHash,
      targetHash: record.targetHash,
      ip: record.ip,
      details: record.details ?? undefined,
    })
    .catch(() => {
      /* best-effort — stdout line above is the durable fallback */
    });
}

export function auditLog(input: {
  event: AuditEvent;
  outcome: AuditOutcome;
  actor?: string | null;
  target?: string | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}): void {
  const record: AuditRecord = {
    ts: new Date().toISOString(),
    event: input.event,
    outcome: input.outcome,
    actorHash: redact(input.actor ?? null),
    targetHash: redact(input.target ?? null),
    ip: redact(input.ip ?? null),
    details: input.details ?? null,
  };
  // Single-line JSON so downstream parsers don't choke.
  try {
    process.stdout.write(`audit ${JSON.stringify(record)}\n`);
  } catch {
    console.log("audit", record);
  }
  persistAudit(record);
}
