import { SubscriptionsBrowser } from "../_components/subscriptions-browser";

export const dynamic = "force-dynamic";

export default function AdminSubscriptionsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Langganan & Trial</h2>
        <p className="text-sm text-zinc-500">
          Status langganan per tier + lifecycle trial (aktif / konversi / expired)
          dan ledger anti-farming.
        </p>
      </div>
      <SubscriptionsBrowser />
    </div>
  );
}
