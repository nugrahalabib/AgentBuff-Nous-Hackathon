"use client";

import { useRef } from "react";
import { X, PenLine, Bot, CheckCircle2, ArrowRight } from "lucide-react";
import { statusMeta, STATUS_ORDER } from "./helpers";
import { cn } from "@/lib/utils";
import { useDialogA11y } from "./use-dialog-a11y";

const FLOW = [
  { icon: PenLine, label: "Kamu tulis tugas", tone: "text-cyan-300" },
  { icon: Bot, label: "Agen ambil & kerjakan", tone: "text-emerald-300" },
  { icon: CheckCircle2, label: "Selesai otomatis", tone: "text-fuchsia-300" },
];

const FEATURES: { name: string; desc: string }[] = [
  {
    name: "+ Tugas baru",
    desc: "Bikin satu tugas. Tulis apa yang kamu mau, pilih agen, lalu agen mengerjakannya otomatis.",
  },
  {
    name: "Swarm",
    desc: "Untuk pekerjaan besar: beberapa agen mengerjakan bagian berbeda secara bersamaan, lalu satu agen Pengecek memeriksa dan satu agen Perangkum menggabungkan semua hasilnya jadi satu.",
  },
  {
    name: "Jalankan sekarang",
    desc: "Dorong agen supaya langsung mengambil tugas yang sudah siap, tanpa menunggu giliran otomatis.",
  },
  {
    name: "Pengaturan Orkestrasi",
    desc: "Atur agen mana yang bertugas membagi-bagi pekerjaan, dan apakah tugas besar otomatis dipecah jadi langkah-langkah kecil.",
  },
  {
    name: "Geser & tempel kartu",
    desc: "Tarik kartu ke kolom lain untuk mengubah statusnya. Tarik ke kotak 'Tarik ke sini untuk hapus' untuk menghapusnya.",
  },
];

export function KanbanHelp({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(panelRef, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="kanban-help-title" className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 id="kanban-help-title" className="text-sm font-semibold text-white/90">Cara kerja Papan Tugas</h2>
          <button type="button" aria-label="Tutup" onClick={onClose} className="rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white/80">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-5 py-5">
          <div>
            <p className="mb-3 text-sm text-white/65">
              Kamu cukup menulis tugas — agenmu yang mengerjakannya otomatis. Tiap tugas bergerak melewati kolom sesuai progresnya. Kamu tinggal memantau dan menjawab kalau diminta.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {FLOW.map((f, i) => (
                <div key={f.label} className="flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
                    <f.icon className={cn("size-3.5", f.tone)} />
                    <span className="text-xs font-medium text-white/75">{f.label}</span>
                  </div>
                  {i < FLOW.length - 1 ? <ArrowRight className="size-3.5 text-white/25" /> : null}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Arti tiap kolom</h3>
            <div className="space-y-1.5">
              {STATUS_ORDER.filter((s) => s !== "archived").map((s) => {
                const meta = statusMeta(s);
                return (
                  <div key={s} className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <span className={cn("mt-1 size-2 shrink-0 rounded-full", meta.dot)} />
                    <div>
                      <span className={cn("text-xs font-semibold", meta.text)}>{meta.label}</span>
                      <span className="ml-2 text-xs text-white/55">{meta.hint}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Tombol & fitur</h3>
            <div className="space-y-1.5">
              {FEATURES.map((f) => (
                <div key={f.name} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <span className="text-xs font-semibold text-cyan-200">{f.name}</span>
                  <p className="mt-0.5 text-xs text-white/55">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-white/[0.06] px-5 py-3 text-right">
          <button type="button" onClick={onClose} className="rounded-lg bg-white/[0.06] px-4 py-1.5 text-xs text-white/80 hover:bg-white/[0.1]">
            Mengerti
          </button>
        </div>
      </div>
    </div>
  );
}
