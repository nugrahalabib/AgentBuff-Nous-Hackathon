"use client";

import { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import {
  Section,
  FormRow,
  Combobox,
  SegmentedControl,
  ConfirmDialog,
  EmptyState,
  Badge,
  KeyValueGrid,
  useAdminQuery,
  useAdminMutation,
  apiFetch,
  type Option,
} from "./ui";

// D4 — admin force-uninstall (moderation). Pulls a skill from ONE user's
// container or ALL users that hold it (massal), and blocks the self-heal from
// reinstalling it on reprovision. Destructive cross-user op — confirm gated.

type Result = { userId: string; ok: boolean; detail: string };
type Resp = {
  ok: boolean;
  attempted: number;
  removed: number;
  failed: number;
  truncated?: boolean;
  results: Result[];
};

type Scope = "single" | "all";

// Users-list shape consumed for the email combobox (reuse Fleet/User Hub data).
type UserRow = { id: string; email: string | null; name: string | null };
type UsersResp = { rows: UserRow[] };

const SCOPE_OPTIONS: Option<Scope>[] = [
  { value: "single", label: "Satu user", hint: "Cabut dari satu kontainer" },
  { value: "all", label: "Massal", hint: "Cabut dari SEMUA pemilik (maks 500)" },
];

const USERID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SKILLKEY_RE = /^[a-zA-Z0-9_.:@/-]{1,120}$/;

export function SkillUninstallPanel() {
  const [skillKey, setSkillKey] = useState("");
  const [scope, setScope] = useState<Scope>("single");
  const [userId, setUserId] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Searchable user picker, backed by the existing admin user list. The query
  // updates as the operator types in the combobox (we also accept a pasted UUID
  // via allowCustom). Only enabled in single scope.
  const usersQ = useAdminQuery<UsersResp>(
    ["admin", "skill-uninstall", "users", userQuery],
    `/api/admin/users?q=${encodeURIComponent(userQuery)}`,
    { enabled: scope === "single" },
  );

  const userOptions: Option[] = useMemo(
    () =>
      (usersQ.data?.rows ?? []).map((u) => ({
        value: u.id,
        label: u.email ?? u.id,
        hint: u.name ?? u.id,
      })),
    [usersQ.data],
  );

  const run = useAdminMutation<void, Resp>(
    () =>
      apiFetch<Resp>("/api/admin/skills/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "all"
            ? { skillKey: skillKey.trim(), all: true }
            : { skillKey: skillKey.trim(), userId: userId.trim() },
        ),
      }),
    {
      successMessage: (d) =>
        d.failed > 0
          ? `${d.removed} dicabut · ${d.failed} masih live di engine`
          : `${d.removed} skill dicabut`,
      onSuccess: () => setConfirmOpen(false),
    },
  );

  const skillValid = SKILLKEY_RE.test(skillKey.trim());
  const userValid = USERID_RE.test(userId.trim());
  const canRun =
    skillValid && (scope === "all" || (userId.trim().length > 0 && userValid));

  const skillError =
    skillKey.trim().length > 0 && !skillValid
      ? "Skill key tidak valid (huruf/angka/.:@/-, maks 120)."
      : undefined;
  const userError =
    scope === "single" && userId.trim().length > 0 && !userValid
      ? "User ID tidak valid (maks 80 karakter alfanumerik)."
      : undefined;

  const selectedUserLabel =
    userOptions.find((o) => o.value === userId)?.label ?? userId;

  return (
    <Section
      title="Cabut Paksa Skill"
      desc="Moderasi: cabut skill dari kontainer satu user atau semua pemilik (massal), sekaligus mencegahnya terpasang ulang saat reprovision. Tidak mengembalikan dana — refund jalur terpisah."
    >
      <div className="space-y-4">
        <FormRow
          label="Skill key"
          help="Ketik kunci skill yang ingin dicabut (mis. web-search). Harus sesuai persis dengan yang terpasang."
          error={skillError}
          required
        >
          <Combobox
            value={skillKey}
            onChange={(v) => setSkillKey(v)}
            options={[]}
            allowCustom
            placeholder="mis. web-search"
            emptyText="Ketik kunci skill lalu Enter"
          />
        </FormRow>

        <FormRow
          label="Cakupan"
          help="Massal mencabut dari SEMUA pemilik skill ini (diproses maks 500 per operasi, urut userId)."
          required
        >
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v)}
            options={SCOPE_OPTIONS}
          />
        </FormRow>

        {scope === "single" ? (
          <FormRow
            label="User"
            help="Cari user berdasarkan email. Hasil terisi otomatis ke userId — atau tempel UUID langsung."
            error={userError}
            required
          >
            <Combobox
              value={userId}
              onChange={(v) => {
                setUserId(v);
                setUserQuery("");
              }}
              options={userOptions}
              allowCustom
              loading={usersQ.isLoading}
              placeholder="Cari email user…"
              emptyText={
                userQuery.trim()
                  ? "User tidak ditemukan"
                  : "Ketik email untuk mencari"
              }
            />
          </FormRow>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!canRun || run.isPending}
            onClick={() => setConfirmOpen(true)}
            className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {run.isPending ? "Mencabut…" : "Cabut paksa"}
          </button>
          <span className="text-xs text-zinc-500">
            Maks 10 operasi/menit per admin.
          </span>
        </div>

        {run.data ? <ResultPanel data={run.data} /> : null}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        danger
        loading={run.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => run.mutate()}
        confirmLabel="Cabut paksa"
        title={
          scope === "all"
            ? "Cabut skill dari SEMUA pemilik?"
            : "Cabut skill dari user ini?"
        }
        typeToConfirm={scope === "all" ? skillKey.trim() : undefined}
        body={
          scope === "all"
            ? "Operasi massal: mencabut skill dari semua kontainer yang memilikinya (maks 500 per batch) dan menstempel transaksi agar tidak terpasang ulang saat reprovision."
            : "Mencabut skill dari kontainer user ini dan menstempel transaksi agar tidak terpasang ulang saat reprovision."
        }
        summary={[
          { label: "Skill", value: skillKey.trim() || "—", tone: "info" },
          {
            label: "Cakupan",
            value: scope === "all" ? "Semua pemilik (massal)" : "Satu user",
            tone: scope === "all" ? "bad" : "muted",
          },
          ...(scope === "single"
            ? [{ label: "User", value: selectedUserLabel || "—" }]
            : []),
        ]}
      />
    </Section>
  );
}

