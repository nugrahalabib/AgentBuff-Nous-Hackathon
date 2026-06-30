"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  errorToBahasa,
  Badge,
  Section,
  FormRow,
  NumberStepper,
  SegmentedControl,
  SaveBar,
  useAdminQuery,
  useAdminMutation,
  useToast,
} from "./ui";

type RuntimeData = {
  overrides: Record<string, { memory?: string; cpus?: string; pids?: number }>;
  trialDurationDays: number;
  defaults: { memory: string; cpus: string; pids: number };
};

const TIERS: { id: string; label: string }[] = [
  { id: "starter", label: "Starter (gratis)" },
  { id: "op_buff", label: "OP Buff" },
  { id: "guild_master", label: "Guild Master" },
];

// Bounds mirror the server (route.ts): memory 256m–65536m (=64g), cpus 0.25–16,
// pids 64–8192, trial 1–90. Widgets clamp so the form cannot send out-of-range.
const MEM_MIN_MB = 256;
const MEM_MAX_MB = 65536;
const CPU_PRESETS = ["0.5", "1", "2", "4", "8"] as const;
const TRIAL_PRESETS = [7, 14, 30];
// Landing copy currently promises a 14-day trial (CLAUDE.md §1.1). Cross-check
// to flag drift; not a hard block.
const LANDING_TRIAL_DAYS = 14;

// --- per-tier cap form state ---
// memUnit / memNum together encode the memory string ("" = use default).
type CapForm = {
  memMode: "default" | "override";
  memUnit: "m" | "g";
  memNum: number;
  cpuMode: "default" | "override";
  cpu: string; // raw value e.g. "1" or "1.5"
  pidMode: "default" | "override";
  pid: number;
};

function parseMemory(raw: string | undefined): { unit: "m" | "g"; num: number } | null {
  if (!raw) return null;
  const m = /^(\d+)(m|g)$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  return { unit: m[2] as "m" | "g", num: Number(m[1]) };
}

function memToMb(unit: "m" | "g", num: number): number {
  return unit === "g" ? num * 1024 : num;
}

function initialCaps(initial: RuntimeData): Record<string, CapForm> {
  const out: Record<string, CapForm> = {};
  for (const t of TIERS) {
    const o = initial.overrides[t.id];
    const parsedMem = parseMemory(o?.memory);
    out[t.id] = {
      memMode: parsedMem ? "override" : "default",
      memUnit: parsedMem?.unit ?? "m",
      memNum: parsedMem?.num ?? 2048,
      cpuMode: o?.cpus != null && o.cpus !== "" ? "override" : "default",
      cpu: o?.cpus ?? "1",
      pidMode: o?.pids != null ? "override" : "default",
      pid: o?.pids ?? 512,
    };
  }
  return out;
}

// Serialize each tier's form into the wire shape the route expects:
// "" means "delete override / use env default".
function capToWire(c: CapForm): { memory: string; cpus: string; pids: string } {
  return {
    memory: c.memMode === "override" ? `${c.memNum}${c.memUnit}` : "",
    cpus: c.cpuMode === "override" ? c.cpu : "",
    pids: c.pidMode === "override" ? String(c.pid) : "",
  };
}

const MODE_OPTIONS = [
  { value: "default", label: "Pakai default" },
  { value: "override", label: "Override" },
] as const;

const UNIT_OPTIONS = [
  { value: "m", label: "MB" },
  { value: "g", label: "GB" },
] as const;

const SECTION_DESC =
  "Batas RAM, CPU, dan proses per tier langganan, plus durasi trial gratis. Batas kontainer berlaku saat provision/restart berikutnya; durasi trial berlaku untuk trial baru.";

export function RuntimeSettingsForm() {
  const { data, isLoading, isError } = useAdminQuery<RuntimeData>(
    ["admin", "runtime-settings"],
    "/api/admin/runtime-settings",
  );

  if (isLoading) {
    return (
      <Section title="Batas kontainer & trial" desc={SECTION_DESC}>
        <p className="text-sm text-zinc-500">Memuat…</p>
      </Section>
    );
  }
  if (isError || !data) {
    return (
      <Section title="Batas kontainer & trial" desc={SECTION_DESC}>
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Gagal memuat pengaturan.
        </div>
      </Section>
    );
  }
  return <RuntimeForm initial={data} />;
}

