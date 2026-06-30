"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Section,
  Badge,
  FormRow,
  SegmentedControl,
  NumberStepper,
  SaveBar,
  EmptyState,
  useAdminQuery,
  useAdminMutation,
  apiFetch,
  type Option,
} from "./ui";

// D7 — per-tier limits matrix. Rows = limit fields, columns = tiers. "Pakai
// default" (blank wire "") = use the marketing-baseline default (saving blank
// deletes the override). Entitlement counts use a sentinel -1 for unlimited;
// media values are MB. Restyled to the dark kit; data layer + wire shapes
// (PUT /api/admin/limits, blank/"-1"/number strings) unchanged.

type FieldName =
  | "maxAgents" | "maxChannels" | "maxSkills"
  | "imageMb" | "audioMb" | "videoMb" | "documentMb" | "filesPerMessage" | "totalMb";

type LimitsData = {
  overrides: Record<string, Partial<Record<FieldName, number>>>;
  defaults: Record<
    string,
    {
      maxAgents: number;
      maxChannels: number;
      maxSkills: number;
      media: { imageMb: number; audioMb: number; videoMb: number; documentMb: number; filesPerMessage: number; totalMb: number };
    }
  >;
};

const TIERS: { id: string; label: string }[] = [
  { id: "starter", label: "Starter" },
  { id: "op_buff", label: "OP Buff" },
  { id: "guild_master", label: "Guild Master" },
];

// Entitlement counts: sentinel -1 = unlimited. Wire string "" = default, "-1" =
// unlimited, "<n>" = explicit number. Server bound min=-1 max=10000.
const ENTITLEMENT_FIELDS: { field: FieldName; label: string; help: string }[] = [
  { field: "maxAgents", label: "Maks agen", help: "Batas berapa agen yang boleh dibuat user tier ini. Unlimited atau 0–10000." },
  { field: "maxChannels", label: "Maks channel/akun", help: "Batas channel/akun per user. Unlimited atau 0–10000." },
  { field: "maxSkills", label: "Maks skill", help: "Batas skill terpasang per user. Unlimited atau 0–10000." },
];

// Media-per-file caps (MB). Server bound min=1 max=4096.
const MEDIA_FILE_FIELDS: { field: FieldName; label: string }[] = [
  { field: "imageMb", label: "Gambar" },
  { field: "audioMb", label: "Audio" },
  { field: "videoMb", label: "Video" },
  { field: "documentMb", label: "Dokumen" },
];

const MEDIA_FILE_MIN = 1;
const MEDIA_FILE_MAX = 4096;
const FILES_PER_MESSAGE_MIN = 1;
const FILES_PER_MESSAGE_MAX = 100;
const TOTAL_MB_MIN = 1;
const TOTAL_MB_MAX = 8192;
const COUNT_MIN = 0;
const COUNT_MAX = 10000;
const UNLIMITED = -1;

type CellMode = "default" | "unlimited" | "number";

function defaultFor(d: LimitsData["defaults"][string], field: FieldName): number {
  if (field === "maxAgents") return d.maxAgents;
  if (field === "maxChannels") return d.maxChannels;
  if (field === "maxSkills") return d.maxSkills;
  return d.media[field];
}

// vals[tier][field] = raw string. "" = no override (use default), "-1" =
// unlimited (entitlement only), "<n>" = explicit number. This is the exact wire
// shape the PUT route consumes, so we keep it as the source of truth.
type Vals = Record<string, Partial<Record<FieldName, string>>>;

function buildVals(initial: LimitsData): Vals {
  const out: Vals = {};
  for (const t of TIERS) {
    const o = initial.overrides[t.id] ?? {};
    out[t.id] = {};
    for (const field of [
      ...ENTITLEMENT_FIELDS.map((r) => r.field),
      ...MEDIA_FILE_FIELDS.map((r) => r.field),
      "filesPerMessage" as const,
      "totalMb" as const,
    ]) {
      const v = o[field];
      out[t.id][field] = v != null ? String(v) : "";
    }
  }
  return out;
}

