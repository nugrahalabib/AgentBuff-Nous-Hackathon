"use client";

import { useMemo, useState } from "react";
import { Calculator, Percent, Trash2 } from "lucide-react";
import {
  apiFetch,
  Badge,
  Combobox,
  ConfirmDialog,
  CurrencyField,
  DataTable,
  EmptyState,
  FormRow,
  NumberStepper,
  SaveBar,
  Section,
  SegmentedControl,
  errorToBahasa,
  fmtDateTime,
  useAdminMutation,
  useAdminQuery,
  type Option,
  type Tone,
} from "./ui";

// --- Types mirroring the route responses (do not change the contract) ---

type Scope = "category" | "seller";

type Rule = {
  id: string;
  scope: string;
  scopeId: string;
  pct: number;
  updatedAt: string;
};
type CommissionResp = { global: number; rules: Rule[] };

type SellerRow = { id: string; displayName: string };
type SellersResp = { rows: SellerRow[] };

type ListingRow = { category: string | null };
type ListingsResp = { rows: ListingRow[] };

const DEFAULT_GLOBAL_PCT = 20;
const COMMISSION_KEY = ["admin", "commission"] as const;

const SCOPE_OPTIONS: Option<Scope>[] = [
  { value: "category", label: "Kategori", hint: "Berlaku untuk semua listing di kategori ini" },
  { value: "seller", label: "Seller", hint: "Berlaku untuk satu seller tertentu" },
];

function nowHHmm(): string {
  return new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function CommissionEditor() {
  const commission = useAdminQuery<CommissionResp>(COMMISSION_KEY, "/api/admin/commission-rules");
  const sellers = useAdminQuery<SellersResp>(["admin", "sellers"], "/api/admin/sellers");
  const listings = useAdminQuery<ListingsResp>(["admin", "listings"], "/api/admin/listings");

  if (commission.isLoading) {
    return (
      <Section title="Komisi platform">
        <p className="text-sm text-zinc-500">Memuat…</p>
      </Section>
    );
  }
  if (commission.isError || !commission.data) {
    return (
      <Section title="Komisi platform">
        <EmptyState
          title="Gagal memuat rule komisi"
          body={errorToBahasa(commission.error)}
          action={
            <button
              type="button"
              onClick={() => void commission.refetch()}
              className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
            >
              Coba lagi
            </button>
          }
        />
      </Section>
    );
  }

  return (
    <CommissionPanels
      data={commission.data}
      sellers={sellers.data?.rows ?? []}
      sellersLoading={sellers.isLoading}
      listings={listings.data?.rows ?? []}
      listingsLoading={listings.isLoading}
    />
  );
}

function CommissionPanels({
  data,
  sellers,
  sellersLoading,
  listings,
  listingsLoading,
}: {
  data: CommissionResp;
  sellers: SellerRow[];
  sellersLoading: boolean;
  listings: ListingRow[];
  listingsLoading: boolean;
}) {
  // Resolve seller id -> display name for the rule list + simulator.
  const sellerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sellers) m.set(s.id, s.displayName);
    return m;
  }, [sellers]);

  const sellerOptions: Option[] = useMemo(
    () => sellers.map((s) => ({ value: s.id, label: s.displayName, hint: s.id.slice(0, 8) })),
    [sellers],
  );

  const categoryOptions: Option[] = useMemo(() => {
    const set = new Set<string>();
    for (const l of listings) if (l.category) set.add(l.category);
    return [...set].sort().map((c) => ({ value: c, label: c }));
  }, [listings]);

  const scoped = data.rules.filter((r) => r.scope === "category" || r.scope === "seller");

  return (
    <div className="space-y-4">
      <GlobalDefaultPanel global={data.global} />
      <ScopedRulePanel
        scoped={scoped}
        sellerName={sellerName}
        sellerOptions={sellerOptions}
        sellersLoading={sellersLoading}
        categoryOptions={categoryOptions}
        listingsLoading={listingsLoading}
      />
      <SimulatorPanel
        global={data.global}
        rules={scoped}
        sellerOptions={sellerOptions}
        sellersLoading={sellersLoading}
      />
    </div>
  );
}