function RuntimeForm({ initial }: { initial: RuntimeData }) {
  const { toast } = useToast();
  const [caps, setCaps] = useState<Record<string, CapForm>>(() => initialCaps(initial));
  const [trialDays, setTrialDays] = useState<number>(initial.trialDurationDays);
  // Server-reported invalid fields (e.g. "starter.memory") → red cell highlight.
  const [badFields, setBadFields] = useState<Set<string>>(new Set());

  const d = initial.defaults;

  const dirty = useMemo(() => {
    if (trialDays !== initial.trialDurationDays) return true;
    const base = initialCaps(initial);
    return TIERS.some((t) => {
      const a = capToWire(caps[t.id]);
      const b = capToWire(base[t.id]);
      return a.memory !== b.memory || a.cpus !== b.cpus || a.pids !== b.pids;
    });
  }, [caps, trialDays, initial]);

  const setCap = (tier: string, patch: Partial<CapForm>) => {
    setBadFields(new Set());
    setCaps((prev) => ({ ...prev, [tier]: { ...prev[tier], ...patch } }));
  };

  // Own fetch (not apiFetch) so the 400 `fields[]` array survives — apiFetch
  // collapses the body to its `error` string only. URL / method / body shape are
  // byte-for-byte identical to the original contract.
  const save = useAdminMutation<void, { ok: boolean }>(
    () => putRuntimeSettings(caps, trialDays),
    {
      invalidate: [["admin", "runtime-settings"]],
      onSuccess: () => {
        setBadFields(new Set());
        toast(
          "Tersimpan. Knob global berlaku ≤30 detik; batas kontainer berlaku saat provision/restart berikutnya.",
          { tone: "ok" },
        );
      },
      onError: (err) => {
        const fields = err instanceof InvalidValuesError ? err.fields : [];
        if (fields.length) {
          setBadFields(new Set(fields));
          toast(`${fields.length} field perlu diperbaiki — cek sel yang ditandai merah.`, {
            tone: "bad",
          });
        } else {
          toast(errorToBahasa(err), { tone: "bad" });
        }
      },
    },
  );

  const reset = () => {
    setCaps(initialCaps(initial));
    setTrialDays(initial.trialDurationDays);
    setBadFields(new Set());
  };

  const trialDrift = trialDays !== LANDING_TRIAL_DAYS;

  return (
    <Section title="Batas kontainer & trial" desc={SECTION_DESC}>
      <div className="space-y-6">
        <div>
          <div className="text-sm font-medium text-zinc-200">Batas kontainer per tier</div>
          <p className="mt-1 text-xs text-zinc-500">
            RAM, CPU, dan limit proses per tier langganan. Pilih{" "}
            <span className="text-zinc-300">Pakai default</span> untuk ikut env ({d.memory} /{" "}
            {d.cpus} CPU / {d.pids} pids). Berlaku saat kontainer di-provision atau di-restart
            berikutnya — untuk kontainer yang sudah jalan, re-provision dari{" "}
            <Link href="/admin/kontainer" className="text-cyan-400 hover:underline">
              menu Kontainer
            </Link>
            .
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {TIERS.map((t) => (
            <TierCapCard
              key={t.id}
              tierId={t.id}
              label={t.label}
              cap={caps[t.id]}
              defaults={d}
              badFields={badFields}
              onChange={(patch) => setCap(t.id, patch)}
            />
          ))}
        </div>

        <div className="border-t border-zinc-800 pt-5">
          <div className="text-sm font-medium text-zinc-200">Durasi trial</div>
          <p className="mt-1 text-xs text-zinc-500">
            Lama trial gratis (hari) untuk user baru. Berlaku untuk trial yang dibuat SETELAH
            disimpan; trial yang sudah jalan tetap pakai tanggal lamanya.
          </p>
          <div className="mt-3">
            <FormRow
              label="Hari trial (1–90)"
              error={badFields.has("trialDurationDays") ? "Nilai di luar rentang 1–90." : null}
              help="Pilih preset cepat atau atur manual lewat stepper."
            >
              <div className="flex flex-wrap items-center gap-3">
                <NumberStepper
                  value={trialDays}
                  onChange={(v) => {
                    setBadFields(new Set());
                    setTrialDays(v);
                  }}
                  min={1}
                  max={90}
                  step={1}
                  unit="hari"
                  presets={TRIAL_PRESETS}
                />
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                  <Badge tone="muted">Landing: {LANDING_TRIAL_DAYS} hari</Badge>
                </span>
              </div>
            </FormRow>
            {trialDrift && (
              <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                Beda dengan copy landing ({LANDING_TRIAL_DAYS} hari). Pastikan update juga CMS landing
                di{" "}
                <Link href="/admin/konten" className="underline hover:text-amber-200">
                  menu Konten
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onReset={reset}
          message="Ada perubahan batas kontainer / trial belum disimpan."
        />
      </div>
    </Section>
  );
}

// --- per-tier cap card ---

function TierCapCard({
  tierId,
  label,
  cap,
  defaults,
  badFields,
  onChange,
}: {
  tierId: string;
  label: string;
  cap: CapForm;
  defaults: { memory: string; cpus: string; pids: number };
  badFields: Set<string>;
  onChange: (patch: Partial<CapForm>) => void;
}) {
  const memMb = memToMb(cap.memUnit, cap.memNum);
  const memBad = badFields.has(`${tierId}.memory`);
  const cpuBad = badFields.has(`${tierId}.cpus`);
  const pidBad = badFields.has(`${tierId}.pids`);

  // Stepper bounds depend on unit so the widget can't leave the 256m–64g window.
  const memStep = cap.memUnit === "g" ? 1 : 256;
  const memMin = cap.memUnit === "g" ? 1 : MEM_MIN_MB;
  const memMax = cap.memUnit === "g" ? 64 : MEM_MAX_MB;

  const isCpuPreset = (CPU_PRESETS as readonly string[]).includes(cap.cpu);

  return (
    <div className="space-y-4 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</div>

      {/* Memory */}
      <FormRow
        label="Memory"
        error={memBad ? "Memory di luar rentang 256m–64g." : null}
        help={cap.memMode === "default" ? `Default ${defaults.memory}.` : undefined}
      >
        <div className="space-y-2">
          <SegmentedControl
            size="sm"
            value={cap.memMode}
            onChange={(v) => onChange({ memMode: v })}
            options={[...MODE_OPTIONS]}
          />
          {cap.memMode === "override" && (
            <div
              className={cn(
                "space-y-1.5 rounded-md p-1",
                memBad && "ring-1 ring-red-500/50",
              )}
            >
              <div className="flex items-center gap-2">
                <SegmentedControl
                  size="sm"
                  value={cap.memUnit}
                  onChange={(unit) => {
                    // Convert the current value across units so the readout stays sane.
                    const nextNum =
                      unit === "g"
                        ? Math.max(1, Math.round(memMb / 1024))
                        : Math.max(MEM_MIN_MB, memMb);
                    onChange({ memUnit: unit, memNum: nextNum });
                  }}
                  options={[...UNIT_OPTIONS]}
                />
                <NumberStepper
                  value={cap.memNum}
                  onChange={(v) => onChange({ memNum: v })}
                  min={memMin}
                  max={memMax}
                  step={memStep}
                />
              </div>
              <p className="text-[11px] text-zinc-500">
                = {(memMb / 1024).toFixed(memMb % 1024 === 0 ? 0 : 2)} GB ({memMb}m)
              </p>
            </div>
          )}
        </div>
      </FormRow>

      {/* CPU */}
      <FormRow
        label="CPU (core)"
        error={cpuBad ? "CPU di luar rentang 0.25–16." : null}
        help={cap.cpuMode === "default" ? `Default ${defaults.cpus}.` : undefined}
      >
        <div className="space-y-2">
          <SegmentedControl
            size="sm"
            value={cap.cpuMode}
            onChange={(v) => onChange({ cpuMode: v })}
            options={[...MODE_OPTIONS]}
          />
          {cap.cpuMode === "override" && (
            <div className={cn(cpuBad && "rounded-md p-1 ring-1 ring-red-500/50")}>
              <SegmentedControl
                size="sm"
                value={isCpuPreset ? cap.cpu : "custom"}
                onChange={(v) => {
                  if (v === "custom") onChange({ cpu: cap.cpu || "1" });
                  else onChange({ cpu: v });
                }}
                options={[
                  ...CPU_PRESETS.map((p) => ({ value: p, label: p })),
                  { value: "custom", label: "Custom" },
                ]}
              />
              {!isCpuPreset && (
                <div className="mt-1.5">
                  <NumberStepper
                    value={Number(cap.cpu) || 1}
                    onChange={(v) => onChange({ cpu: String(v) })}
                    min={0.25}
                    max={16}
                    step={0.25}
                    unit="core"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </FormRow>

      {/* Proses (pids) */}
      <FormRow
        label="Proses (pids)"
        error={pidBad ? "Pids di luar rentang 64–8192." : null}
        help={
          cap.pidMode === "default"
            ? `Default ${defaults.pids}.`
            : "Batas jumlah proses (anti fork-bomb)."
        }
      >
        <div className="space-y-2">
          <SegmentedControl
            size="sm"
            value={cap.pidMode}
            onChange={(v) => onChange({ pidMode: v })}
            options={[...MODE_OPTIONS]}
          />
          {cap.pidMode === "override" && (
            <div className={cn(pidBad && "rounded-md p-1 ring-1 ring-red-500/50")}>
              <NumberStepper
                value={cap.pid}
                onChange={(v) => onChange({ pid: v })}
                min={64}
                max={8192}
                step={64}
              />
            </div>
          )}
        </div>
      </FormRow>
    </div>
  );
}

// --- data layer ---

// Carries the per-field invalid list from the route's 400 response so the UI can
// paint the offending cells red.
class InvalidValuesError extends Error {
  fields: string[];
  constructor(fields: string[]) {
    super("INVALID_VALUES");
    this.name = "InvalidValuesError";
    this.fields = fields;
  }
}

async function putRuntimeSettings(
  caps: Record<string, CapForm>,
  trialDurationDays: number,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/admin/runtime-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caps: Object.fromEntries(TIERS.map((t) => [t.id, capToWire(caps[t.id])])),
      trialDurationDays,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: unknown };
    if (body.error === "INVALID_VALUES" && Array.isArray(body.fields)) {
      throw new InvalidValuesError(body.fields.filter((x): x is string => typeof x === "string"));
    }
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}
