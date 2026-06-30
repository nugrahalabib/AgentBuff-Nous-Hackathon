"use client";

import { useRef, useState } from "react";
import { X, Loader2, ArrowLeft, ArrowRight, AlertTriangle, PenLine, Users, Settings2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/app/store";
import { TASK_TEMPLATES, findPlaceholders, type TaskPrefill } from "./task-templates";
import { useDialogA11y } from "./use-dialog-a11y";

type AgentOpt = { id: string; name: string };

const START_OPTS = [
  { value: "running", label: "Kerjakan sekarang", hint: "Agen langsung mengerjakan" },
  { value: "triage", label: "Rinci dulu", hint: "Tahan untuk dirinci / dipecah" },
  { value: "blocked", label: "Tahan dulu", hint: "Belum dikerjakan dulu" },
];

export function CreateWizard({
  board,
  agents,
  startPrefill,
  onClose,
  onCreated,
  onPickSwarm,
  onPickOrchestrator,
}: {
  board: string;
  agents: AgentOpt[];
  startPrefill?: TaskPrefill | null;
  onClose: () => void;
  onCreated: () => void;
  onPickSwarm: () => void;
  onPickOrchestrator: () => void;
}) {
  const [step, setStep] = useState<"choose" | "customize">(startPrefill ? "customize" : "choose");
  const [title, setTitle] = useState(startPrefill?.title ?? "");
  const [body, setBody] = useState(startPrefill?.body ?? "");
  const [assignee, setAssignee] = useState(agents[0]?.id ?? "");
  const [priority, setPriority] = useState(startPrefill?.priority ?? 0);
  const [start, setStart] = useState("running");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceCreate, setForceCreate] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(panelRef, onClose, busy);

  const pickTemplate = (pf: TaskPrefill) => {
    setTitle(pf.title ?? "");
    setBody(pf.body ?? "");
    setPriority(pf.priority ?? 0);
    setForceCreate(false);
    setStep("customize");
  };

  const placeholders = findPlaceholders(title, body);

  const submit = async () => {
    if (!title.trim() || busy) return;
    if (placeholders.length > 0 && !forceCreate) {
      setForceCreate(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = getClient();
      if (!client) throw new Error("Tidak terhubung ke engine");
      const params: Record<string, unknown> = {
        board,
        title: title.trim(),
        body: body.trim() || undefined,
        assignee: assignee || undefined,
        priority,
      };
      if (start === "triage") params.triage = true;
      else params.initialStatus = start;
      const res = (await client.request("kanban.createTask", params)) as { ok?: boolean; error?: string };
      if (!res?.ok) throw new Error(res?.error || "Gagal membuat tugas");
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat tugas");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="kanban-create-title" className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            {step === "customize" && !startPrefill ? (
              <button type="button" aria-label="Kembali" onClick={() => setStep("choose")} className="rounded-md p-1 text-white/50 hover:bg-white/[0.06] hover:text-white/85">
                <ArrowLeft className="size-4" />
              </button>
            ) : (
              <Sparkles className="size-4 text-cyan-300" />
            )}
            <h2 id="kanban-create-title" className="text-sm font-semibold text-white/90">
              {step === "choose" ? "Mau bikin apa?" : "Sesuaikan tugasmu"}
            </h2>
          </div>
          <button type="button" aria-label="Tutup" onClick={() => !busy && onClose()} className="rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white/80">
            <X className="size-4" />
          </button>
        </div>

        {step === "choose" ? (
          <div className="space-y-5 overflow-y-auto px-5 py-5">
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Mulai dari template</p>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {TASK_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => pickTemplate(tpl.prefill)}
                    className="group/t relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-left transition hover:bg-white/[0.05]"
                  >
                    <div className={cn("pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-gradient-to-br opacity-40 blur-2xl transition-opacity group-hover/t:opacity-70", tpl.glow)} />
                    <div className="relative">
                      <div className="mb-2 flex size-8 items-center justify-center rounded-lg border border-white/10 bg-[#0B0E14]/60">
                        <tpl.icon className={cn("size-4", tpl.accent)} />
                      </div>
                      <p className="text-sm font-semibold text-white/90">{tpl.title}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-white/50">{tpl.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Atau cara lain</p>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <OptionCard
                  icon={<PenLine className="size-4 text-cyan-300" />}
                  title="Tugas dari nol"
                  desc="Tulis tugasmu sendiri dari kosong"
                  onClick={() => pickTemplate({})}
                />
                <OptionCard
                  icon={<Users className="size-4 text-fuchsia-300" />}
                  title="Swarm"
                  desc="Banyak agen kerja bareng untuk 1 tujuan besar"
                  onClick={() => {
                    onClose();
                    onPickSwarm();
                  }}
                />
                <OptionCard
                  icon={<Settings2 className="size-4 text-emerald-300" />}
                  title="Atur Orkestrator"
                  desc="Atur siapa yang membagi tugas & keahlian tiap agen"
                  onClick={() => {
                    onClose();
                    onPickOrchestrator();
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 overflow-y-auto px-5 py-4">
            {placeholders.length > 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <div className="text-xs text-amber-100">
                  <p className="font-medium">Ganti dulu bagian ini sesuai kebutuhanmu:</p>
                  <p className="mt-0.5">
                    {placeholders.map((p) => (
                      <span key={p} className="mr-1.5 inline-block rounded bg-amber-400/20 px-1.5 py-0.5 font-mono text-[11px]">{p}</span>
                    ))}
                  </p>
                </div>
              </div>
            ) : null}

            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Judul</label>
              <input
                autoFocus
                aria-label="Judul"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setForceCreate(false); }}
                placeholder="Apa yang mau kamu minta ke agen?"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Detail (opsional)</label>
              <textarea
                aria-label="Detail"
                value={body}
                onChange={(e) => { setBody(e.target.value); setForceCreate(false); }}
                rows={3}
                placeholder="Tambahan instruksi atau konteks (boleh dikosongi)…"
                className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Agen</label>
                <select aria-label="Agen" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none">
                  <option value="">— pilih agen —</option>
                  {agents.map((a) => <option key={a.id} value={a.id} className="bg-[#0B0E14]">{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Prioritas</label>
                <select aria-label="Prioritas" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none">
                  <option value={0} className="bg-[#0B0E14]">Normal</option>
                  <option value={1} className="bg-[#0B0E14]">Sedang</option>
                  <option value={2} className="bg-[#0B0E14]">Tinggi</option>
                  <option value={3} className="bg-[#0B0E14]">Mendesak</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Mau langsung dikerjakan?</label>
              <div className="grid grid-cols-3 gap-2">
                {START_OPTS.map((o) => (
                  <button key={o.value} type="button" onClick={() => setStart(o.value)} className={cn("rounded-lg border px-2 py-2 text-left transition", start === o.value ? "border-cyan-400/50 bg-cyan-400/10" : "border-white/10 bg-white/[0.02] hover:border-white/20")}>
                    <p className="text-xs font-medium text-white/85">{o.label}</p>
                    <p className="mt-0.5 text-[10px] leading-tight text-white/40">{o.hint}</p>
                  </button>
                ))}
              </div>
            </div>

            <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
              Setelah dibuat, agen yang kamu pilih akan otomatis mengerjakan tugas ini. Pantau progresnya di papan; agen akan minta bantuanmu kalau perlu (kartu pindah ke kolom &quot;Butuh kamu&quot;).
            </p>

            {error ? <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p> : null}
          </div>
        )}

        {step === "customize" ? (
          <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-5 py-4">
            <button type="button" onClick={() => (startPrefill ? onClose() : setStep("choose"))} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70 hover:bg-white/[0.06]">
              <ArrowLeft className="size-3.5" /> {startPrefill ? "Batal" : "Kembali"}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!title.trim() || busy}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50",
                forceCreate && placeholders.length > 0
                  ? "bg-gradient-to-br from-amber-400 to-orange-500"
                  : "bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500",
              )}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
              {forceCreate && placeholders.length > 0 ? "Tetap buat (ada yang belum diganti)" : "Buat tugas"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OptionCard({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-left transition hover:border-cyan-400/30 hover:bg-white/[0.05]">
      <div className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-[#0B0E14]/60">{icon}</div>
      <p className="text-sm font-semibold text-white/90">{title}</p>
      <p className="text-[11px] leading-snug text-white/50">{desc}</p>
    </button>
  );
}
