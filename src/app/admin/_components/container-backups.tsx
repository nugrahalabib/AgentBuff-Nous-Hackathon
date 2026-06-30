"use client";

import { useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import {
  apiFetch,
  fmtDateTime,
  Section,
  Badge,
  EmptyState,
  FormRow,
  ConfirmDialog,
  useToast,
  useAdminQuery,
  useAdminMutation,
} from "./ui";

// D5 — per-container volume backup/restore sub-panel. Expanded from a row in
// ContainersBrowser. Lists this user's tarballs with restore (destructive,
// AlertDialog) + delete (confirm), plus a "Buat backup" trigger with optional note.

type Backup = { filename: string; sizeBytes: number; createdAt: string };
type ListResp = { backups: Backup[] };
type RestoreResp = { ok: true; message: string; restarted?: boolean };

const NOTE_MAX = 80;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30";

export function ContainerBackups({ userId }: { userId: string }) {
  const { toast } = useToast();
  const listKey = ["admin", "container-backups", userId];

  const { data, isLoading, isError, refetch } = useAdminQuery<ListResp>(
    listKey,
    `/api/admin/containers/${userId}/backups`,
  );

  const [note, setNote] = useState("");
  // Pending confirm targets (null = closed). Restore is destructive; delete
  // gets its own confirm to stay consistent with Restore/Destroy elsewhere.
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);

  const create = useAdminMutation<string, { filename: string }>(
    () =>
      apiFetch<{ filename: string }>(`/api/admin/containers/${userId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backup" }),
      }),
    {
      invalidate: [listKey],
      successMessage: (r, label) =>
        label.trim()
          ? `Backup dibuat: ${r.filename} (${label.trim()})`
          : `Backup dibuat: ${r.filename}`,
      onSuccess: () => setNote(""),
    },
  );

  const restore = useAdminMutation<Backup, RestoreResp>(
    (b) =>
      apiFetch<RestoreResp>(`/api/admin/containers/${userId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupFile: b.filename }),
      }),
    {
      // Restore can restart the container -> refresh the fleet too.
      invalidate: [listKey, ["admin", "containers"]],
      onSuccess: (r) => {
        toast(
          r.restarted
            ? r.message || "Dipulihkan, kontainer di-restart."
            : r.message || "Backup dipulihkan.",
          { tone: "ok" },
        );
        setRestoreTarget(null);
      },
      onError: () => setRestoreTarget(null),
    },
  );

  const del = useAdminMutation<Backup, unknown>(
    (b) =>
      apiFetch(
        `/api/admin/containers/${userId}/backups?filename=${encodeURIComponent(b.filename)}`,
        { method: "DELETE" },
      ),
    {
      invalidate: [listKey],
      successMessage: "Backup dihapus.",
      onSuccess: () => setDeleteTarget(null),
      onError: () => setDeleteTarget(null),
    },
  );

  // Newest first (createdAt desc); the top item gets a "Terbaru" chip.
  const backups = [...(data?.backups ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const createBusy = create.isPending;

  return (
    <Section
      title="Backup volume"
      desc="Snapshot & pulihkan seluruh volume kontainer user (config, sesi, skill, kredensial channel, BYOK keys)."
      actions={
        <button
          type="button"
          disabled={createBusy}
          onClick={() => create.mutate(note)}
          className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-60"
        >
          <Archive className="size-3.5" />
          {createBusy ? "Membuat…" : "Buat backup"}
        </button>
      }
    >
      <div className="space-y-4">
        <FormRow
          label="Catatan (opsional)"
          help="Snapshot seluruh volume user sekarang. Catatan membantu bedakan tujuan backup, mis. pre-reprovision."
        >
          <input
            value={note}
            maxLength={NOTE_MAX}
            disabled={createBusy}
            onChange={(e) => setNote(e.target.value)}
            placeholder="mis. pre-reprovision"
            className={INPUT}
          />
        </FormRow>

        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
          Backup tidak auto-cleanup. Hapus manual backup lama agar tidak
          menumpuk. Restore akan menimpa SELURUH data user dan me-restart
          kontainer.
        </p>

        {isLoading ? (
          <div className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-9 animate-pulse rounded-md border border-zinc-800 bg-zinc-900/40"
              />
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <span>Gagal memuat backup.</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded border border-red-500/40 px-2 py-0.5 font-medium text-red-200 hover:bg-red-500/15"
            >
              Coba lagi
            </button>
          </div>
        ) : backups.length === 0 ? (
          <EmptyState
            icon={<Archive className="size-8" />}
            title="Belum ada backup."
            body="Buat backup pertama sebelum melakukan aksi berisiko."
            action={
              <button
                type="button"
                disabled={createBusy}
                onClick={() => create.mutate(note)}
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-60"
              >
                <Archive className="size-3.5" />
                {createBusy ? "Membuat…" : "Buat backup pertama"}
              </button>
            }
          />
        ) : (
          <ul className="space-y-1.5">
            {backups.map((b, i) => {
              const itemBusy =
                (restore.isPending && restore.variables?.filename === b.filename) ||
                (del.isPending && del.variables?.filename === b.filename);
              return (
                <li
                  key={b.filename}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
                >
                  <span className="font-mono text-zinc-300">
                    {fmtDateTime(b.createdAt)}
                  </span>
                  <span className="tabular-nums text-zinc-500">
                    {fmtSize(b.sizeBytes)}
                  </span>
                  {i === 0 && <Badge tone="info">Terbaru</Badge>}
                  <span className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={itemBusy}
                      onClick={() => setRestoreTarget(b)}
                      className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-0.5 text-amber-300 transition hover:bg-amber-500/10 disabled:opacity-40"
                    >
                      <RotateCcw className="size-3" />
                      Pulihkan
                    </button>
                    <button
                      type="button"
                      disabled={itemBusy}
                      onClick={() => setDeleteTarget(b)}
                      className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 transition hover:border-red-500/40 hover:text-red-400 disabled:opacity-40"
                    >
                      <Trash2 className="size-3" />
                      Hapus
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={restoreTarget !== null}
        danger
        loading={restore.isPending}
        title="Pulihkan dari backup ini?"
        body="Timpa seluruh data user dengan isi backup ini. Kontainer akan restart — sesi aktif hilang. Aksi ini tidak bisa di-undo."
        summary={
          restoreTarget
            ? [
                { label: "Backup", value: fmtDateTime(restoreTarget.createdAt) },
                { label: "Ukuran", value: fmtSize(restoreTarget.sizeBytes) },
              ]
            : undefined
        }
        confirmLabel="Pulihkan"
        onConfirm={() => restoreTarget && restore.mutate(restoreTarget)}
        onCancel={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        loading={del.isPending}
        title="Hapus backup ini?"
        body="Hapus file backup ini permanen. Tidak bisa dikembalikan."
        summary={
          deleteTarget
            ? [
                { label: "Backup", value: fmtDateTime(deleteTarget.createdAt) },
                { label: "Ukuran", value: fmtSize(deleteTarget.sizeBytes) },
              ]
            : undefined
        }
        confirmLabel="Hapus"
        onConfirm={() => deleteTarget && del.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Section>
  );
}
