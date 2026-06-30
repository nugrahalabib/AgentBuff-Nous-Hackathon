import { requireAdmin } from "@/lib/admin/rbac";
import { TabIntro } from "../_components/ui";
import { RpcConsole } from "../_components/rpc-console";
import { CapabilityPolicyForm } from "../_components/capability-policy-form";

export const dynamic = "force-dynamic";

// D13 — developer / product-dev tools: RPC console + capability policy editor.
// (Skill-catalog editor lives on the Marketplace page's "Katalog 1P" tab.)
// Server component: renders the client-side intro + the two unchanged tool
// components below. Do not add "use client" here — children own their own state.
export default async function AdminDevPage() {
  await requireAdmin();
  return (
    <div className="max-w-4xl space-y-8">
      <TabIntro
        eyebrow="Dev Tools"
        title="Alat developer & ops"
        what="Khusus admin — semua panggilan RPC tercatat di audit log (admin.rpc.test). Dua alat: RPC Console (kirim satu panggilan JSON-RPC ke mesin kontainer user yang sedang jalan) dan Policy Kemampuan Agen (sembunyikan/kunci skill & tool tertentu dari picker agen di /app)."
        canDo={[
          "Panggil method baca (cek status, daftar sesi, usage) ke kontainer user tertentu",
          "Panggil method mutasi (ubah config/skill) — berhati-hati, ini mengubah kontainer milik user",
          "Sembunyikan skill/tool dari picker agen, atau kunci-on yang wajib ada",
        ]}
        how="RPC Console: pilih kontainer running, pilih method, isi params, lalu Kirim — method mutasi minta konfirmasi. Policy Kemampuan: pilih skill/tool dari katalog (bukan hafal key), lalu simpan. Perubahan policy terasa saat user buka /app lagi. Ini kurasi tampilan, bukan gerbang keamanan keras."
        legend={[
          { tone: "ok", label: "Method baca — aman, tanpa konfirmasi" },
          { tone: "bad", label: "Method mutasi — mengubah kontainer user" },
          { tone: "info", label: "Semua panggilan masuk audit log" },
        ]}
        warning="Zona berbahaya: panggilan mutasi mengubah state kontainer milik user secara langsung dan tidak bisa dibatalkan otomatis. Pastikan kamu memilih kontainer dan method yang benar."
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">RPC Console</h2>
          <p className="text-xs text-zinc-500">
            Kirim satu panggilan JSON-RPC ke mesin kontainer user yang sedang
            jalan. Maks 60 panggilan / 60 detik, timeout 20 detik, tercatat
            audit.
          </p>
        </div>
        <RpcConsole />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">
            Policy Kemampuan Agen
          </h2>
          <p className="text-xs text-zinc-500">
            Sembunyikan atau kunci-on skill &amp; tool dari picker agen di /app.
            Kurasi tampilan, bukan kontrol akses keras.
          </p>
        </div>
        <CapabilityPolicyForm />
      </section>
    </div>
  );
}
