import { requireAdmin } from "@/lib/admin/rbac";
import { ContainersBrowser } from "../_components/containers-browser";

export const dynamic = "force-dynamic";

export default async function AdminContainersPage() {
  await requireAdmin();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Kontainer</h2>
        <p className="text-sm text-zinc-500">
          Monitor armada engine (live) + aksi stop / start / reprovision / destroy.
        </p>
      </div>
      <ContainersBrowser />
    </div>
  );
}
