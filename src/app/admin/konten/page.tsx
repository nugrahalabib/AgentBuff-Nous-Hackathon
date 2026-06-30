import { requireAdmin } from "@/lib/admin/rbac";
import { AnnouncementsBrowser } from "../_components/announcements-browser";
import { CmsBrowser } from "../_components/cms-browser";
import { TabIntro } from "../_components/ui";

export const dynamic = "force-dynamic";

export default async function AdminKontenPage() {
  await requireAdmin();
  return (
    <div className="space-y-8">
      <TabIntro
        eyebrow="Konten & Sistem"
        title="Konten"
        what="Dua alat dalam satu halaman: kirim pengumuman in-app ke user, dan edit copy landing page tanpa deploy."
        canDo={[
          "Broadcast notifikasi ke segmen user (semua / onboarded / trial / berlangganan) dan lihat riwayatnya.",
          "Edit teks landing per-blok dalam bahasa ID atau EN.",
          "Simpan draft dulu, lalu publikasikan — perubahan tampil di landing dalam ≤30 detik.",
          "Reset blok ke teks bawaan kapan saja.",
        ]}
        how="Pengumuman: tulis pesan → pilih audiens → kirim. Landing CMS: pilih bahasa → pilih blok → edit → Simpan draft → Publikasikan."
        legend={[
          { tone: "muted", label: "default = teks bawaan" },
          { tone: "warn", label: "draft = belum tampil" },
          { tone: "ok", label: "live = sudah tampil" },
        ]}
        warning="Broadcast tidak bisa ditarik kembali — sekali terkirim, notifikasi sudah masuk inbox tiap user. Publish landing langsung memengaruhi halaman publik."
      />

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Konten — Pengumuman
          </h2>
          <p className="text-sm text-zinc-400">
            Broadcast notifikasi in-app ke user.
          </p>
        </div>
        <AnnouncementsBrowser />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Konten — Landing (CMS)
          </h2>
          <p className="text-sm text-zinc-400">
            Edit copy landing (hero, FAQ, testimoni) tanpa deploy. Simpan draft
            dulu, lalu Publikasikan — perubahan tampil di landing ≤30 detik.
            Kosong / reset = pakai teks bawaan.
          </p>
        </div>
        <CmsBrowser />
      </section>
    </div>
  );
}
