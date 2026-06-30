"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ListFilter } from "lucide-react";
import {
  apiFetch,
  errorToBahasa,
  EmptyState,
  FormRow,
  MultiSelectChips,
  SaveBar,
  Section,
  useAdminMutation,
  useAdminQuery,
} from "./ui";

// D13 — capability policy editor (opt-in). Four optional lists of skill/tool keys
// to hide or lock in the /app agent picker. Empty = no override (mirror engine,
// the current default). One bare key per entry (brand prefix stripped, e.g.
// "mlops", "blockchain", "browser"). Keys are lowercased + regex-validated to
// match the PUT route schema (/^[\w.\-/]{1,80}$/, max 200 per list).

type Policy = {
  hiddenSkills: string[];
  hiddenToolsets: string[];
  essentialToolsets: string[];
  essentialSkills: string[];
};

const FIELDS = [
  "hiddenSkills",
  "hiddenToolsets",
  "essentialToolsets",
  "essentialSkills",
] as const;
type FieldKey = (typeof FIELDS)[number];

// Matches keyArray in src/app/api/admin/capability-policy/route.ts (don't drift).
const KEY_RE = /^[\w.\-/]{1,80}$/;
const MAX_PER_LIST = 200;

const FIELD_META: Record<FieldKey, { label: string; help: string; placeholder: string }> = {
  hiddenSkills: {
    label: "Sembunyikan skill",
    help: "Skill yang disembunyikan dari picker agen di /app (mis. mlops, blockchain). Ketik key bare lalu Enter.",
    placeholder: "mis. mlops",
  },
  hiddenToolsets: {
    label: "Sembunyikan tool",
    help: "Toolset yang disembunyikan dari picker (mis. browser, debugging).",
    placeholder: "mis. browser",
  },
  essentialToolsets: {
    label: "Kunci-on tool (essential)",
    help: "Toolset yang WAJIB selalu aktif — tak bisa dimatikan user.",
    placeholder: "mis. filesystem",
  },
  essentialSkills: {
    label: "Kunci-on skill (essential)",
    help: "Skill yang WAJIB selalu aktif — tak bisa dimatikan user.",
    placeholder: "mis. memory",
  },
};

// Key normalize: lowercase + trim. Validation gate is KEY_RE.
const normalizeKey = (v: string) => v.trim().toLowerCase();
const isValidKey = (v: string) => KEY_RE.test(normalizeKey(v));

function sameLists(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

export function CapabilityPolicyForm() {
  const { data, isLoading, error, refetch } = useAdminQuery<Policy>(
    ["admin", "capability-policy"],
    "/api/admin/capability-policy",
  );

  if (isLoading) {
    return (
      <Section
        title="Policy kemampuan agen"
        desc="Kurasi skill & tool yang tampil di picker agen /app (opsional)."
      >
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-zinc-800/60" />
          ))}
        </div>
      </Section>
    );
  }

  if (error || !data) {
    return (
      <Section
        title="Policy kemampuan agen"
        desc="Kurasi skill & tool yang tampil di picker agen /app (opsional)."
      >
        <EmptyState
          icon={<AlertTriangle className="size-8" />}
          title="Gagal memuat policy"
          body={error ? errorToBahasa(error) : "Coba muat ulang."}
          action={
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
            >
              Coba lagi
            </button>
          }
        />
      </Section>
    );
  }

  return <Form initial={data} />;
}

function Form({ initial }: { initial: Policy }) {
  const [policy, setPolicy] = useState<Policy>(() => ({
    hiddenSkills: [...initial.hiddenSkills],
    hiddenToolsets: [...initial.hiddenToolsets],
    essentialToolsets: [...initial.essentialToolsets],
    essentialSkills: [...initial.essentialSkills],
  }));

  const dirty = useMemo(
    () => FIELDS.some((f) => !sameLists(policy[f], initial[f])),
    [policy, initial],
  );

  const totalCount = useMemo(
    () => FIELDS.reduce((sum, f) => sum + policy[f].length, 0),
    [policy],
  );

  const save = useAdminMutation<Policy, { ok: boolean }>(
    (vars) =>
      apiFetch<{ ok: boolean }>("/api/admin/capability-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
    {
      successMessage: "Tersimpan. Berlaku saat user membuka /app lagi.",
      invalidate: [["admin", "capability-policy"]],
    },
  );

  const setField = (field: FieldKey) => (next: string[]) => {
    // Dedupe + normalize at the boundary; MultiSelectChips already validated.
    const normalized = [...new Set(next.map(normalizeKey).filter(Boolean))].slice(
      0,
      MAX_PER_LIST,
    );
    setPolicy((p) => ({ ...p, [field]: normalized }));
  };

  const handleSave = () => save.mutate(policy);
  const handleReset = () =>
    setPolicy({
      hiddenSkills: [...initial.hiddenSkills],
      hiddenToolsets: [...initial.hiddenToolsets],
      essentialToolsets: [...initial.essentialToolsets],
      essentialSkills: [...initial.essentialSkills],
    });

  return (
    <Section
      title="Policy kemampuan agen"
      desc="Kurasi skill & tool yang tampil di picker agen /app. Kosong = ikut engine (default)."
    >
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
          <p className="text-[11px] leading-relaxed text-amber-200/90">
            Ini <strong>kurasi tampilan picker</strong>, bukan gerbang keamanan
            keras. Skill/tool yang disembunyikan hilang dari UI, tapi pengguna
            teknis yang memanggil RPC engine langsung di kontainernya sendiri
            tetap bisa mengaktifkannya. Key salah ketik gagal-diam (tak
            menyembunyikan apa pun) — pakai key bare yang persis. Plugin wajib
            (PROTECTED_PLUGINS) dikunci terpisah di level engine.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {FIELDS.map((field) => {
            const meta = FIELD_META[field];
            const list = policy[field];
            return (
              <FormRow
                key={field}
                label={meta.label}
                help={`${meta.help} (${list.length}/${MAX_PER_LIST})`}
              >
                <MultiSelectChips
                  values={list}
                  onChange={setField(field)}
                  placeholder={meta.placeholder}
                  max={MAX_PER_LIST}
                  validate={isValidKey}
                />
              </FormRow>
            );
          })}
        </div>

        {totalCount === 0 && !dirty ? (
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
            <ListFilter className="size-3.5 text-zinc-600" />
            Belum ada override — picker menampilkan semua skill/tool sesuai engine.
          </div>
        ) : null}

        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={handleSave}
          onReset={handleReset}
          message="Ada perubahan policy belum disimpan."
        />
      </div>
    </Section>
  );
}
