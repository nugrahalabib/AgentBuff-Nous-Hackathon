import { requireAdminPage } from "@/lib/admin/rbac";
import { SupportBrowser } from "../_components/support-browser";

export const dynamic = "force-dynamic";

export default async function AdminSupportPage() {
  const actor = await requireAdminPage();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Dukungan</h2>
        <p className="text-sm text-zinc-500">
          Tiket keluhan / pengembangan / pertanyaan dari user. Balas untuk
          memberi tahu user (otomatis kirim notifikasi).
        </p>
      </div>
      <SupportBrowser role={actor.role} />
    </div>
  );
}
