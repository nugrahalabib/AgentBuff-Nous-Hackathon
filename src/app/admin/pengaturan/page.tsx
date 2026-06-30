import { requireAdmin } from "@/lib/admin/rbac";
import { EmailSettingsForm } from "../_components/email-settings-form";
import { EmailTemplatesEditor } from "../_components/email-templates-editor";
import { RuntimeSettingsForm } from "../_components/runtime-settings-form";
import { EngineDefaultsForm } from "../_components/engine-defaults-form";
import { LimitsMatrixForm } from "../_components/limits-matrix-form";
import { FlagsForm } from "../_components/flags-form";
import { TabIntro } from "../_components/ui";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  await requireAdmin();
  return (
    <div className="max-w-4xl space-y-6">
      <TabIntro
        eyebrow="Operasional"
        title="Pengaturan"
        what="Pusat kendali operasional portal: batas resource tiap kontainer per-tier, durasi trial, model & perilaku mesin per-tier, batas pemakaian (entitlement & media), email reminder, dan saklar runtime (maintenance / tutup pendaftaran)."
        canDo={[
          "Atur batas RAM / CPU / proses tiap kontainer, per tier (Starter / OP Buff / Guild Master)",
          "Set lama trial gratis (hari)",
          "Tentukan model mesin default, mode lean, auto-update, timezone default — per tier",
          "Batasi maks agen / channel / skill dan ukuran media per pesan — per tier",
          "Hidup/matikan email reminder, jadwal reminder trial, nama pengirim, reply-to",
          "Edit copy semua template email (ID/EN)",
          "Saklar maintenance & tutup pendaftaran",
        ]}
        how="Tiap kartu punya saklar Pakai default / Override. Kosong (Pakai default) = ikut setelan env, Override = pakai angka kamu. Lihat badge Kapan berlaku di tombol Simpan tiap kartu — sebagian langsung (<=30 dtk), sebagian baru jalan saat kontainer provision/restart berikutnya. Tiap kartu disimpan terpisah."
        legend={[
          { tone: "ok", label: "Langsung (<=30 dtk)" },
          { tone: "warn", label: "Saat provision/restart" },
          { tone: "info", label: "Worker reload (<=60 dtk)" },
        ]}
        warning="Kontainer yang sedang jalan tetap pakai batas lama sampai di-restart. Batas RAM/CPU/proses & media baru berlaku saat provision/restart kontainer berikutnya."
      />

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Batas Kontainer & Mesin
        </div>
        <RuntimeSettingsForm />
      </section>

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Engine Default per Tier
        </div>
        <EngineDefaultsForm />
      </section>

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Batas per Tier (Entitlement &amp; Media)
        </div>
        <LimitsMatrixForm />
      </section>

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Email & Reminder
        </div>
        <EmailSettingsForm />
      </section>

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Template Email (copy editor)
        </div>
        <EmailTemplatesEditor />
      </section>

      <section>
        <div className="mb-2 text-sm font-medium text-zinc-300">
          Feature Flags
        </div>
        <FlagsForm />
      </section>
    </div>
  );
}
