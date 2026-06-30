import { requireAdmin } from "@/lib/admin/rbac";
import { PricingEditor } from "../_components/pricing-editor";
import { CouponManager } from "../_components/coupon-manager";

export const dynamic = "force-dynamic";

export default async function AdminPricingPage() {
  await requireAdmin();
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Harga & Penawaran</h2>
        <p className="text-sm text-zinc-500">
          Atur harga plan dan status jual tanpa deploy. Nilai di sini langsung
          dipakai checkout dan semua tampilan harga (landing, item shop) — harga
          yang ditampilkan ke user selalu sama dengan yang ditagihkan.
        </p>
      </div>
      <PricingEditor />
      <CouponManager />
    </div>
  );
}
