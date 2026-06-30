import { requireAdminPage } from "@/lib/admin/rbac";
import { LeadsBrowser } from "../_components/leads-browser";
import { AnalyticsBrowser } from "../_components/analytics-browser";

export const dynamic = "force-dynamic";

export default async function AdminMarketingPage() {
  const actor = await requireAdminPage();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">
          Marketing — Early Access Leads
        </h2>
        <p className="text-sm text-zinc-500">
          Daftar minat untuk tier yang belum dijual (Full Managed dll). Kelola
          status follow-up.
        </p>
      </div>
      <LeadsBrowser role={actor.role} />
      <div>
        <h3 className="mb-2 text-sm font-medium text-zinc-300">
          Funnel konversi
        </h3>
        <AnalyticsBrowser />
      </div>
    </div>
  );
}
