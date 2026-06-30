"use client";

import { useState } from "react";
import { ExternalLink, FileText, Layers, Trash2 } from "lucide-react";
import { CMS_BLOCKS, type CmsBlock } from "@/lib/cms/blocks";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  FormRow,
  NumberStepper,
  Section,
  SegmentedControl,
  type Option,
  useAdminMutation,
  useAdminQuery,
} from "./ui";

// D8 landing-CMS editor. Edits the cms_content overrides that I18nProvider
// merges over the hardcoded i18n dictionary — every landing component reading
// t.* picks up a publish with no code change. Per-block: save draft, publish,
// or reset to the compiled-in default. Edits are landing COPY only (no money/
// auth surface); writes are admin-gated + zod-validated server-side.

const TEXTAREA =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30";
const INPUT = TEXTAREA;
const RATING_MIN = 1;
const RATING_MAX = 5;

type Locale = "id" | "en";
type ListRow = {
  key: string;
  locale: string;
  hasPublished: boolean;
  hasDraft: boolean;
};
type BlockData = {
  key: string;
  locale: string;
  value: unknown;
  draft: unknown;
  defaultValue: unknown;
};

type Row = Record<string, string>;

const LOCALE_OPTIONS: Option<Locale>[] = [
  { value: "id", label: "ID" },
  { value: "en", label: "EN" },
];

// Per-key char caps mirroring src/lib/cms/blocks.ts (zod maxes). Presentation
// only — the server schema stays authoritative. Used to render live counters.
const SCALAR_MAX: Record<string, number> = {
  "hero.badge": 120,
  "hero.titleLine1": 200,
  "hero.titleLine3": 200,
  "hero.titleLine4": 200,
  "hero.subtitle": 600,
  "hero.ctaPrimary": 80,
  "hero.ctaSecondary": 80,
  "modelMarquee.title": 120,
  "modelMarquee.highlight": 120,
};
// Per-array-field caps (blocks.ts FAQ_ITEM / REVIEW_ITEM zod maxes).
const FIELD_MAX: Record<string, Record<string, number>> = {
  "faq.items": { question: 2000, answer: 4000 },
  "wallOfFame.reviews": {
    name: 120,
    role: 200,
    quote: 2000,
    buff: 120,
    metric: 120,
    metricLabel: 200,
  },
};

// Friendly one-liners for the whole-node JSON blocks (plan 2B picker copy).
const JSON_DESC: Record<string, string> = {
  "hero.rotatingRoles": "14 persona berputar",
  statusPanel: "Kartu Debuff <-> Buff",
  skillTree: "Grid 8 agen",
  customAgent: "Langkah Daftar -> Pilih -> Pakai",
  vsComparison: "Hard Mode vs OP Mode",
  itemShop: "Kartu harga (Starter / OP Buff / Guild)",
  footer: "Tautan & sosial footer",
};

/** Initial form value: draft > published > hardcoded default. Arrays become
 *  string-field rows for editing; scalars become a string. */
function toForm(block: CmsBlock, d: BlockData): string | Row[] {
  const base = d.draft ?? d.value ?? d.defaultValue;
  if (block.kind === "scalar") return typeof base === "string" ? base : "";
  if (block.kind === "json") return JSON.stringify(base ?? null, null, 2);
  const arr = Array.isArray(base) ? base : [];
  return arr.map((item) => {
    // __id = stable React key so deleting/reordering rows doesn't reattach
    // controlled inputs to the wrong row (focus loss). Stripped on submit by
    // toPayload (it only emits itemFields).
    const row: Row = { __id: crypto.randomUUID() };
    for (const f of block.itemFields ?? [])
      row[f.name] = String((item as Record<string, unknown>)?.[f.name] ?? "");
    return row;
  });
}

