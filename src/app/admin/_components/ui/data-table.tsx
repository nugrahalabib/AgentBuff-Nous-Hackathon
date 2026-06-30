"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "./primitives";

// --- SearchInput: debounced, clear-x, scope hint ---

export function SearchInput({
  value,
  onChange,
  placeholder = "Cari…",
  scopeHint,
  debounceMs = 300,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  scopeHint?: string;
  debounceMs?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (local !== value) onChange(local);
    }, debounceMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-8 pr-7 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
      />
      {local && (
        <button
          type="button"
          onClick={() => {
            setLocal("");
            onChange("");
          }}
          aria-label="Bersihkan pencarian"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
        >
          <X className="size-3.5" />
        </button>
      )}
      {scopeHint && local && <p className="absolute mt-1 text-[10px] text-zinc-500">Cari di: {scopeHint}</p>}
    </div>
  );
}

// --- Pagination: prev/next + page size ---

export function Pagination({
  page,
  totalPages,
  onPage,
  pageSize,
  onPageSize,
  pageSizeOptions = [25, 50, 100],
  total,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  pageSize?: number;
  onPageSize?: (n: number) => void;
  pageSizeOptions?: number[];
  total?: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 px-1 pt-3 text-xs text-zinc-500">
      <div className="flex items-center gap-2">
        {typeof total === "number" && <span className="tabular-nums">{total} baris</span>}
        {onPageSize && (
          <label className="flex items-center gap-1">
            Tampil
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 outline-none [color-scheme:dark]"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="inline-flex items-center gap-0.5 rounded border border-zinc-700 px-2 py-1 transition hover:bg-zinc-800 disabled:opacity-40"
        >
          <ChevronLeft className="size-3.5" /> Sebelumnya
        </button>
        <span className="px-1 tabular-nums">
          Hal {page} / {Math.max(1, totalPages)}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="inline-flex items-center gap-0.5 rounded border border-zinc-700 px-2 py-1 transition hover:bg-zinc-800 disabled:opacity-40"
        >
          Berikutnya <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// --- FilterBar: search + filter slots + actions ---

export function FilterBar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// --- DataTable ---

export type Column<R> = {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
};

export function DataTable<R>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  isLoading,
  empty,
  onRowClick,
}: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (key: string) => void;
  isLoading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: R) => void;
}) {
  const alignCls = (a?: string) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-[11px] uppercase tracking-wide text-zinc-500">
            {columns.map((c) => {
              const isSorted = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={isSorted ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn("px-3 py-2 font-medium", alignCls(c.align))}
                >
                  {c.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-zinc-200"
                    >
                      {c.header}
                      {isSorted &&
                        (sort!.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-zinc-800/60">
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2.5">
                      <div className="h-3 w-full max-w-[120px] animate-pulse rounded bg-zinc-800" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-zinc-800/60 last:border-0",
                    onRowClick && "cursor-pointer hover:bg-zinc-800/40",
                  )}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-3 py-2.5 text-zinc-300", alignCls(c.align), c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!isLoading && rows.length === 0 && (empty ?? <EmptyState title="Belum ada data" />)}
    </div>
  );
}
