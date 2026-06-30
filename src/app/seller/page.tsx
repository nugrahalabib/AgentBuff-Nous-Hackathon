import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { SellerDashboard } from "./seller-dashboard";

// D4 — seller self-service portal. Auth-gated; the dashboard itself handles the
// not-yet-a-seller (apply) / pending / active states via /api/seller/me.
export const dynamic = "force-dynamic";

export default async function SellerPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?next=/seller");
  }
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 text-zinc-100">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">Portal Penjual</h1>
        <p className="text-sm text-zinc-500">
          Kelola listing kamu, lihat penjualan, dan atur rekening payout.
        </p>
      </div>
      <SellerDashboard />
    </main>
  );
}
