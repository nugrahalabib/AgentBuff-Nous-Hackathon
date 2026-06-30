import { TransactionsBrowser } from "../_components/transactions-browser";
import { ExpiryPanel } from "../_components/expiry-panel";
import { CohortPanel } from "../_components/cohort-panel";
import { requireAdminPage } from "@/lib/admin/rbac";

export const dynamic = "force-dynamic";

export default async function AdminTransactionsPage() {
  const actor = await requireAdminPage();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Transaksi & Revenue</h2>
        <p className="text-sm text-zinc-500">
          Ledger pembayaran + ringkasan pendapatan. Filter per tipe / status.
        </p>
      </div>
      <TransactionsBrowser role={actor.role} />
      <ExpiryPanel />
      <CohortPanel />
    </div>
  );
}
