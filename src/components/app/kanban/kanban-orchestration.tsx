"use client";

import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Loader2, Sparkles, Save, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/app/store";
import { useAppStore } from "@/lib/app/store";
import { useDialogA11y } from "./use-dialog-a11y";

type OrchConfig = {
  dispatch_in_gateway?: boolean;
  orchestrator_profile?: string;
  default_assignee?: string;
  auto_decompose?: boolean;
  auto_decompose_per_tick?: number;
};

type ProfileMeta = { name: string; description: string; descriptionAuto: boolean };
type OrchResult = { config: OrchConfig; profiles: ProfileMeta[] };

export function KanbanOrchestration({ board, onClose }: { board: string; onClose: () => void }) {
  const status = useAppStore((s) => s.status);
  const [data, setData] = useState<OrchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = (await getClient()?.request("kanban.orchestration")) as OrchResult | undefined;
      if (res) setData(res);
    } finally {
      setLoading(false);
    }
  };

  // Load when the modal opens AND whenever the connection becomes ready
  // (fixes "profiles only show after manual refresh" if WS wasn't ready yet).
  useEffect(() => {
    if (status === "ready") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, board]);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(panelRef, onClose);

  const cfg = data?.config ?? {};
  const profiles = data?.profiles ?? [];
  const profileOpts = profiles.map((p) => p.name);
  const autoMode = cfg.dispatch_in_gateway !== false;

  const patch = async (key: string, value: unknown) => {
    setSavingKey(key);
    try {
      await getClient()?.request("kanban.setOrchestration", { [key]: value });
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#030014]/80 backdrop-blur-sm" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="kanban-orch-title" className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Settings2 className="size-4 text-cyan-300/80" />
            <h2 id="kanban-orch-title" className="text-sm font-semibold text-white/90">Pengaturan Orkestrasi</h2>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                autoMode ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-white/15 text-white/50",
              )}
            >
              {autoMode ? "Mode otomatis" : "Mode manual"}
            </span>
          </div>
          <button type="button" aria-label="Tutup" onClick={onClose} className="rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white/80">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-5">
          <p className="text-xs text-white/45">
            Pengaturan ini menentukan bagaimana tugas dibagi dan dikerjakan otomatis oleh agen-agenmu. Biarkan default kalau kamu belum yakin — semuanya sudah jalan otomatis.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Profil Orkestrator" hint="Agen yang memecah tugas besar lalu membagikannya ke agen lain.">
              <select
                value={cfg.orchestrator_profile || ""}
                disabled={savingKey === "orchestrator_profile"}
                onChange={(e) => void patch("orchestrator_profile", e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none"
              >
                <option value="" className="bg-[#0B0E14]">Default (otomatis)</option>
                {profileOpts.map((p) => (
                  <option key={p} value={p} className="bg-[#0B0E14]">{p}</option>
                ))}
              </select>
            </Field>

            <Field label="Agen default (cadangan)" hint="Dipakai kalau sistem tidak tahu tugas ini cocok untuk agen yang mana.">
              <select
                value={cfg.default_assignee || ""}
                disabled={savingKey === "default_assignee"}
                onChange={(e) => void patch("default_assignee", e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-cyan-400/50 focus:outline-none"
              >
                <option value="" className="bg-[#0B0E14]">Default (otomatis)</option>
                {profileOpts.map((p) => (
                  <option key={p} value={p} className="bg-[#0B0E14]">{p}</option>
                ))}
              </select>
            </Field>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <input
              type="checkbox"
              checked={cfg.auto_decompose !== false}
              disabled={savingKey === "auto_decompose"}
              onChange={(e) => void patch("auto_decompose", e.target.checked)}
              className="mt-0.5 size-4 accent-cyan-400"
            />
            <span>
              <span className="text-sm font-medium text-white/85">Otomatis pecah tugas jadi langkah kecil</span>
              <span className="block text-xs text-white/45">
                Kalau aktif, tugas besar yang baru kamu buat langsung dipecah jadi beberapa langkah dan dibagikan ke agen. Matikan kalau kamu mau memecahnya sendiri.
              </span>
            </span>
          </label>

          <div>
            <p className="mb-1 text-sm font-semibold text-white/80">Keahlian tiap agen</p>
            <p className="mb-2.5 text-xs text-white/45">
              Tulis singkat agen ini jago di bidang apa. Gunanya: sistem otomatis mengarahkan tugas ke agen yang paling cocok. Tekan <span className="text-cyan-300">Tuliskan otomatis</span> kalau mau dibuatkan AI.
            </p>
            {loading && profiles.length === 0 ? (
              <div className="flex items-center gap-2 px-1 py-3 text-xs text-white/40">
                <Loader2 className="size-3.5 animate-spin" /> Memuat daftar agen…
              </div>
            ) : profiles.length === 0 ? (
              <p className="px-1 py-3 text-xs text-white/35">Belum ada agen.</p>
            ) : (
              <div className="space-y-2.5">
                {profiles.map((p) => (
                  <ProfileDescRow key={p.name} profile={p} onChanged={load} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-4">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/[0.06]"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Segarkan
          </button>
          <button type="button" onClick={onClose} className="rounded-lg bg-white/[0.06] px-4 py-1.5 text-xs text-white/85 hover:bg-white/[0.1]">
            Selesai
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-white/35">{hint}</p> : null}
    </div>
  );
}

function ProfileDescRow({ profile, onChanged }: { profile: ProfileMeta; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState(profile.description);
  const [saving, setSaving] = useState(false);
  const [autoing, setAutoing] = useState(false);

  useEffect(() => setValue(profile.description), [profile.description]);

  const save = async () => {
    setSaving(true);
    try {
      await getClient()?.request("kanban.setProfileDescription", { name: profile.name, description: value });
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const auto = async () => {
    setAutoing(true);
    try {
      const res = (await getClient()?.request("kanban.autoDescribeProfile", { name: profile.name })) as
        | { ok?: boolean; description?: string }
        | undefined;
      if (res?.ok && res.description) setValue(res.description);
      await onChanged();
    } finally {
      setAutoing(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-white/80">{profile.name}</span>
        {!profile.description ? (
          <span className="rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[9px] text-amber-300/80">belum diisi</span>
        ) : profile.descriptionAuto ? (
          <span className="rounded-full bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan-300/70">ditulis AI</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Mis. jago riset & menulis ringkasan"
          className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          title="Simpan keahlian yang kamu tulis"
          className="inline-flex items-center gap-1 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/[0.06] disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Simpan
        </button>
        <button
          type="button"
          onClick={auto}
          disabled={autoing}
          title="Biar AI yang menuliskan keahlian agen ini, dilihat dari skill & alat yang dia punya"
          className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/40 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50"
        >
          {autoing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Tuliskan otomatis
        </button>
      </div>
    </div>
  );
}
