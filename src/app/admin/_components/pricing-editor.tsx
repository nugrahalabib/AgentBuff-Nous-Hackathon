"use client";

import { useMemo, useState } from "react";
import { formatRp } from "@/lib/billing/plans";
import {
  apiFetch,
  Section,
  FormRow,
  CurrencyField,
  SegmentedControl,
  Badge,
  EmptyState,
  ConfirmDialog,
  useAdminQuery,
  useAdminMutation,
  useFieldId,
  type Option,
} from "./ui";

// D14 pricing editor. Edits the admin_setting price/status overrides that
// pricing-resolver overlays on the plans.ts catalog — the SAME resolver the
// checkout charge + every price display read, so a save here drives the live
// price with no redeploy. Money-sensitive → a two-step review (before -> after)
// confirms exactly what changes before the write.
//
// PRICE_MAX from pricing-resolver (mirrored client-side for inline validation —
// the server re-validates the same ceiling, this is just the live red-state).
const PRICE_MAX = 100_000_000;

type TierOverride = { monthly?: number; yearly?: number; status?: string };
type TierDefault = {
  monthly: number | null;
  yearly: number | null;
  status: string;
  selfServe: boolean;
};
type PricingData = {
  overrides: Record<string, TierOverride>;
  defaults: Record<string, TierDefault>;
};

const TIERS: { id: string; label: string }[] = [
  { id: "op_buff", label: "OP Buff" },
  { id: "full_managed", label: "Full Managed" },
];

// Status segmented options. "" = default (use catalog status). Editable values
// match EDITABLE_STATUS on the route (live | coming_soon).
const STATUS_OPTIONS: Option[] = [
  { value: "", label: "Default", hint: "Pakai status katalog" },
  { value: "live", label: "Live", hint: "Bisa dibeli sekarang" },
  { value: "coming_soon", label: "Coming soon", hint: "Jeda penjualan / early-access" },
];

function statusLabel(v: string): string {
  return STATUS_OPTIONS.find((o) => o.value === v)?.label ?? (v || "—");
}
function fmtPrice(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : formatRp(n);
}

export function PricingEditor() {
  const { data, isLoading, isError, refetch } = useAdminQuery<PricingData>(
    ["admin", "pricing"],
    "/api/admin/pricing",
  );

  if (isLoading) {
    return (
      <Section title="Harga Plan" desc="Memuat harga…">
        <div className="space-y-3">
          {TIERS.map((t) => (
            <div
              key={t.id}
              className="h-32 animate-pulse rounded-md border border-zinc-800 bg-zinc-900/40"
            />
          ))}
        </div>
      </Section>
    );
  }

  if (isError || !data) {
    return (
      <Section title="Harga Plan">
        <EmptyState
          title="Gagal memuat harga"
          body="Tidak bisa mengambil data harga dari server."
          action={
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 transition hover:border-zinc-600"
            >
              Coba lagi
            </button>
          }
        />
      </Section>
    );
  }

  return <PricingForm initial={data} />;
}

// Per-field form state. monthly/yearly are nullable numbers (null = blank =
// revert override). status "" = use catalog default.
type TierForm = { monthly: number | null; yearly: number | null; status: string };
type Change = { label: string; from: string; to: string };

function buildInitialForm(initial: PricingData): Record<string, TierForm> {
  const out: Record<string, TierForm> = {};
  for (const t of TIERS) {
    const o = initial.overrides[t.id];
    out[t.id] = {
      monthly: o?.monthly ?? null,
      yearly: o?.yearly ?? null,
      status: o?.status ?? "",
    };
  }
  return out;
}

