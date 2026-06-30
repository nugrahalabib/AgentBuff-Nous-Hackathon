import { getAdminActor, getAdminMutator } from "@/lib/admin/rbac";
import { listBackupsForUser, deleteBackup } from "@/lib/hermes/backup";
import { auditLog } from "@/lib/security/audit-log";

// D5 — list/delete a user's volume backups. GET is read (admin OR support);
// DELETE mutates (admin only).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { userId } = await params;
    if (!userId || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const backups = await listBackupsForUser(userId);
    return Response.json({ backups });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    const { userId } = await params;
    if (!userId || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }
    const url = new URL(req.url);
    const filename = (url.searchParams.get("filename") ?? "").trim();
    if (!filename) {
      return Response.json({ error: "MISSING_FILENAME" }, { status: 400 });
    }
    const ok = await deleteBackup(userId, filename);
    if (!ok) {
      return Response.json({ error: "DELETE_FAILED" }, { status: 400 });
    }
    auditLog({
      event: "admin.container.backup",
      outcome: "ok",
      actor: actor.id,
      target: userId,
      details: { op: "delete", filename },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
