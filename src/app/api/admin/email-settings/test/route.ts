import { getAdminMutator } from "@/lib/admin/rbac";
import { sendEmail, mailerConfigured } from "@/lib/email/mailer";
import { auditLog } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D15 — send a test email to the requesting admin's own address to verify SMTP
// config end-to-end. Admin-only, rate-limited. Never sends anywhere but the
// actor's email (no arbitrary recipient).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const rl = take(keyFromRequest("admin.email.test", req, actor.id), 5, 60_000);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  if (!actor.email) {
    return Response.json({ error: "NO_ADMIN_EMAIL" }, { status: 400 });
  }
  if (!mailerConfigured()) {
    return Response.json(
      { error: "SMTP_NOT_CONFIGURED", hint: "set SMTP_USER/SMTP_PASS env" },
      { status: 503 },
    );
  }

  const sent = await sendEmail({
    to: actor.email,
    subject: "AgentBuff — tes email admin",
    text: "Ini email tes dari panel admin AgentBuff. Kalau kamu menerimanya, konfigurasi SMTP sudah benar.",
    html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
      <p>Ini email <strong>tes</strong> dari panel admin AgentBuff.</p>
      <p>Kalau kamu menerimanya, konfigurasi SMTP (host/port/user/pass + nama pengirim + reply-to) sudah benar.</p>
    </div>`,
  });

  auditLog({
    event: "admin.settings.update",
    outcome: sent ? "ok" : "error",
    actor: actor.id,
    details: { op: "email_test", sent },
  });

  if (!sent) {
    return Response.json({ error: "SEND_FAILED" }, { status: 502 });
  }
  return Response.json({ ok: true, sentTo: actor.email });
}