// --- Panel 1: global default (NumberStepper + SaveBar) ---

function GlobalDefaultPanel({ global }: { global: number }) {
  const [pct, setPct] = useState(global);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [clampNote, setClampNote] = useState(false);

  const dirty = pct !== global;

  const save = useAdminMutation<number, { ok: boolean; global: number }>(
    (value) =>
      apiPut("/api/admin/commission-rules", { global: value }),
    {
      invalidate: [COMMISSION_KEY],
      successMessage: (d) => `Komisi global disimpan: ${d.global}%`,
      onSuccess: (d) => {
        setSavedAt(nowHHmm());
        setClampNote(d.global !== pct);
        setPct(d.global);
      },
    },
  );

  return (
    <Section
      title="Komisi default global"
      desc="Potongan platform untuk semua penjualan seller 3rd-party yang tidak punya rule khusus."
    >
      <div className="max-w-sm space-y-2">
        <FormRow
          label="Default global"
          help="Berlaku untuk semua penjualan 3rd-party tanpa rule khusus. First-party (house) = 0%."
        >
          <NumberStepper
            value={pct}
            onChange={(v) => {
              setPct(v);
              setClampNote(false);
            }}
            min={0}
            max={100}
            step={1}
            unit="%"
            presets={[10, 15, 20, 25, 30]}
          />
        </FormRow>
        {clampNote && (
          <p className="text-[11px] text-amber-300">Disesuaikan ke maksimum 100%.</p>
        )}
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate(pct)}
          onReset={() => {
            setPct(global);
            setClampNote(false);
          }}
          savedAt={savedAt}
          message={`Komisi global akan jadi ${pct}%.`}
        />
      </div>
    </Section>
  );
}

// --- Panel 2: scoped rules (segmented + combobox + stepper + table) ---

