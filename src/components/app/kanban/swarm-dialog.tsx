"use client";

import { useRef, useState } from "react";
import { X, Loader2, Users, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/app/store";
import { useDialogA11y } from "./use-dialog-a11y";

type AgentOpt = { id: string; name: string };
type WorkerRow = { profile: string; title: string };

export function SwarmDialog({
  board,
  agents,
  onClose,
  onCreated,
}: {
  board: string;
  agents: AgentOpt[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [workers, setWorkers] = useState<WorkerRow[]>([
    { profile: agents[0]?.id ?? "default", title: "" },
    { profile: agents[0]?.id ?? "default", title: "" },
  ]);
  const [verifier, setVerifier] = useState(agents[0]?.id ?? "default");
  const [synthesizer, setSynthesizer] = useState(agents[0]?.id ?? "default");
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(panelRef, onClose, busy);

  const submit = async () => {
    const valid = workers.filter((w) => w.profile && w.title.trim());
    if (!goal.trim() || valid.length === 0 || busy) {
      setError("Isi tujuan + minimal satu anggota (agen + tugasnya).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await getClient()?.request("kanban.swarm", {
        board,
        goal: goal.trim(),
        workers: valid.map((w) => ({ profile: w.profile, title: w.title.trim() })),
        verifier,
        synthesizer,
        priority,
      })) as { ok?: boolean; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error || "Gagal membuat swarm");
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat swarm");
    } finally {
      setBusy(false);
    }
  };

  const setWorker = (i: number, patch: Partial<WorkerRow>) =>
    setWorkers((ws) => ws.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="kanban-swarm-title" className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-fuchsia-300" />
            <h2 id="kanban-swarm-title" className="text-sm font-semibold text-white/90">Swarm — banyak agen kerja bareng</h2>
          </div>
          <button type="button" aria-label="Tutup" onClick={() => !busy && onClose()} className="rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white/80">
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Tujuan akhir</label>
            <textarea
              autoFocus
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              placeholder="Apa hasil akhir yang kamu mau dari kerja bareng ini?"
              className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Anggota tim (kerja bersamaan)</label>
              <button
                type="button"
                onClick={() => setWorkers((ws) => [...ws, { profile: agents[0]?.id ?? "default", title: "" }])}
                className="inline-flex items-center gap-1 text-[11px] text-cyan-300/80 hover:text-cyan-200"
              >
                <Plus className="size-3" /> tambah anggota
              </button>
            </div>
            <div className="space-y-2">
              {workers.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={w.profile}
                    aria-label={`Agen anggota ${i + 1}`}
                    onChange={(e) => setWorker(i, { profile: e.target.value })}
                    className="w-32 shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-white/85 focus:border-cyan-400/50 focus:outline-none"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id} className="bg-[#0B0E14]">{a.name}</option>
                    ))}
                  </select>
                  <input
                    value={w.title}
                    aria-label={`Tugas anggota ${i + 1}`}
                    onChange={(e) => setWorker(i, { title: e.target.value })}
                    placeholder="Tugas anggota ini…"
                    className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
                  />
                  {workers.length > 1 ? (
                    <button type="button" aria-label={`Hapus anggota ${i + 1}`} onClick={() => setWorkers((ws) => ws.filter((_, idx) => idx !== i))} className="text-white/30 hover:text-red-300">
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Pengecek</label>
              <select value={verifier} onChange={(e) => setVerifier(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none">
                {agents.map((a) => <option key={a.id} value={a.id} className="bg-[#0B0E14]">{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Perangkum hasil</label>
              <select value={synthesizer} onChange={(e) => setSynthesizer(e.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none">
                {agents.map((a) => <option key={a.id} value={a.id} className="bg-[#0B0E14]">{a.name}</option>)}
              </select>
            </div>
          </div>

          {error ? <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <button type="button" onClick={() => !busy && onClose()} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70 hover:bg-white/[0.06]">Batal</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-fuchsia-500 via-indigo-500 to-cyan-400 px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:brightness-110 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Users className="size-3.5" />}
            Mulai Swarm
          </button>
        </div>
      </div>
    </div>
  );
}