function ResultPanel({ data }: { data: Resp }) {
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <KeyValueGrid
        cols={2}
        items={[
          { label: "Diproses", value: data.attempted },
          { label: "Dicabut", value: data.removed, tone: "ok" },
          {
            label: "Masih live di engine",
            value: data.failed,
            tone: data.failed > 0 ? "bad" : "muted",
          },
          ...(data.truncated
            ? [
                {
                  label: "Catatan",
                  value: ">500 pemilik — jalankan lagi 'Massal' untuk sisanya",
                  tone: "warn" as const,
                },
              ]
            : []),
        ]}
      />

      {data.results.length === 0 ? (
        <EmptyState
          icon={<Wrench className="size-7" />}
          title="Tidak ada kontainer yang punya skill ini"
          body="Periksa lagi ejaan skill key — tidak ada user yang memilikinya."
        />
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {data.results.map((r) => (
            <li
              key={r.userId}
              className="flex items-start gap-2 text-[11px] text-zinc-400"
              title={
                r.ok
                  ? "Skill berhasil dicabut"
                  : "Engine gagal uninstall; record DB sudah dibersihkan, skill hilang saat reprovision berikutnya."
              }
            >
              <Badge tone={r.ok ? "ok" : "bad"}>{r.ok ? "OK" : "Live"}</Badge>
              <span className="shrink-0 font-mono text-zinc-500">
                {r.userId.slice(0, 12)}
              </span>
              <span className="text-zinc-500">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