export function LimitsMatrixForm() {
  const { data, isLoading, error } = useAdminQuery<LimitsData>(
    ["admin", "limits"],
    "/api/admin/limits",
  );

  if (isLoading)
    return (
      <Section title="Batas per tier" desc="Memuat…">
        <div className="text-sm text-zinc-500">Memuat…</div>
      </Section>
    );
  if (error || !data)
    return (
      <Section
        title="Batas per tier"
        desc="Batas maks agen / channel / skill dan ukuran media per pesan, per tier langganan."
      >
        <EmptyState title="Gagal memuat limits" body="Coba muat ulang halaman." />
      </Section>
    );
  return <Matrix initial={data} />;
}

function Matrix({ initial }: { initial: LimitsData }) {
  const [vals, setVals] = useState<Vals>(() => buildVals(initial));
  const initialVals = useMemo(() => buildVals(initial), [initial]);

  const set = (tier: string, field: FieldName, value: string) => {
    setVals((prev) => ({ ...prev, [tier]: { ...prev[tier], [field]: value } }));
  };

  const dirty = useMemo(() => {
    for (const t of TIERS) {
      for (const field of Object.keys(vals[t.id]) as FieldName[]) {
        if ((vals[t.id][field] ?? "") !== (initialVals[t.id][field] ?? "")) return true;
      }
    }
    return false;
  }, [vals, initialVals]);

  const save = useAdminMutation<void, { ok: boolean }>(
    () =>
      apiFetch<{ ok: boolean }>("/api/admin/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limits: Object.fromEntries(
            TIERS.map((t) => [
              t.id,
              Object.fromEntries(
                (Object.keys(vals[t.id]) as FieldName[]).map((field) => [
                  field,
                  vals[t.id][field]?.trim() ?? "",
                ]),
              ),
            ]),
          ),
        }),
      }),
    {
      successMessage:
        "Tersimpan. Entitlement berlaku <=30 detik; media saat provision/restart kontainer.",
      invalidate: [["admin", "limits"]],
    },
  );

  const reset = () => setVals(initialVals);

  return (
    <Section
      title="Batas per tier"
      desc="Batas maks agen / channel / skill (entitlement) dan ukuran media per pesan, per tier langganan. Kosong = pakai default baseline."
    >
      <div className="space-y-5">
        <p className="text-xs leading-relaxed text-zinc-400">
          Kosong = pakai default (Starter dibatasi; OP Buff &amp; Guild Master
          unlimited; trial = seperti OP Buff). Entitlement (agen/channel/skill)
          ditegakkan di engine saat user bikin/pasang. Media berlaku saat
          kontainer provision/restart berikutnya — re-provision dari{" "}
          <Link href="/admin/kontainer" className="text-cyan-400 hover:underline">
            menu Kontainer
          </Link>
          .
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">Entitlement: berlaku &lt;=30 dtk</Badge>
          <Badge tone="warn">Media: berlaku saat provision/restart</Badge>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {TIERS.map((t) => {
            const def = initial.defaults[t.id];
            return (
              <div
                key={t.id}
                className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  {t.label}
                </div>

                <div className="space-y-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                    Entitlement
                  </div>
                  {ENTITLEMENT_FIELDS.map((r) => (
                    <FormRow key={r.field} label={r.label} help={r.help}>
                      <EntitlementCell
                        value={vals[t.id][r.field] ?? ""}
                        onChange={(v) => set(t.id, r.field, v)}
                        defaultValue={defaultFor(def, r.field)}
                      />
                    </FormRow>
                  ))}
                </div>

                <div className="space-y-3 border-t border-zinc-800 pt-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                    Media per file
                  </div>
                  {MEDIA_FILE_FIELDS.map((r) => (
                    <FormRow
                      key={r.field}
                      label={`${r.label} (MB)`}
                      help="Ukuran maks per file untuk tipe ini. 1–4096 MB."
                    >
                      <MediaCell
                        value={vals[t.id][r.field] ?? ""}
                        onChange={(v) => set(t.id, r.field, v)}
                        min={MEDIA_FILE_MIN}
                        max={MEDIA_FILE_MAX}
                        unit="MB"
                        placeholder={defaultFor(def, r.field)}
                      />
                    </FormRow>
                  ))}
                </div>

                <div className="space-y-3 border-t border-zinc-800 pt-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                    Media lain
                  </div>
                  <FormRow label="File / pesan" help="Maks jumlah file per pesan. 1–100.">
                    <MediaCell
                      value={vals[t.id].filesPerMessage ?? ""}
                      onChange={(v) => set(t.id, "filesPerMessage", v)}
                      min={FILES_PER_MESSAGE_MIN}
                      max={FILES_PER_MESSAGE_MAX}
                      unit="file"
                      placeholder={defaultFor(def, "filesPerMessage")}
                    />
                  </FormRow>
                  <FormRow
                    label="Total / pesan (MB)"
                    help="Total ukuran semua file dalam satu pesan. 1–8192 MB."
                  >
                    <MediaCell
                      value={vals[t.id].totalMb ?? ""}
                      onChange={(v) => set(t.id, "totalMb", v)}
                      min={TOTAL_MB_MIN}
                      max={TOTAL_MB_MAX}
                      unit="MB"
                      placeholder={defaultFor(def, "totalMb")}
                    />
                  </FormRow>
                </div>
              </div>
            );
          })}
        </div>

        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onReset={reset}
          message="Ada perubahan belum disimpan. Entitlement berlaku <=30 dtk; media saat provision/restart kontainer."
        />
      </div>
    </Section>
  );
}

