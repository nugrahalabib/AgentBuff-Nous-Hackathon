import { requireAdmin } from "@/lib/admin/rbac";
import { MarketplaceTabs } from "../_components/marketplace-tabs";

export const dynamic = "force-dynamic";

export default async function AdminMarketplacePage() {
  await requireAdmin();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Marketplace</h2>
        <p className="text-sm text-zinc-500">
          Katalog item (skill / MCP-app / bundle), moderasi listing, 3rd-party
          seller, komisi, dan payout (Iris). Install ke container otomatis saat
          dibeli.
        </p>
      </div>
      <MarketplaceTabs />
    </div>
  );
}
