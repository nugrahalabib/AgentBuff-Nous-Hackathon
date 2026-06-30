"use client";

/**
 * CronAdvancedFields — optional, collapsible "Pengaturan Lanjutan" block shared
 * by the create wizard + edit drawer. Exposes the engine-honored per-job
 * overrides via PICKERS (not free-text) so mass-market users don't have to know
 * exact skill/toolset names:
 *   - repeat          quick presets + number
 *   - skills          multi-select from the installed skill catalog (token saver)
 *   - enabledToolsets multi-select from the engine toolset catalog
 *   - model           per-job model override (free text — models.list is empty
 *                     for subscription/BYOK providers, so a dropdown would be
 *                     useless; suggestions offered via datalist when available)
 *
 * All optional. Empty = engine defaults.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, X, Check, Sliders, Search } from "lucide-react";
import { useRpc } from "@/lib/app/use-rpc";
import { cn } from "@/lib/utils";

export type CronAdvancedValue = {
  repeat?: number;
  model?: string;
  skills?: string[];
  enabledToolsets?: string[];
};

type Option = { value: string; label: string };

type SkillsStatus = { skills?: Array<{ name?: string; key?: string; title?: string }> } | Array<{ name?: string; key?: string; title?: string }>;
// tools.catalog returns toolsets under `groups` (each {id,label,...}).
type ToolsCatalog = { groups?: Array<{ id?: string; name?: string; label?: string }> };
// models.list returns providers, each with a (often empty) `models` array.
type ModelEntry = { id?: string; name?: string; alias?: string; slug?: string };
type ModelsList =
  | { providers?: Array<{ models?: ModelEntry[] }>; models?: ModelEntry[] }
  | ModelEntry[];

const REPEAT_PRESETS = [1, 3, 5, 10];

export function CronAdvancedFields({
  value,
  onChange,
  defaultOpen = false,
}: {
  value: CronAdvancedValue;
  onChange: (patch: Partial<CronAdvancedValue>) => void;
  defaultOpen?: boolean;
}) {
  // Defer the 3 catalog RPCs until the user actually expands this block —
  // most create/edit flows never touch advanced settings, so firing
  // skills.status + tools.catalog + models.list at mount is wasted load on
  // every open. Once opened we keep `loaded` true so collapsing doesn't refetch.
  const [loaded, setLoaded] = useState(defaultOpen);

  // Skill + toolset catalogs (same RPCs the Agents tab uses).
  const skillsQ = useRpc<SkillsStatus>({
    method: "skills.status",
    params: {},
    enabled: loaded,
  });
  const toolsQ = useRpc<ToolsCatalog, { agentId: string; includePlugins: boolean }>({
    method: "tools.catalog",
    params: { agentId: "default", includePlugins: true },
    enabled: loaded,
  });
  const modelsQ = useRpc<ModelsList>({
    method: "models.list",
    params: {},
    enabled: loaded,
  });

  const skillOptions = useMemo<Option[]>(() => {
    const raw = Array.isArray(skillsQ.data) ? skillsQ.data : skillsQ.data?.skills ?? [];
    return raw
      .map((s) => {
        const v = s.name || s.key || "";
        return v ? { value: v, label: s.title || prettify(v) } : null;
      })
      .filter((x): x is Option => !!x)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [skillsQ.data]);

  const toolsetOptions = useMemo<Option[]>(() => {
    const raw = toolsQ.data?.groups ?? [];
    return raw
      .map((t) => {
        const v = t.id || t.name || "";
        return v ? { value: v, label: t.label || prettify(v) } : null;
      })
      .filter((x): x is Option => !!x)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [toolsQ.data]);

  const modelOptions = useMemo<string[]>(() => {
    const d = modelsQ.data;
    let raw: ModelEntry[] = [];
    if (Array.isArray(d)) raw = d;
    else if (d?.models) raw = d.models;
    else if (d?.providers) raw = d.providers.flatMap((p) => p.models ?? []);
    const out = raw.map((m) => m.id || m.name || m.alias || m.slug || "").filter(Boolean);
    return Array.from(new Set(out)).sort();
  }, [modelsQ.data]);

  const activeCount =
    (value.repeat && value.repeat > 0 ? 1 : 0) +
    (value.model?.trim() ? 1 : 0) +
    (value.skills?.length ? 1 : 0) +
    (value.enabledToolsets?.length ? 1 : 0);

  return (
    <details
      open={defaultOpen}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setLoaded(true);
      }}
      className="group rounded-xl border border-white/10 bg-white/[0.02]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-white/80">
          <Sliders className="size-3.5 text-cyan-300/80" aria-hidden />
          Pengaturan Lanjutan
          <span className="text-[11px] font-normal text-white/40">(opsional)</span>
          {activeCount > 0 ? (
            <span className="rounded-full bg-cyan-400/15 px-1.5 py-0 font-mono text-[9px] font-bold text-cyan-200">
              {activeCount}
            </span>
          ) : null}
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 text-white/40 transition-transform group-open:rotate-90"
        />
      </summary>

      <div className="flex flex-col gap-4 border-t border-white/[0.06] px-3.5 py-3.5">
        {/* Repeat */}
        <Field
          label="Ulangi berapa kali?"
          hint="Rutinitas berhenti otomatis setelah jalan sekian kali. Kosongkan = selamanya."
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <PresetChip active={!value.repeat} onClick={() => onChange({ repeat: undefined })}>
              ∞ Selamanya
            </PresetChip>
            {REPEAT_PRESETS.map((n) => (
              <PresetChip key={n} active={value.repeat === n} onClick={() => onChange({ repeat: n })}>
                {n}×
              </PresetChip>
            ))}
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={value.repeat && !REPEAT_PRESETS.includes(value.repeat) ? value.repeat : ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ repeat: Number.isFinite(n) && n > 0 ? n : undefined });
              }}
              placeholder="lain…"
              className="w-20 rounded-lg border border-white/10 bg-[#0B0E14] px-2.5 py-1.5 text-[12px] text-white/90 outline-none placeholder:text-white/30 focus:border-cyan-400/50"
            />
          </div>
        </Field>

        {/* Skills */}
        <Field
          label="Batasi skill yang dipakai"
          hint="Cuma skill ini yang di-load saat rutinitas jalan — lebih fokus + jauh lebih hemat token. Kosongkan = pakai skill default agent."
        >
          <MultiSelect
            options={skillOptions}
            selected={value.skills ?? []}
            onChange={(skills) => onChange({ skills })}
            placeholder="Pilih skill…"
            loading={skillsQ.loading && !skillsQ.data}
            emptyText="Belum ada skill terpasang."
            searchPlaceholder="Cari skill…"
          />
        </Field>

        {/* Toolsets */}
        <Field
          label="Batasi toolset"
          hint="Kunci rutinitas cuma boleh pakai toolset tertentu. Kosongkan = semua toolset agent."
        >
          <MultiSelect
            options={toolsetOptions}
            selected={value.enabledToolsets ?? []}
            onChange={(enabledToolsets) => onChange({ enabledToolsets })}
            placeholder="Pilih toolset…"
            loading={toolsQ.loading && !toolsQ.data}
            emptyText="Toolset tidak tersedia."
            searchPlaceholder="Cari toolset…"
          />
        </Field>

        {/* Model */}
        <Field
          label="Model khusus"
          hint="Pakai model lain cuma untuk rutinitas ini. Kosongkan = ikut model agent."
        >
          {modelOptions.length > 0 ? (
            <select
              value={value.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
              className="w-full rounded-lg border border-white/10 bg-[#0B0E14] px-3 py-2 text-[13px] text-white/90 outline-none focus:border-cyan-400/50"
            >
              <option value="">Ikut model agent (default)</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={value.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
              placeholder="mis. gpt-5.5 / gemini-2.5-flash"
              className="w-full rounded-lg border border-white/10 bg-[#0B0E14] px-3 py-2 text-[13px] text-white/90 outline-none placeholder:text-white/30 focus:border-cyan-400/50"
            />
          )}
        </Field>
      </div>
    </details>
  );
}

function PresetChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition",
        active
          ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-100"
          : "border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white/85",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-semibold text-white/85">{label}</label>
      {children}
      <p className="text-[11px] leading-snug text-white/40">{hint}</p>
    </div>
  );
}

/** Searchable multi-select dropdown (checkbox list in a popover). */
function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  searchPlaceholder,
  loading,
  emptyText,
}: {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  loading?: boolean;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const filtered = useMemo(
    () =>
      q.trim()
        ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()) || o.value.toLowerCase().includes(q.toLowerCase()))
        : options,
    [options, q],
  );
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div className="relative" ref={ref}>
      {/* Selected chips + trigger */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={placeholder}
        className={cn(
          "flex w-full flex-wrap items-center gap-1.5 rounded-lg border bg-[#0B0E14] px-2.5 py-2 text-left transition",
          open ? "border-cyan-400/50" : "border-white/10 hover:border-white/20",
        )}
      >
        {selected.length === 0 ? (
          <span className="text-[13px] text-white/35">{placeholder}</span>
        ) : (
          selected.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[11px] font-medium text-cyan-100"
            >
              {labelFor(v)}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(v);
                }}
                className="text-cyan-200/70 transition hover:text-white"
                aria-label={`Hapus ${labelFor(v)}`}
              >
                <X className="size-3" />
              </span>
            </span>
          ))
        )}
        <ChevronDown className="ml-auto size-4 shrink-0 text-white/40" aria-hidden />
      </button>

      {/* Popover */}
      {open ? (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0B0E14] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
            <Search className="size-3.5 text-white/35" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-[13px] text-white/90 outline-none placeholder:text-white/30"
            />
            {selected.length > 0 ? (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[11px] text-white/45 hover:text-white/80"
              >
                Kosongkan
              </button>
            ) : null}
          </div>
          <div className="scrollbar-slim max-h-56 overflow-y-auto py-1">
            {loading ? (
              <p className="px-3 py-4 text-center text-[12px] text-white/40">Memuat…</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-white/40">
                {options.length === 0 ? emptyText : "Tidak ada yang cocok."}
              </p>
            ) : (
              filtered.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition hover:bg-white/[0.04]"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        on ? "border-cyan-400 bg-cyan-400 text-[#0B0E14]" : "border-white/20",
                      )}
                    >
                      {on ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className={cn("truncate", on ? "text-white/95" : "text-white/70")}>
                      {o.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function prettify(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
