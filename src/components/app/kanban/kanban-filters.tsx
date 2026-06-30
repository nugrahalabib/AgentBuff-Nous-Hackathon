"use client";

import { Search, Zap, RefreshCw, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type KanbanFilterState = {
  search: string;
  assignee: string;
  tenant: string;
  priority: string; // "", "urgent", "high", "normal"
  showArchived: boolean;
  lanesByProfile: boolean;
};

export const DEFAULT_FILTERS: KanbanFilterState = {
  search: "",
  assignee: "",
  tenant: "",
  priority: "",
  showArchived: false,
  lanesByProfile: false,
};

export function KanbanFilters({
  state,
  setState,
  assignees,
  tenants,
  onNudge,
  nudging,
  onRefresh,
  refreshing,
  onClear,
  dirty,
}: {
  state: KanbanFilterState;
  setState: (next: KanbanFilterState) => void;
  assignees: string[];
  tenants: string[];
  onNudge: () => void;
  nudging: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  onClear: () => void;
  dirty: boolean;
}) {
  const up = (patch: Partial<KanbanFilterState>) => setState({ ...state, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.06] bg-[#0B0E14]/20 px-6 py-3">
      <div className="min-w-44 flex-1">
        <label className="mb-1 block text-[10px] font-medium text-white/45">Cari tugas</label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={state.search}
            aria-label="Cari tugas"
            onChange={(e) => up({ search: e.target.value })}
            placeholder="Ketik judul tugas…"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-3 text-xs text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
        </div>
      </div>

      {tenants.length > 0 ? (
        <FilterSelect label="Grup" value={state.tenant} onChange={(v) => up({ tenant: v })} allLabel="Semua grup" options={tenants} />
      ) : null}

      <FilterSelect label="Agen" value={state.assignee} onChange={(v) => up({ assignee: v })} allLabel="Semua agen" options={assignees} />

      <div>
        <label className="mb-1 block text-[10px] font-medium text-white/45">Prioritas</label>
        <select
          value={state.priority}
          aria-label="Prioritas"
          onChange={(e) => up({ priority: e.target.value })}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/85 focus:border-cyan-400/50 focus:outline-none"
        >
          <option value="" className="bg-[#0B0E14]">Semua prioritas</option>
          <option value="urgent" className="bg-[#0B0E14]">Mendesak</option>
          <option value="high" className="bg-[#0B0E14]">Tinggi</option>
          <option value="normal" className="bg-[#0B0E14]">Normal</option>
        </select>
      </div>

      <label className="flex items-center gap-1.5 pb-1.5 text-xs text-white/70" title="Tampilkan juga tugas yang sudah diarsipkan">
        <input type="checkbox" checked={state.showArchived} onChange={(e) => up({ showArchived: e.target.checked })} className="size-3.5 accent-cyan-400" />
        Tampilkan yang diarsip
      </label>
      <label className="flex items-center gap-1.5 pb-1.5 text-xs text-white/70" title="Pisahkan papan jadi baris per agen">
        <input type="checkbox" checked={state.lanesByProfile} onChange={(e) => up({ lanesByProfile: e.target.checked })} className="size-3.5 accent-cyan-400" />
        Kelompokkan per agen
      </label>

      <div className="ml-auto flex items-center gap-2 pb-0.5">
        <button
          type="button"
          onClick={onNudge}
          disabled={nudging}
          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/40 px-2.5 py-1.5 text-xs text-indigo-200 transition hover:bg-indigo-400/10 disabled:opacity-50"
          title="Suruh agen langsung ambil & kerjakan tugas yang sudah siap, tanpa menunggu giliran"
        >
          {nudging ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Jalankan sekarang
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-white/70 transition hover:bg-white/[0.06]"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /> Segarkan
        </button>
        {dirty ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-white/60 transition hover:bg-white/[0.06]"
          >
            <X className="size-3.5" /> Reset filter
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: string[];
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">{label}</label>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/85 focus:border-cyan-400/50 focus:outline-none"
      >
        <option value="" className="bg-[#0B0E14]">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o} className="bg-[#0B0E14]">{o}</option>
        ))}
      </select>
    </div>
  );
}