function PricingForm({ initial }: { initial: PricingData }) {
  const [form, setForm] = useState<Record<string, TierForm>>(() => buildInitialForm(initial));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (tier: string, field: keyof TierForm, value: number | null | string) => {
    setSaved(false);
    setForm((p) => ({ ...p, [tier]: { ...p[tier], [field]: value } }));
  };

  // Effective value a field resolves to after save: the override when set, else
  // the catalog default. Drives the before/after review + savings preview.
  const effPrice = (tier: string, field: "monthly" | "yearly"): number | null => {
    const raw = form[tier][field];
    if (raw === null) return initial.defaults[tier]?.[field] ?? null;
    return raw;
  };
  const effStatus = (tier: string): string =>
    form[tier].status === "" ? (initial.defaults[tier]?.status ?? "") : form[tier].status;

  // Months saved by the (effective) yearly vs 12x (effective) monthly. Live
  // preview as the operator types — mirrors plans.ts yearlySavingMonths but over
  // the pending values, not the compiled catalog.
  const savingMonths = (tier: string): number => {
    const m = effPrice(tier, "monthly");
    const y = effPrice(tier, "yearly");
    if (!m || !y) return 0;
    return Math.max(0, Math.round((m * 12 - y) / m));
  };

  // Inline field errors (out of 0..PRICE_MAX). CurrencyField clamps to the
  // range so this is belt-and-suspenders, but we still surface a clear message
  // and gate the review button on it.
  const fieldError = (tier: string, field: "monthly" | "yearly"): string | null => {
    const raw = form[tier][field];
    if (raw === null) return null;
    if (!Number.isInteger(raw) || raw < 0 || raw > PRICE_MAX)
      return "Bilangan bulat 0–100.000.000.";
    return null;
  };
  const hasErrors = TIERS.some(
    (t) => fieldError(t.id, "monthly") || fieldError(t.id, "yearly"),
  );

  const changes: Change[] = useMemo(() => {
    const out: Change[] = [];
    for (const t of TIERS) {
      const d = initial.defaults[t.id];
      const o = initial.overrides[t.id];
      const curMonthly = o?.monthly ?? d?.monthly ?? null;
      const curYearly = o?.yearly ?? d?.yearly ?? null;
      const curStatus = o?.status ?? d?.status ?? "";
      const newMonthly = effPrice(t.id, "monthly");
      const newYearly = effPrice(t.id, "yearly");
      const newStatus = effStatus(t.id);
      if (newMonthly !== curMonthly)
        out.push({ label: `${t.label} — bulanan`, from: fmtPrice(curMonthly), to: fmtPrice(newMonthly) });
      if (newYearly !== curYearly)
        out.push({ label: `${t.label} — tahunan`, from: fmtPrice(curYearly), to: fmtPrice(newYearly) });
      if (newStatus !== curStatus)
        out.push({ label: `${t.label} — status`, from: statusLabel(curStatus), to: statusLabel(newStatus) });
    }
    return out;
    // form drives effPrice/effStatus; initial is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, initial]);

  const dirty = changes.length > 0;

  const save = useAdminMutation<void, { ok: boolean; changed: number }>(
    () =>
      // Contract preserved: PUT /api/admin/pricing with prices keyed by tier.
      // Server treats "" as delete-override; we send "" when the field is blank.
      apiFetch<{ ok: boolean; changed: number }>("/api/admin/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prices: Object.fromEntries(
            TIERS.map((t) => [
              t.id,
              {
                monthly: form[t.id].monthly === null ? "" : String(form[t.id].monthly),
                yearly: form[t.id].yearly === null ? "" : String(form[t.id].yearly),
                status: form[t.id].status,
              },
            ]),
          ),
        }),
      }),
    {
      successMessage: (d) =>
        d.changed > 0
          ? "Tersimpan. Harga baru berlaku di checkout + tampilan ≤30 detik."
          : "Tidak ada perubahan untuk disimpan.",
      invalidate: [["admin", "pricing"]],
      onSuccess: () => {
        setSaved(true);
        setConfirmOpen(false);
      },
    },
  );

  return (
    <Section
      title="Harga Plan"
      desc="Override harga & status jual untuk OP Buff dan Full Managed. Perubahan langsung dipakai checkout + tampilan harga (≤30 detik), tanpa deploy."
    >
      <p className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs leading-relaxed text-zinc-400">
        Kosongkan field harga untuk pakai default katalog. <strong className="text-zinc-200">Live</strong> = bisa
        dibeli; <strong className="text-zinc-200">Coming soon</strong> = jeda penjualan / early-access. Starter (gratis)
        dan Guild Master (enterprise, lewat Spead) tidak punya harga self-serve, jadi tidak diedit di sini.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {TIERS.map((t) => (
          <TierCard
            key={t.id}
            tier={t}
            form={form[t.id]}
            def={initial.defaults[t.id]}
            monthlyError={fieldError(t.id, "monthly")}
            yearlyError={fieldError(t.id, "yearly")}
            savingMonths={savingMonths(t.id)}
            onChange={(field, value) => set(t.id, field, value)}
          />
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!dirty || hasErrors}
          title={hasErrors ? "Perbaiki field bertanda merah dulu." : undefined}
          onClick={() => {
            setSaved(false);
            setConfirmOpen(true);
          }}
          className="rounded-md border border-zinc-700 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Tinjau perubahan
        </button>
        {dirty ? (
          <span className="text-xs text-amber-300">
            {changes.length} perubahan belum disimpan — wajib ditinjau sebelum simpan.
          </span>
        ) : saved ? (
          <span className="text-xs text-emerald-400">
            Tersimpan. Harga baru berlaku di checkout + tampilan ≤30 detik.
          </span>
        ) : (
          <span className="text-xs text-zinc-500">Belum ada perubahan.</span>
        )}
      </div>

      {/* Before→after review — explicit confirm before the money-affecting write. */}
      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => save.mutate()}
        loading={save.isPending}
        title="Konfirmasi perubahan harga"
        confirmLabel="Konfirmasi simpan"
        body={
          changes.length === 0 ? (
            "Tidak ada perubahan untuk disimpan."
          ) : (
            <>
              Layar paling sensitif uang di admin. Perubahan ini langsung dipakai checkout + tampilan harga (≤30
              detik). Pastikan nilai di bawah benar.
            </>
          )
        }
        summary={changes.map((c) => ({
          label: c.label,
          value: (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-zinc-500 line-through">{c.from}</span>
              <span className="text-zinc-500">→</span>
              <span className="font-semibold text-emerald-300">{c.to}</span>
            </span>
          ),
        }))}
      />
    </Section>
  );
}

