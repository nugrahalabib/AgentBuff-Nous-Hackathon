"use client";

/**
 * CronFiltersBar — search + status + schedule kind + last status + sort.
 * All-controlled, parent owns CronListUiFilters state.
 */
import { ArrowDown, ArrowUp, RotateCcw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LIST_FILTERS,
  type CronListUiFilters,
} from "./helpers";

export function CronFiltersBar({
  filters,
  onChange,
  total,
}: {
  filters: CronListUiFilters;
  onChange: (next: CronListUiFilters) => void;
  total: number;
}) {
  const isFiltered =
    filters.query !== DEFAULT_LIST_FILTERS.query ||
    filters.enabled !== DEFAULT_LIST_FILTERS.enabled ||
    filters.scheduleKind !== DEFAULT_LIST_FILTERS.scheduleKind ||
    filters.lastStatus !== DEFAULT_LIST_FILTERS.lastStatus ||
    filters.sortBy !== DEFAULT_LIST_FILTERS.sortBy ||
    filters.sortDir !== DEFAULT_LIST_FILTERS.sortDir;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-white/40"
            aria-hidden
          />
          <input
            type="text"
            value={filters.query}
            onChange={(e) =>
              onChange({ ...filters, query: e.target.value })
            }
            placeholder="Cari rutinitas (nama, deskripsi)..."
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-[12px] text-white/85 placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
        </div>

        <Select
          label="Status"
          value={filters.enabled}
          onChange={(v) =>
            onChange({
              ...filters,
              enabled: v as CronListUiFilters["enabled"],
            })
          }
          options={[
            { value: "all", label: "Semua" },
            { value: "enabled", label: "Aktif" },
            { value: "disabled", label: "Pause" },
          ]}
        />

        <Select
          label="Jadwal"
          value={filters.scheduleKind}
          onChange={(v) =>
            onChange({
              ...filters,
              scheduleKind: v as CronListUiFilters["scheduleKind"],
            })
          }
          options={[
            { value: "all", label: "Semua" },
            { value: "at", label: "Sekali" },
            { value: "every", label: "Tiap N" },
            { value: "cron", label: "Cron" },
          ]}
        />

        <Select
          label="Terakhir"
          value={filters.lastStatus}
          onChange={(v) =>
            onChange({
              ...filters,
              lastStatus: v as CronListUiFilters["lastStatus"],
            })
          }
          options={[
            { value: "all", label: "Semua" },
            { value: "ok", label: "Sukses" },
            { value: "error", label: "Gagal" },
            { value: "skipped", label: "Dilewat" },
          ]}
        />

        <Select
          label="Urutkan"
          value={filters.sortBy}
          onChange={(v) =>
            onChange({ ...filters, sortBy: v as CronListUiFilters["sortBy"] })
          }
          options={[
            { value: "nextRunAtMs", label: "Lari terdekat" },
            { value: "updatedAtMs", label: "Diubah" },
            { value: "name", label: "Nama" },
          ]}
        />

        <button
          type="button"
          onClick={() =>
            onChange({
              ...filters,
              sortDir: filters.sortDir === "asc" ? "desc" : "asc",
            })
          }
          aria-label={filters.sortDir === "asc" ? "Naik" : "Turun"}
          title={filters.sortDir === "asc" ? "Naik" : "Turun"}
          className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] p-2 text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          {filters.sortDir === "asc" ? (
            <ArrowUp className="size-3.5" aria-hidden />
          ) : (
            <ArrowDown className="size-3.5" aria-hidden />
          )}
        </button>

        {isFiltered ? (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_LIST_FILTERS)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-100"
          >
            <RotateCcw className="size-3" aria-hidden />
            Reset
          </button>
        ) : null}
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
        · {total} rutinitas
      </p>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] pl-2 pr-1 py-1 transition",
        "focus-within:border-cyan-400/40",
      )}
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent py-1 pr-1 text-[11px] text-white/85 focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-[#0B0E14]">
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
