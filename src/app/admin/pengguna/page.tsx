import { requireAdminPage } from "@/lib/admin/rbac";
import { UsersBrowser } from "../_components/users-browser";
import { TrialGrantsPanel } from "../_components/trial-grants-panel";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const actor = await requireAdminPage();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Pengguna</h2>
        <p className="text-sm text-zinc-500">
          Cari akun, lihat detail: status onboarding, trial, langganan, kontainer.
        </p>
      </div>
      <UsersBrowser role={actor.role} />
      <TrialGrantsPanel />
    </div>
  );
}