function ScopedRulePanel({
  scoped,
  sellerName,
  sellerOptions,
  sellersLoading,
  categoryOptions,
  listingsLoading,
}: {
  scoped: Rule[];
  sellerName: Map<string, string>;
  sellerOptions: Option[];
  sellersLoading: boolean;
  categoryOptions: Option[];
  listingsLoading: boolean;
}) {
  const [scope, setScope] = useState<Scope>("category");
  const [scopeId, setScopeId] = useState("");
  const [pct, setPct] = useState(20);
  const [toDelete, setToDelete] = useState<Rule | null>(null);

  const upsert = useAdminMutation<{ scope: Scope; scopeId: string; pct: number }, { ok: boolean }>(
    (v) => apiPost("/api/admin/commission-rules", v),
    {
      invalidate: [COMMISSION_KEY],
      successMessage: (_d, v) => `Rule ${labelForTarget(v.scope, v.scopeId, sellerName)} = ${v.pct}%`,
      onSuccess: () => {
        setScopeId("");
        setPct(20);
      },
    },
  );

  const del = useAdminMutation<Rule, { ok: boolean }>(
    (r) =>
      apiDelete(
        `/api/admin/commission-rules?scope=${encodeURIComponent(r.scope)}&scopeId=${encodeURIComponent(r.scopeId)}`,
      ),
    {
      invalidate: [COMMISSION_KEY],
      successMessage: "Rule dihapus. Komisi kembali ke tier berikutnya.",
      onSuccess: () => setToDelete(null),
    },
  );

  const canSubmit = scopeId.trim().length > 0 && !upsert.isPending;
  const targetOptions = scope === "seller" ? sellerOptions : categoryOptions;
  const targetLoading = scope === "seller" ? sellersLoading : listingsLoading;

  const rows = scoped.map((r) => ({
    ...r,
    targetLabel: labelForTarget(r.scope, r.scopeId, sellerName),
  }));

  return (
    <Section
      title="Rule override per-kategori / per-seller"
      desc="Override global untuk kategori atau seller tertentu. Pilih target dari daftar — tidak perlu ketik UUID."
    >
      <div className="space-y-4">
        <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-[auto_1fr_auto_auto] sm:items-end">
          <FormRow label="Cakupan">
            <SegmentedControl<Scope>
              value={scope}
              onChange={(v) => {
                setScope(v);
                setScopeId("");
              }}
              options={SCOPE_OPTIONS}
            />
          </FormRow>

          <FormRow
            label={scope === "seller" ? "Seller" : "Kategori"}
            help="Pilih target rule. Hanya target yang ada yang muncul."
          >
            <Combobox
              value={scopeId}
              onChange={setScopeId}
              options={targetOptions}
              loading={targetLoading}
              placeholder={scope === "seller" ? "Pilih seller…" : "Pilih kategori…"}
              emptyText={scope === "seller" ? "Belum ada seller" : "Belum ada kategori"}
            />
          </FormRow>

          <FormRow label="Komisi">
            <NumberStepper value={pct} onChange={setPct} min={0} max={100} step={1} unit="%" />
          </FormRow>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => upsert.mutate({ scope, scopeId: scopeId.trim(), pct })}
            className="h-9 rounded-md bg-cyan-500 px-4 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-40"
          >
            {upsert.isPending ? "Menyimpan…" : "Tambah / ubah"}
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Percent className="size-8" />}
            title="Belum ada rule khusus"
            body="Semua seller pakai komisi global. Tambahkan override di atas untuk kategori atau seller tertentu."
          />
        ) : (
          <DataTable
            columns={[
              {
                key: "scope",
                header: "Cakupan",
                cell: (r) => (
                  <Badge tone={r.scope === "seller" ? "info" : "muted"}>
                    {r.scope === "seller" ? "Seller" : "Kategori"}
                  </Badge>
                ),
              },
              {
                key: "target",
                header: "Target",
                cell: (r) => <span className="text-zinc-200">{r.targetLabel}</span>,
              },
              {
                key: "pct",
                header: "Komisi",
                align: "right",
                cell: (r) => <span className="tabular-nums text-zinc-100">{r.pct}%</span>,
              },
              {
                key: "updatedAt",
                header: "Diperbarui",
                cell: (r) => <span className="text-xs text-zinc-500">{fmtDateTime(r.updatedAt)}</span>,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (r) => (
                  <button
                    type="button"
                    onClick={() => setToDelete(r)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition hover:border-red-500/40 hover:text-red-400"
                  >
                    <Trash2 className="size-3.5" /> Hapus
                  </button>
                ),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
          />
        )}

        <PrecedenceLegend />
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete)}
        title="Hapus rule komisi?"
        body="Komisi untuk target ini akan kembali ke tier berikutnya dalam urutan precedence."
        danger
        loading={del.isPending}
        confirmLabel="Hapus rule"
        summary={
          toDelete
            ? [
                {
                  label: "Cakupan",
                  value: toDelete.scope === "seller" ? "Seller" : "Kategori",
                },
                { label: "Target", value: labelForTarget(toDelete.scope, toDelete.scopeId, sellerName) },
                { label: "Komisi saat ini", value: `${toDelete.pct}%` },
              ]
            : undefined
        }
      />
    </Section>
  );
}

// --- Panel 3: commission simulator + visual precedence ---

type Tier = "seller-rule" | "category-rule" | "global";

