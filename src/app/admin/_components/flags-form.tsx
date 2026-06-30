"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import {
  Section,
  StatusBadge,
  Toggle,
  FormRow,
  SaveBar,
  ConfirmDialog,
  EmptyState,
  RoleGate,
  useAdminQuery,
  useAdminMutation,
  apiFetch,
  type StatusMap,
} from "./ui";

// D13 feature/dev flags editor. Toggles the runtime switches read by resolveFlag.
// First consumer: maintenance.enabled gates /app for non-staff (admin/support
// bypass; admin reaches /admin regardless, so no lockout). Keys are constrained
// server-side to FLAG_CATALOG; write = admin only (GET = admin/support).

type FlagDef = {
  key: string;
  label: string;
  description: string;
  hasValue?: boolean;
  valueLabel?: string;
};
type FlagState = { enabled: boolean; value: unknown };
type FlagsData = {
  catalog: FlagDef[];
  flags: Record<string, FlagState>;
};

const FLAGS_KEY = ["admin", "flags"] as const;
const VALUE_MAX = 2000;

// Per-flag impact copy so an operator sees what flipping the switch actually
// does, beyond the generic catalog description from the server.
const FLAG_IMPACT: Record<string, string> = {
  "maintenance.enabled": "Kunci /app untuk SEMUA user non-staff sampai dimatikan.",
  "signups.disabled": "Tolak semua pendaftaran baru.",
};

const STATUS_MAP: StatusMap = {
  on: { tone: "ok", label: "Aktif", hint: "Flag menyala" },
  off: { tone: "muted", label: "Mati", hint: "Flag tidak aktif" },
};

export function FlagsForm({ role = "admin" }: { role?: string }) {
  const { data, isLoading, error, refetch } = useAdminQuery<FlagsData>(
    FLAGS_KEY,
    "/api/admin/flags",
  );

  return (
    <Section
      title="Feature Flags"
      desc="Saklar runtime global (maintenance, pendaftaran). Perubahan berlaku <=30 detik."
    >
      {isLoading ? (
        <p className="text-sm text-zinc-500">Memuat…</p>
      ) : error || !data ? (
        <EmptyState
          icon={<Flag className="size-8" />}
          title="Gagal memuat flags"
          body="Tidak bisa mengambil daftar feature flag dari server."
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
      ) : data.catalog.length === 0 ? (
        <EmptyState
          icon={<Flag className="size-8" />}
          title="Belum ada flag"
          body="Tidak ada feature flag terdaftar di katalog."
        />
      ) : (
        <div className="space-y-3">
          {data.catalog.map((def) => (
            <FlagRow
              key={def.key}
              def={def}
              initial={data.flags[def.key] ?? { enabled: false, value: null }}
              role={role}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function FlagRow({
  def,
  initial,
  role,
}: {
  def: FlagDef;
  initial: FlagState;
  role: string;
}) {
  const initialEnabled = initial.enabled;
  const initialValue = typeof initial.value === "string" ? initial.value : "";

  const [enabled, setEnabled] = useState(initialEnabled);
  const [value, setValue] = useState(initialValue);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const dirty =
    enabled !== initialEnabled || Boolean(def.hasValue && value !== initialValue);
  const impact = FLAG_IMPACT[def.key];

  const save = useAdminMutation<{ enabled: boolean; value: string | null }>(
    (vars) =>
      apiFetch<{ ok: boolean }>("/api/admin/flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: def.key, enabled: vars.enabled, value: vars.value }),
      }),
    {
      successMessage: "Tersimpan. Berlaku <=30 detik.",
      invalidate: [FLAGS_KEY],
      onSuccess: () => {
        setSavedAt(new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }));
      },
    },
  );

  const persist = () => {
    setSavedAt(null);
    save.mutate({ enabled, value: def.hasValue ? value.trim() || null : null });
  };

  // Turning a broad-impact flag ON requires confirmation. Save (when already
  // dirty by other means) and turning OFF go straight through.
  const handleSave = () => {
    if (enabled && !initialEnabled && impact) {
      setConfirmOpen(true);
      return;
    }
    persist();
  };

  const overLimit = value.length > VALUE_MAX;

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">{def.label}</span>
            <StatusBadge value={enabled ? "on" : "off"} map={STATUS_MAP} />
          </div>
          <p className="mt-1 text-xs text-zinc-400">{def.description}</p>
        </div>
        <code className="shrink-0 text-[11px] text-zinc-600">{def.key}</code>
      </div>

      <FormRow
        label="Aktifkan"
        help={impact ?? "Nyalakan untuk mengaktifkan flag ini."}
      >
        <RoleGate need="admin" role={role} fallbackTitle="Ubah flag khusus admin">
          <Toggle
            checked={enabled}
            onChange={(v) => {
              setEnabled(v);
              setSavedAt(null);
            }}
            danger={Boolean(impact)}
            label={enabled ? "Menyala" : "Mati"}
          />
        </RoleGate>
      </FormRow>

      {def.hasValue ? (
        <FormRow
          label={def.valueLabel ?? "Pesan maintenance (opsional)"}
          help="Pesan yang dilihat user saat maintenance. Opsional, maks 2000 char."
          error={overLimit ? `Maksimal ${VALUE_MAX} karakter.` : null}
        >
          <div className="space-y-1">
            <textarea
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSavedAt(null);
              }}
              rows={2}
              maxLength={VALUE_MAX + 200}
              placeholder="Lagi upgrade mesin, balik sebentar lagi."
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
            <p className="text-right text-[11px] tabular-nums text-zinc-500">
              {value.length}/{VALUE_MAX}
            </p>
          </div>
        </FormRow>
      ) : null}

      <RoleGate need="admin" role={role} fallbackTitle="Simpan flag khusus admin">
        <SaveBar
          dirty={dirty && !overLimit}
          saving={save.isPending}
          onSave={handleSave}
          onReset={() => {
            setEnabled(initialEnabled);
            setValue(initialValue);
            setSavedAt(null);
          }}
          savedAt={savedAt}
          message="Ada perubahan flag belum disimpan."
        />
      </RoleGate>

      <ConfirmDialog
        open={confirmOpen}
        title={`Aktifkan ${def.label}?`}
        body={impact}
        confirmLabel="Aktifkan"
        danger
        loading={save.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          persist();
        }}
      />
    </div>
  );
}
