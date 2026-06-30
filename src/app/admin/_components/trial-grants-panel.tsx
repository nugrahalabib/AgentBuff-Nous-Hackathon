"use client";

import { useState } from "react";
import { ShieldOff } from "lucide-react";
import {
  apiFetch,
  fmtDateTime,
  Badge,
  Section,
  EmptyState,
  DataTable,
  Pagination,
  ConfirmDialog,
  useAdminQuery,
  useAdminMutation,
  type Column,
} from "./ui";

// D3 — anti-farm trial-grant ledger management. The ledger stores sha256 email
// hashes (no raw email), so the useful op is: look up an email, and if it has a
// consumed trial, remove it so they can trial again. Plus a raw browse list.
//
// Restyled to the dark admin kit + control-upgrade (control reference: the
// "Anti-farm" rows in Docs/admin-ux-redesign-plan.md Tab 1). Same endpoints,
// same request/response shapes — only the surface and the confirm flow change.

type Grant = { emailHash: string; grantedAt: string };
type ListResp = { rows: Grant[]; page: number; pageSize: number; total: number };
type Lookup = {
  email: string;
  emailHash: string;
  found: boolean;
  grantedAt: string | null;
};

// Mirror the server clamp (route.ts slices email to 200 chars).
const EMAIL_MAX = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the confirm dialog targets — either a looked-up email or a browse row.
type DeleteTarget = { hash: string; label: string };

export function TrialGrantsPanel() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const list = useAdminQuery<ListResp>(
    ["admin", "trial-grants", page],
    `/api/admin/trial-grants?page=${page}`,
  );

  const find = useAdminMutation<string, { lookup: Lookup }>(
    (e) =>
      apiFetch<{ lookup: Lookup }>(
        `/api/admin/trial-grants?email=${encodeURIComponent(e)}`,
      ),
    { onSuccess: (r) => setLookup(r.lookup) },
  );

  const del = useAdminMutation<DeleteTarget, unknown>(
    (t) => apiFetch(`/api/admin/trial-grants/${t.hash}`, { method: "DELETE" }),
    {
      invalidate: [["admin", "trial-grants", page]],
      successMessage: (_d, t) => `Hak trial direset untuk ${t.label}.`,
      onSuccess: (_d, t) => {
        // If the removed entry is the one currently shown in the lookup panel,
        // clear it so the result no longer claims "sudah di ledger".
        setLookup((cur) => (cur && cur.emailHash === t.hash ? null : cur));
      },
    },
  );

  const total = list.data?.total ?? 0;
  const pageSize = list.data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function handleCheck() {
    const e = email.trim().slice(0, EMAIL_MAX);
    if (!EMAIL_RE.test(e)) {
      setEmailError("Format email tidak valid.");
      setLookup(null);
      return;
    }
    setEmailError(null);
    find.mutate(e);
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete, {
      onSettled: () => setPendingDelete(null),
    });
  }

  const columns: Column<Grant>[] = [
    {
      key: "hash",
      header: "Hash email (sha256)",
      cell: (g) => (
        <span className="font-mono text-xs text-zinc-400">
          {g.emailHash.slice(0, 16)}…
        </span>
      ),
    },
    {
      key: "grantedAt",
      header: "Tercatat",
      cell: (g) => (
        <span className="text-xs text-zinc-400">{fmtDateTime(g.grantedAt)}</span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      cell: (g) => (
        <button
          type="button"
          onClick={() =>
            setPendingDelete({ hash: g.emailHash, label: `hash ${g.emailHash.slice(0, 12)}…` })
          }
          disabled={del.isPending}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-40"
        >
          Reset hak trial
        </button>
      ),
    },
  ];

  return (
    <Section
      title="Trial anti-farm ledger"
      desc="Email yang sudah pakai trial tercatat sebagai hash. Reset entri = email itu bisa klaim trial gratis lagi (mis. user sah yang minta reset)."
    >
      <div className="space-y-5">
        {/* Lookup by email */}
        <div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full max-w-xs">
              <label
                htmlFor="trial-lookup-email"
                className="mb-1 block text-xs text-zinc-400"
              >
                Cek email di ledger
              </label>
              <input
                id="trial-lookup-email"
                type="email"
                value={email}
                maxLength={EMAIL_MAX}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCheck();
                }}
                placeholder="user@contoh.com"
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </div>
            <button
              type="button"
              disabled={!email.trim() || find.isPending}
              onClick={handleCheck}
              className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-40"
            >
              {find.isPending ? "Mengecek…" : "Cek ledger"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">
            Pakai hash — tak bisa telusuri daftar by-email. Cek apakah satu email
            sudah pernah pakai trial.
          </p>
          {emailError && (
            <p className="mt-1.5 text-xs text-red-400">{emailError}</p>
          )}

          {lookup && (
            <div className="mt-3">
              {lookup.found ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm text-amber-200">
                    <Badge tone="warn">Di ledger</Badge>
                    <span>
                      {lookup.email} sudah pakai trial
                      {lookup.grantedAt
                        ? ` sejak ${fmtDateTime(lookup.grantedAt)}`
                        : ""}
                      .
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={del.isPending}
                    onClick={() =>
                      setPendingDelete({
                        hash: lookup.emailHash,
                        label: lookup.email,
                      })
                    }
                    className="rounded-md border border-red-500/50 px-2.5 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Reset hak trial
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
                  <Badge tone="ok">Belum ada</Badge>
                  <span>{lookup.email} belum pernah trial — bisa klaim.</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Raw ledger browse */}
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
            <span>Ledger</span>
            <Badge tone="muted">{total} entri</Badge>
          </div>
          <DataTable
            columns={columns}
            rows={list.data?.rows ?? []}
            rowKey={(g) => g.emailHash}
            isLoading={list.isLoading}
            empty={
              list.error ? (
                <EmptyState
                  icon={<ShieldOff className="size-8" />}
                  title="Gagal memuat ledger"
                  body="Coba muat ulang panel ini."
                  action={
                    <button
                      type="button"
                      onClick={() => list.refetch()}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
                    >
                      Coba lagi
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<ShieldOff className="size-8" />}
                  title="Ledger kosong"
                  body="Belum ada email yang pernah klaim trial."
                />
              )
            }
          />
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              onPage={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
              total={total}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="Reset hak trial?"
        body={
          <>
            Menghapus entri untuk{" "}
            <span className="font-medium text-zinc-200">
              {pendingDelete?.label}
            </span>{" "}
            membuat email itu bisa klaim trial gratis lagi (membuka pintu
            farming). Pastikan ini permintaan yang sah.
          </>
        }
        confirmLabel="Reset hak trial"
        loading={del.isPending}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!del.isPending) setPendingDelete(null);
        }}
      />
    </Section>
  );
}