function TierCard({
  tier,
  form,
  def,
  monthlyError,
  yearlyError,
  savingMonths,
  onChange,
}: {
  tier: { id: string; label: string };
  form: TierForm;
  def: TierDefault | undefined;
  monthlyError: string | null;
  yearlyError: string | null;
  savingMonths: number;
  onChange: (field: keyof TierForm, value: number | null | string) => void;
}) {
  const monthlyId = useFieldId();
  const yearlyId = useFieldId();
  const statusId = useFieldId();

  return (
    <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{tier.label}</div>
        {!def?.selfServe && <Badge tone="muted">dikunci katalog</Badge>}
      </div>

      <FormRow
        label="Bulanan (Rp)"
        htmlFor={monthlyId}
        error={monthlyError}
        help={`Default katalog: ${fmtPrice(def?.monthly)}. Kosongkan = pakai default.`}
      >
        <PriceField id={monthlyId} value={form.monthly} onChange={(v) => onChange("monthly", v)} />
      </FormRow>

      <FormRow
        label="Tahunan (Rp)"
        htmlFor={yearlyId}
        error={yearlyError}
        help={
          savingMonths > 0
            ? `Default: ${fmtPrice(def?.yearly)}. 💡 Hemat ${savingMonths} bulan vs 12× bulanan.`
            : `Default: ${fmtPrice(def?.yearly)}. Kosongkan = pakai default.`
        }
      >
        <PriceField id={yearlyId} value={form.yearly} onChange={(v) => onChange("yearly", v)} />
      </FormRow>

      {/* Status is a self-serve-only lever (pause/resume sales). A non-self-serve
          tier (Full Managed) has no coherent "live" yet — promoting it needs
          backend work beyond D14 — so we show its catalog status read-only. */}
      {def?.selfServe ? (
        <FormRow
          label="Status"
          htmlFor={statusId}
          help="Live = bisa dibeli sekarang · Coming soon = jeda penjualan / early-access."
        >
          <div id={statusId}>
            <SegmentedControl
              size="sm"
              value={form.status}
              onChange={(v) => onChange("status", v)}
              options={STATUS_OPTIONS}
            />
          </div>
        </FormRow>
      ) : (
        <FormRow
          label="Status"
          help="Dikunci karena Full Managed belum self-serve — menjadikannya 'Live' perlu kerja backend, bukan tombol di sini."
        >
          <div className="flex items-center gap-2">
            <Badge tone={def?.status === "live" ? "ok" : "warn"}>{statusLabel(def?.status ?? "")}</Badge>
            <span className="text-[11px] text-zinc-500">(dikelola katalog)</span>
          </div>
        </FormRow>
      )}
    </div>
  );
}

// A nullable currency field: a "Default" reset chip clears the override (null),
// CurrencyField owns the Rp formatting + thousands separators + ceiling.
function PriceField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <CurrencyField id={id} value={value} onChange={(v) => onChange(v)} max={PRICE_MAX} min={0} />
      </div>
      {value !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          title="Kosongkan — pakai default katalog"
        >
          Default
        </button>
      )}
    </div>
  );
}