/** Build the typed payload to send: scalars as-is, array number fields coerced. */
function toPayload(block: CmsBlock, form: string | Row[]): unknown {
  if (block.kind === "scalar") return form;
  if (block.kind === "json") return JSON.parse(form as string); // may throw — caller catches
  return (form as Row[]).map((row) => {
    const out: Record<string, unknown> = {};
    for (const f of block.itemFields ?? [])
      out[f.name] = f.kind === "number" ? Number(row[f.name] || 0) : row[f.name];
    return out;
  });
}

function emptyRow(block: CmsBlock): Row {
  const row: Row = { __id: crypto.randomUUID() };
  for (const f of block.itemFields ?? []) row[f.name] = "";
  return row;
}

function rowHasContent(row: Row): boolean {
  return Object.entries(row).some(([k, v]) => k !== "__id" && v.trim() !== "");
}

export function CmsBrowser() {
  const [locale, setLocale] = useState<Locale>("id");
  const [selected, setSelected] = useState<string>(CMS_BLOCKS[0]?.key ?? "");

  const list = useAdminQuery<{ rows: ListRow[] }>(["admin", "cms"], "/api/admin/cms");

  const stateFor = (key: string): ListRow | undefined =>
    list.data?.rows.find((r) => r.key === key && r.locale === locale);
  // Override exists in ID but not in EN, while we're viewing EN -> flag parity.
  const enMissing = (key: string): boolean => {
    if (locale !== "en") return false;
    const en = list.data?.rows.find((r) => r.key === key && r.locale === "en");
    const idRow = list.data?.rows.find((r) => r.key === key && r.locale === "id");
    const idHas = Boolean(idRow?.hasPublished || idRow?.hasDraft);
    const enHas = Boolean(en?.hasPublished || en?.hasDraft);
    return idHas && !enHas;
  };

  // Group blocks by section for the picker.
  const sections = Array.from(new Set(CMS_BLOCKS.map((b) => b.section)));

  return (
    <Section
      title="Landing CMS"
      desc="Ubah teks landing (hero, FAQ, testimoni, kartu) tanpa deploy. Simpan draft dulu, lalu publikasikan."
      actions={
        <button
          type="button"
          onClick={() =>
            window.open(`/?cmsPreview=${Date.now()}`, "_blank", "noopener")
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          Lihat landing live <ExternalLink className="size-3" />
        </button>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-zinc-500">Bahasa:</span>
        <SegmentedControl<Locale>
          value={locale}
          onChange={setLocale}
          options={LOCALE_OPTIONS}
          size="sm"
        />
        <span className="text-[11px] text-zinc-600">
          Edit per bahasa. Jangan lupa isi EN juga kalau ID sudah diubah.
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        {/* Picker */}
        <div className="space-y-3">
          {sections.map((section) => (
            <div key={section}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {section}
              </div>
              <div className="space-y-0.5">
                {CMS_BLOCKS.filter((b) => b.section === section).map((b) => {
                  const st = stateFor(b.key);
                  const desc = JSON_DESC[b.key];
                  const active = selected === b.key;
                  return (
                    <button
                      key={b.key}
                      type="button"
                      onClick={() => setSelected(b.key)}
                      className={`flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition ${
                        active
                          ? "bg-zinc-800 text-zinc-100"
                          : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{b.label}</span>
                        {desc && (
                          <span className="block truncate text-[11px] text-zinc-500">
                            {desc}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        {st?.hasDraft ? (
                          <Badge tone="warn">draft</Badge>
                        ) : st?.hasPublished ? (
                          <Badge tone="ok">live</Badge>
                        ) : null}
                        {enMissing(b.key) && <Badge tone="info">EN kosong</Badge>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Editor */}
        <BlockPanel
          key={`${selected}:${locale}`}
          blockKey={selected}
          locale={locale}
        />
      </div>
    </Section>
  );
}

function BlockPanel({ blockKey, locale }: { blockKey: string; locale: Locale }) {
  const block = CMS_BLOCKS.find((b) => b.key === blockKey);
  const q = useAdminQuery<BlockData>(
    ["admin", "cms", blockKey, locale],
    `/api/admin/cms/${blockKey}?locale=${locale}`,
    { enabled: Boolean(block) },
  );

  const mutate = useAdminMutation<{
    draft?: unknown;
    publish?: boolean;
    reset?: boolean;
  }>(
    (body) =>
      apiPut(`/api/admin/cms/${blockKey}?locale=${locale}`, body),
    {
      successMessage: (_d, vars) =>
        vars.reset
          ? "Blok dikembalikan ke teks bawaan."
          : vars.publish
            ? "Dipublikasikan. Tampil di landing <=30 detik."
            : "Tersimpan sebagai draft (belum tampil di landing).",
      invalidate: [
        ["admin", "cms"],
        ["admin", "cms", blockKey, locale],
      ],
    },
  );

  if (!block)
    return (
      <EmptyState
        icon={<Layers className="size-8" />}
        title="Pilih blok untuk diedit"
        body="Pilih salah satu blok di daftar kiri."
      />
    );
  if (q.isLoading)
    return <div className="text-sm text-zinc-500">Memuat…</div>;
  if (q.isError || !q.data)
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        <p>Gagal memuat blok.</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="mt-2 rounded-md border border-red-500/40 px-2.5 py-1 text-xs text-red-200 hover:bg-red-500/10"
        >
          Coba lagi
        </button>
      </div>
    );

  return (
    <BlockForm
      key={`${blockKey}:${locale}:${q.dataUpdatedAt}`}
      block={block}
      locale={locale}
      data={q.data}
      pending={mutate.isPending}
      onSaveDraft={(payload) => mutate.mutate({ draft: payload })}
      onPublish={(payload) => mutate.mutate({ draft: payload, publish: true })}
      onReset={() => mutate.mutate({ reset: true })}
    />
  );
}

async function apiPut(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      detail = b.error || detail;
    } catch {
      /* keep code */
    }
    throw new Error(detail);
  }
  return res.json();
}

function BlockForm({
  block,
  locale,
  data,
  pending,
  onSaveDraft,
  onPublish,
  onReset,
}: {
  block: CmsBlock;
  locale: Locale;
  data: BlockData;
  pending: boolean;
  onSaveDraft: (payload: unknown) => void;
  onPublish: (payload: unknown) => void;
  onReset: () => void;
}) {
  const [form, setForm] = useState<string | Row[]>(() => toForm(block, data));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingDeleteRow, setPendingDeleteRow] = useState<number | null>(null);

  // Build the payload (json parse may throw) then run the action; surface a parse
  // error inline instead of sending broken JSON.
  const buildPayload = (): { ok: true; payload: unknown } | { ok: false } => {
    try {
      setJsonError(null);
      return { ok: true, payload: toPayload(block, form) };
    } catch {
      setJsonError("JSON tidak valid — perbaiki dulu sebelum disimpan.");
      return { ok: false };
    }
  };

  const doSaveDraft = () => {
    const r = buildPayload();
    if (!r.ok) return;
    setDirty(false);
    onSaveDraft(r.payload);
  };
  const doPublish = () => {
    const r = buildPayload();
    if (!r.ok) return;
    setConfirmPublish(false);
    setDirty(false);
    onPublish(r.payload);
  };

  const setScalar = (v: string) => {
    setForm(v);
    setDirty(true);
  };
  const setCell = (i: number, name: string, v: string) => {
    setForm((prev) =>
      (prev as Row[]).map((row, idx) =>
        idx === i ? { ...row, [name]: v } : row,
      ),
    );
    setDirty(true);
  };
  const addRow = () => {
    setForm((prev) => [...(prev as Row[]), emptyRow(block)]);
    setDirty(true);
  };
  const removeRow = (i: number) => {
    setForm((prev) => (prev as Row[]).filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const requestRemoveRow = (i: number, row: Row) => {
    if (rowHasContent(row)) setPendingDeleteRow(i);
    else removeRow(i);
  };

  const rows = block.kind === "array" ? (form as Row[]) : [];
  const cap = block.cap ?? 0;
  const atCap = block.cap != null && rows.length >= block.cap;
  const hasCandidate =
    block.kind === "scalar"
      ? (form as string).trim().length > 0
      : block.kind === "json"
        ? (form as string).trim().length > 0
        : rows.length > 0;

  const statusBadge =
    data.draft != null ? (
      <Badge tone="warn">draft belum dipublikasikan</Badge>
    ) : data.value != null ? (
      <Badge tone="ok">live</Badge>
    ) : (
      <Badge tone="muted">default</Badge>
    );

  return (
    <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          {block.label}
          {dirty && (
            <span className="text-[11px] font-normal text-amber-400">
              • belum disimpan
            </span>
          )}
        </div>
        {statusBadge}
      </div>

      {block.kind === "json" ? (
        <JsonEditor
          value={form as string}
          error={jsonError}
          defaultValue={data.defaultValue}
          onChange={(v) => {
            setForm(v);
            setJsonError(null);
            setDirty(true);
          }}
        />
      ) : block.kind === "scalar" ? (
        <ScalarEditor
          block={block}
          value={form as string}
          onChange={setScalar}
        />
      ) : (
        <ArrayEditor
          block={block}
          rows={rows}
          cap={cap}
          atCap={atCap}
          onCell={setCell}
          onAdd={addRow}
          onRemove={requestRemoveRow}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
        <button
          type="button"
          disabled={pending}
          onClick={doSaveDraft}
          className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 transition hover:border-zinc-600 disabled:opacity-50"
        >
          Simpan draft
        </button>
        <button
          type="button"
          disabled={pending || !hasCandidate}
          title={!hasCandidate ? "Tidak ada isi untuk dipublikasikan" : undefined}
          onClick={() => {
            const r = buildPayload();
            if (r.ok) setConfirmPublish(true);
          }}
          className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
        >
          {pending ? "Menyimpan…" : "Publikasikan"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmReset(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
        >
          <Trash2 className="size-3" /> Reset ke default
        </button>
      </div>

      {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}

      <ConfirmDialog
        open={confirmPublish}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={doPublish}
        title="Publikasikan blok ini?"
        body="Setelah publish, perubahan tampil di landing dalam <=30 detik."
        confirmLabel="Publikasikan"
        loading={pending}
        summary={[
          { label: "Blok", value: block.label },
          { label: "Bahasa", value: locale.toUpperCase() },
        ]}
      />

      <ConfirmDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          setDirty(false);
          onReset();
        }}
        title="Hapus override blok ini?"
        body={`Landing kembali ke teks bawaan untuk "${block.label}" (${locale.toUpperCase()}). Draft & versi live blok ini hilang permanen. Tidak bisa dibatalkan.`}
        confirmLabel="Hapus override"
        danger
        loading={pending}
        typeToConfirm="RESET"
      />

      <ConfirmDialog
        open={pendingDeleteRow != null}
        onCancel={() => setPendingDeleteRow(null)}
        onConfirm={() => {
          if (pendingDeleteRow != null) removeRow(pendingDeleteRow);
          setPendingDeleteRow(null);
        }}
        title="Hapus item ini?"
        body="Item ini punya isi. Yakin mau dihapus dari daftar?"
        confirmLabel="Hapus item"
        danger
      />
    </div>
  );
}

function CharCounter({ value, max }: { value: string; max: number }) {
  const len = value.length;
  const over = len > max;
  const near = len >= max * 0.9;
  return (
    <span
      className={`text-[11px] tabular-nums ${
        over ? "text-red-400" : near ? "text-amber-400" : "text-zinc-600"
      }`}
    >
      {len}/{max}
    </span>
  );
}

function ScalarEditor({
  block,
  value,
  onChange,
}: {
  block: CmsBlock;
  value: string;
  onChange: (v: string) => void;
}) {
  const max = SCALAR_MAX[block.key];
  return (
    <div className="space-y-1">
      {block.multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={TEXTAREA}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">
          Teks tidak boleh kosong.{max ? ` Maks ${max} karakter.` : ""}
        </p>
        {max && <CharCounter value={value} max={max} />}
      </div>
    </div>
  );
}

function ArrayEditor({
  block,
  rows,
  cap,
  atCap,
  onCell,
  onAdd,
  onRemove,
}: {
  block: CmsBlock;
  rows: Row[];
  cap: number;
  atCap: boolean;
  onCell: (i: number, name: string, v: string) => void;
  onAdd: () => void;
  onRemove: (i: number, row: Row) => void;
}) {
  const fieldMax = FIELD_MAX[block.key] ?? {};
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          {cap > 0
            ? `${rows.length}/${cap} item — sisa ${Math.max(0, cap - rows.length)}`
            : `${rows.length} item`}
        </span>
        <span>Maks {cap} item (sesuai slot desain landing).</span>
      </div>

      {rows.length === 0 && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-4 text-center text-xs text-zinc-500">
          Belum ada item. Tambahkan minimal satu sebelum publish.
        </p>
      )}

      {rows.map((row, i) => (
        <div
          key={row.__id ?? i}
          className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-500">#{i + 1}</span>
            <button
              type="button"
              onClick={() => onRemove(i, row)}
              className="inline-flex items-center gap-1 text-[11px] text-red-400 transition hover:text-red-300"
            >
              <Trash2 className="size-3" /> Hapus
            </button>
          </div>
          {(block.itemFields ?? []).map((f) => {
            const cur = row[f.name] ?? "";
            if (f.kind === "number") {
              const n = Number(cur || RATING_MIN);
              return (
                <FormRow
                  key={f.name}
                  label={f.label}
                  help={`Pilih ${RATING_MIN} sampai ${RATING_MAX} bintang.`}
                >
                  <NumberStepper
                    value={Number.isNaN(n) ? RATING_MIN : n}
                    onChange={(v) => onCell(i, f.name, String(v))}
                    min={RATING_MIN}
                    max={RATING_MAX}
                  />
                </FormRow>
              );
            }
            const fmax = fieldMax[f.name];
            return (
              <FormRow key={f.name} label={f.label}>
                <div className="space-y-1">
                  {f.kind === "textarea" ? (
                    <textarea
                      value={cur}
                      onChange={(e) => onCell(i, f.name, e.target.value)}
                      rows={2}
                      className={TEXTAREA}
                    />
                  ) : (
                    <input
                      value={cur}
                      onChange={(e) => onCell(i, f.name, e.target.value)}
                      className={INPUT}
                    />
                  )}
                  {fmax && (
                    <div className="flex justify-end">
                      <CharCounter value={cur} max={fmax} />
                    </div>
                  )}
                </div>
              </FormRow>
            );
          })}
        </div>
      ))}

      <button
        type="button"
        disabled={atCap}
        onClick={onAdd}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 disabled:opacity-40"
      >
        {atCap ? `Maks ${cap} item` : "+ Tambah item"}
      </button>
    </div>
  );
}

function JsonEditor({
  value,
  error,
  defaultValue,
  onChange,
}: {
  value: string;
  error: string | null;
  defaultValue: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">
          Edit blok ini lewat JSON. Strukturnya harus sama dengan default (key &
          tipe sama).
        </p>
        <button
          type="button"
          onClick={() => onChange(JSON.stringify(defaultValue ?? null, null, 2))}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
        >
          <FileText className="size-3" /> Muat dari default
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={18}
        spellCheck={false}
        className={`${TEXTAREA} font-mono text-xs ${
          error ? "border-red-500/50" : ""
        }`}
      />
      <p className="text-[11px] text-zinc-500">
        &ldquo;Reset ke default&rdquo; menghapus override dan mengembalikan teks
        bawaan kode.
      </p>
    </div>
  );
}