// --- Entitlement cell: Default / ∞ Unlimited / Angka. The sentinel -1 maps to
// the ∞ button so an operator never has to remember it; "Angka" reveals a
// 0–10000 stepper. Empty wire "" deletes the override (= baseline default). ---

const ENTITLEMENT_MODE_OPTIONS: Option<CellMode>[] = [
  { value: "default", label: "Default" },
  { value: "unlimited", label: "∞ Unlimited" },
  { value: "number", label: "Angka" },
];

function modeFor(value: string): CellMode {
  if (value === "") return "default";
  if (value === String(UNLIMITED)) return "unlimited";
  return "number";
}

function EntitlementCell({
  value,
  onChange,
  defaultValue,
}: {
  value: string;
  onChange: (v: string) => void;
  defaultValue: number;
}) {
  const mode = modeFor(value);
  // Last explicit number kept in component state so toggling Angka back on
  // restores the operator's prior figure instead of resetting to min.
  const [lastNumber, setLastNumber] = useState<number>(() => {
    const n = Number(value);
    return Number.isFinite(n) && n >= COUNT_MIN ? n : COUNT_MIN;
  });

  const defaultLabel = defaultValue === UNLIMITED ? "∞ unlimited" : String(defaultValue);

  const onMode = (next: CellMode) => {
    if (next === "default") onChange("");
    else if (next === "unlimited") onChange(String(UNLIMITED));
    else onChange(String(lastNumber));
  };

  return (
    <div className="space-y-2">
      <SegmentedControl<CellMode>
        value={mode}
        onChange={onMode}
        options={ENTITLEMENT_MODE_OPTIONS}
        size="sm"
      />
      {mode === "number" ? (
        <NumberStepper
          value={Number(value)}
          onChange={(n) => {
            setLastNumber(n);
            onChange(String(n));
          }}
          min={COUNT_MIN}
          max={COUNT_MAX}
        />
      ) : (
        <p className="text-[11px] text-zinc-500">
          {mode === "default" ? `Default: ${defaultLabel}` : "Tanpa batas"}
        </p>
      )}
    </div>
  );
}

// --- Media cell: Default toggle + stepper. Empty wire "" = use baseline default
// (shown as placeholder/help); ticking "Atur" reveals a clamped stepper. ---

function MediaCell({
  value,
  onChange,
  min,
  max,
  unit,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  unit: string;
  placeholder: number;
}) {
  const isOverride = value !== "";
  // Remember the last explicit value so toggling override back on restores it.
  const [lastNumber, setLastNumber] = useState<number>(() => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : placeholder;
  });

  const onMode = (next: "default" | "override") => {
    if (next === "default") onChange("");
    else onChange(String(lastNumber));
  };

  return (
    <div className="space-y-2">
      <SegmentedControl<"default" | "override">
        value={isOverride ? "override" : "default"}
        onChange={onMode}
        options={[
          { value: "default", label: "Default" },
          { value: "override", label: "Atur" },
        ]}
        size="sm"
      />
      {isOverride ? (
        <NumberStepper
          value={Number(value)}
          onChange={(n) => {
            setLastNumber(n);
            onChange(String(n));
          }}
          min={min}
          max={max}
          unit={unit}
        />
      ) : (
        <p className="text-[11px] text-zinc-500">
          Default: {placeholder} {unit}
        </p>
      )}
    </div>
  );
}