function SimulatorPanel({
  global,
  rules,
  sellerOptions,
  sellersLoading,
}: {
  global: number;
  rules: Rule[];
  sellerOptions: Option[];
  sellersLoading: boolean;
}) {
  const [sellerId, setSellerId] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState<number>(100_000);

  // Resolver mirrors the documented precedence (seller override > seller rule >
  // category rule > global). The portal does not expose seller-row override here,
  // so the simulator covers the rule tiers this editor manages.
  const resolved = useMemo(() => {
    const sellerRule = sellerId ? rules.find((r) => r.scope === "seller" && r.scopeId === sellerId) : undefined;
    if (sellerRule) return { pct: sellerRule.pct, tier: "seller-rule" as Tier };
    const catRule = category ? rules.find((r) => r.scope === "category" && r.scopeId === category) : undefined;
    if (catRule) return { pct: catRule.pct, tier: "category-rule" as Tier };
    return { pct: global, tier: "global" as Tier };
  }, [rules, sellerId, category, global]);

  const platformCut = Math.round((amount * resolved.pct) / 100);
  const sellerNet = amount - platformCut;

  const categoryOptions: Option[] = useMemo(() => {
    const set = new Set<string>();
    for (const r of rules) if (r.scope === "category") set.add(r.scopeId);
    return [...set].sort().map((c) => ({ value: c, label: c }));
  }, [rules]);

  return (
    <Section
      title="Simulator komisi"
      desc="Cek hasil resolver sebelum simpan. Tier yang aktif disorot di urutan precedence."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <FormRow label="Seller" help="Opsional. Kosongkan untuk hitung non-seller-spesifik.">
            <Combobox
              value={sellerId}
              onChange={setSellerId}
              options={sellerOptions}
              loading={sellersLoading}
              placeholder="Pilih seller…"
              emptyText="Belum ada seller"
            />
          </FormRow>
          <FormRow label="Kategori" help="Opsional. Dipakai jika seller tidak punya rule khusus.">
            <Combobox
              value={category}
              onChange={setCategory}
              options={categoryOptions}
              placeholder="Pilih kategori…"
              emptyText="Belum ada rule kategori"
            />
          </FormRow>
          <FormRow label="Nilai penjualan">
            <CurrencyField value={amount} onChange={setAmount} min={0} />
          </FormRow>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400">
              <Calculator className="size-3.5 text-cyan-400" /> Hasil ({resolved.pct}%)
            </div>
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-zinc-500">Nilai penjualan</dt>
                <dd className="tabular-nums font-medium text-zinc-200">{rupiah(amount)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-zinc-500">Platform ambil</dt>
                <dd className="tabular-nums font-medium text-cyan-300">
                  {rupiah(platformCut)} <span className="text-xs text-zinc-500">({resolved.pct}%)</span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-zinc-800 pt-1.5">
                <dt className="text-zinc-500">Seller terima</dt>
                <dd className="tabular-nums font-semibold text-emerald-300">{rupiah(sellerNet)}</dd>
              </div>
            </dl>
          </div>

          <PrecedenceLegend activeTier={resolved.tier} />
        </div>
      </div>
    </Section>
  );
}

// --- Shared: visual precedence chain (optionally highlights the active tier) ---

const PRECEDENCE: { tier: Tier | "seller-override" | "floor"; label: string }[] = [
  { tier: "seller-override", label: "Override seller (tab Seller)" },
  { tier: "seller-rule", label: "Rule seller" },
  { tier: "category-rule", label: "Rule kategori" },
  { tier: "global", label: "Global" },
  { tier: "floor", label: `Default ${DEFAULT_GLOBAL_PCT}%` },
];

function PrecedenceLegend({ activeTier }: { activeTier?: Tier }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Urutan precedence
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRECEDENCE.map((p, i) => {
          const active = activeTier !== undefined && p.tier === activeTier;
          const tone: Tone = active ? "info" : "muted";
          return (
            <span key={p.tier} className="inline-flex items-center gap-1.5">
              <Badge tone={tone}>{p.label}</Badge>
              {i < PRECEDENCE.length - 1 && <span className="text-zinc-600">→</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// --- Helpers ---

function labelForTarget(scope: string, scopeId: string, sellerName: Map<string, string>): string {
  if (scope === "seller") return sellerName.get(scopeId) ?? scopeId;
  return scopeId;
}

function rupiah(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

// Thin JSON helpers over the kit's apiFetch. Kept local so the route contract
// (PUT global / POST upsert / DELETE scoped) is unchanged.
function apiPut<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function apiPost<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function apiDelete<T>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "DELETE" });
}
