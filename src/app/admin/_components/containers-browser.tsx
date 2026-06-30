"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  RefreshCw,
  Play,
  Square,
  RotateCcw,
  Trash2,
  HardDriveDownload,
  ScrollText,
} from "lucide-react";
import {
  apiFetch,
  fmtDateTime,
  Badge,
  StatusBadge,
  Section,
  TabIntro,
  EmptyState,
  RoleGate,
  DataTable,
  FilterBar,
  SearchInput,
  SegmentedControl,
  Toggle,
  ConfirmDialog,
  Drawer,
  useAdminQuery,
  useAdminMutation,
  useToast,
  type Column,
  type Option,
  type StatusMap,
  type LegendItem,
} from "./ui";
import { ContainerBackups } from "./container-backups";
import { ContainerLogs } from "./container-logs";

// --- API contract types (mirror /api/admin/containers GET row shape exactly) ---

type Row = {
  userId: string;
  email: string | null;
  status: string;
  port: number;
  containerName: string;
  imageVersion: string | null;
  errorMessage: string | null;
  provisionAttempts: number;
  lastHealthAt: string | null;
  balanceThrottledAt: string | null;
  createdAt: string;
};
type Resp = {
  rows: Row[];
  counts: Record<string, number>;
  pool: { total: number; claimed: number };
};

const CONTAINERS_KEY = ["admin", "containers"] as const;

// --- Status -> tone/label/hint. Single source for table badges + legend. ---

const CONTAINER_STATUS_MAP: StatusMap = {
  running: {
    tone: "ok",
    label: "Running",
    hint: "Kontainer hidup & sehat. Aksi valid: Hentikan, Bangun ulang, Hancurkan.",
  },
  "awaiting-health": {
    tone: "warn",
    label: "Awaiting health",
    hint: "Baru start, sedang nunggu lolos health check (~s/d 120 dtk).",
  },
  starting: { tone: "warn", label: "Starting", hint: "Proses docker start sedang jalan." },
  queued: { tone: "warn", label: "Queued", hint: "Antri provisioning, belum dijalankan." },
  failed: {
    tone: "bad",
    label: "Failed",
    hint: "Provisioning/health gagal. Lihat Error + tombol Bangun ulang.",
  },
  stopped: {
    tone: "muted",
    label: "Stopped",
    hint: "Sengaja dihentikan (energy habis / manual). Aksi valid: Mulai.",
  },
  destroyed: {
    tone: "muted",
    label: "Destroyed",
    hint: "Sudah dihancurkan. Aksi valid: Bangun ulang.",
  },
};

// Status legend for the TabIntro header.
const STATUS_LEGEND: LegendItem[] = [
  { tone: "ok", label: "running" },
  { tone: "warn", label: "starting / health / queued" },
  { tone: "bad", label: "failed" },
  { tone: "muted", label: "stopped / destroyed" },
];

// Status filter options for the segmented control. "" = semua.
const STATUS_FILTER: Option[] = [
  { value: "", label: "Semua" },
  { value: "running", label: "Running", tone: "ok" },
  { value: "awaiting-health", label: "Health", tone: "warn" },
  { value: "starting", label: "Starting", tone: "warn" },
  { value: "queued", label: "Queued", tone: "warn" },
  { value: "failed", label: "Failed", tone: "bad" },
  { value: "stopped", label: "Stopped", tone: "muted" },
  { value: "destroyed", label: "Destroyed", tone: "muted" },
];

// Which statuses each lifecycle action is valid for (contextual enable).
const START_OK = new Set(["stopped", "failed", "destroyed"]);
const STOP_OK = new Set(["running", "awaiting-health", "starting"]);
// reprovision + destroy are valid for any status (destroy of a live container
// stops then removes it; reprovision rebuilds from any state).

type Pending = { userId: string; action: "stop" | "reprovision" | "destroy"; email: string };

const POOL_WARN_RATIO = 0.9;

export function ContainersBrowser({ role = "admin" }: { role?: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch, isFetching } = useAdminQuery<Resp>(
    CONTAINERS_KEY,
    "/api/admin/containers",
    { refetchInterval: 5000 },
  );

  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [onlyThrottled, setOnlyThrottled] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailTab, setDetailTab] = useState<"backup" | "log">("log");

  // Lifecycle action mutation — toasts + invalidates the fleet list. The
  // POST contract is unchanged: { action } body, response { ok, async, status }.
  // The kit's useAdminMutation has no onSettled hook, so busyKey is cleared in
  // both onSuccess and onError below (error toast is handled by the kit).
  const act = useAdminMutation<{ userId: string; action: string }, { async?: boolean }>(
    ({ userId, action }) =>
      apiFetch<{ async?: boolean }>(`/api/admin/containers/${userId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    {
      invalidate: [CONTAINERS_KEY],
      onSuccess: (res, vars) => {
        setBusyKey(null);
        if (vars.action === "refresh") toast("Status diperbarui.", { tone: "ok" });
        else if (res?.async) toast("Diproses… status akan terupdate otomatis.", { tone: "info" });
        else toast("Aksi selesai.", { tone: "ok" });
      },
      onError: () => setBusyKey(null),
    },
  );

  function runImmediate(userId: string, action: "refresh" | "start") {
    setBusyKey(`${userId}:${action}`);
    act.mutate({ userId, action });
  }

  function confirmAction(p: Pending) {
    setPending(p);
  }

  function commitPending() {
    if (!pending) return;
    setBusyKey(`${pending.userId}:${pending.action}`);
    act.mutate({ userId: pending.userId, action: pending.action });
    setPending(null);
  }

  const pool = data?.pool;
  const poolRatio = pool && pool.total > 0 ? pool.claimed / pool.total : 0;
  const poolNearFull = poolRatio >= POOL_WARN_RATIO;

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (onlyThrottled && !r.balanceThrottledAt) return false;
      if (q && !(r.email ?? "").toLowerCase().includes(q) && !r.userId.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [data?.rows, statusFilter, search, onlyThrottled]);

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        key: "user",
        header: "User",
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate text-zinc-200">{r.email ?? "—"}</div>
            <div className="font-mono text-[10px] text-zinc-600">{r.userId.slice(0, 8)}</div>
            {r.errorMessage ? (
              <div
                className="mt-0.5 max-w-xs truncate text-[11px] text-red-400"
                title={r.errorMessage}
              >
                {r.errorMessage}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        cell: (r) => (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge value={r.status} map={CONTAINER_STATUS_MAP} />
            {r.balanceThrottledAt ? (
              <Badge tone="warn">throttled</Badge>
            ) : null}
          </div>
        ),
      },
      {
        key: "port",
        header: "Port",
        align: "right",
        cell: (r) => <span className="tabular-nums text-zinc-400">{r.port}</span>,
      },
      {
        key: "image",
        header: "Image",
        cell: (r) => <span className="text-zinc-500">{r.imageVersion ?? "—"}</span>,
      },
      {
        key: "health",
        header: "Health terakhir",
        cell: (r) => (
          <span className="whitespace-nowrap text-zinc-500">{fmtDateTime(r.lastHealthAt)}</span>
        ),
      },
      {
        key: "actions",
        header: "Aksi",
        cell: (r) => (
          <RowActions
            row={r}
            role={role}
            busyKey={busyKey}
            onRefresh={() => runImmediate(r.userId, "refresh")}
            onStart={() => runImmediate(r.userId, "start")}
            onStop={() =>
              confirmAction({ userId: r.userId, action: "stop", email: r.email ?? r.userId })
            }
            onReprovision={() =>
              confirmAction({ userId: r.userId, action: "reprovision", email: r.email ?? r.userId })
            }
            onDestroy={() =>
              confirmAction({ userId: r.userId, action: "destroy", email: r.email ?? r.userId })
            }
            onDetail={() => {
              setDetail(r);
              setDetailTab(r.status === "failed" ? "log" : "log");
            }}
          />
        ),
      },
    ],
    // runImmediate/confirmAction are stable closures over setState; busyKey + role drive re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, busyKey],
  );

  return (
    <div className="space-y-4">
      <TabIntro
        eyebrow="OPS · ARMADA"
        title="Armada Kontainer"
        what="Pusat kendali semua kontainer AI per-user. Satu baris = satu kontainer (engine pribadi user). Auto-refresh tiap 5 detik."
        canDo={[
          "Pantau status, port, versi image, dan health tiap kontainer.",
          "Jalankan aksi lifecycle: Cek status · Mulai · Hentikan · Bangun ulang · Hancurkan.",
          "Buka panel Backup volume dan Log per kontainer.",
          "Lihat ringkasan armada (jumlah per status) + sisa kuota port pool.",
        ]}
        how="Cari baris user (filter status / cari email di atas tabel). Aksi yang tidak valid untuk status sekarang otomatis nonaktif. Aksi merusak (Hentikan, Bangun ulang, Hancurkan) minta konfirmasi yang menyebut user-nya. Klik baris untuk lihat detail + Backup/Log."
        legend={STATUS_LEGEND}
      />

      <Section
        title="Daftar kontainer"
        desc="Klik baris untuk detail, backup, dan log."
        actions={
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
          >
            <RefreshCw className={isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
            Muat ulang
          </button>
        }
      >
        {pool ? (
          <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Pool port</span>
              <span className={poolNearFull ? "tabular-nums text-amber-400" : "tabular-nums text-zinc-400"}>
                {pool.claimed} / {pool.total} terpakai
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={poolNearFull ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-cyan-500"}
                style={{ width: `${Math.min(100, Math.round(poolRatio * 100))}%` }}
              />
            </div>
            {poolNearFull ? (
              <p className="mt-1.5 text-[11px] text-amber-400/80">
                Pool port hampir penuh — user baru bisa gagal provisioning. Tambah slot lewat
                seed-port-pool.
              </p>
            ) : null}
          </div>
        ) : null}

        <FilterBar
          actions={
            <Toggle
              checked={onlyThrottled}
              onChange={setOnlyThrottled}
              label="Hanya throttled"
            />
          }
        >
          <SegmentedControl
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTER}
            size="sm"
          />
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Cari email / userId…"
            scopeHint="email & userId (500 baris)"
          />
        </FilterBar>

        {isError ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <span>Gagal memuat armada. Coba lagi.</span>
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-500/10"
            >
              Coba lagi
            </button>
          </div>
        ) : null}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.userId}
          isLoading={isLoading}
          onRowClick={(r) => {
            setDetail(r);
            setDetailTab("log");
          }}
          empty={
            <EmptyState
              icon={<Boxes className="size-8" />}
              title={data && data.rows.length > 0 ? "Tidak ada yang cocok" : "Belum ada kontainer."}
              body={
                data && data.rows.length > 0
                  ? "Coba ubah filter status, pencarian, atau matikan 'Hanya throttled'."
                  : "User akan muncul di sini setelah provisioning pertama."
              }
            />
          }
        />
      </Section>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.email ?? detail?.userId ?? "Detail kontainer"}
        subtitle={detail ? `${detail.containerName} · port ${detail.port}` : undefined}
        width="max-w-2xl"
      >
        {detail ? (
          <div className="space-y-4">
            <DetailMeta row={detail} />
            <div>
              <SegmentedControl
                value={detailTab}
                onChange={(v) => setDetailTab(v as "backup" | "log")}
                options={[
                  { value: "log", label: "Log kontainer" },
                  { value: "backup", label: "Backup volume" },
                ]}
                size="sm"
              />
            </div>
            {detailTab === "backup" ? (
              <ContainerBackups userId={detail.userId} />
            ) : (
              <ContainerLogs userId={detail.userId} />
            )}
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={!!pending}
        onCancel={() => setPending(null)}
        onConfirm={commitPending}
        loading={act.isPending}
        danger={pending?.action === "destroy" || pending?.action === "reprovision"}
        title={confirmTitle(pending)}
        confirmLabel={confirmLabel(pending)}
        body={confirmBody(pending)}
        summary={
          pending
            ? [
                { label: "User", value: pending.email },
                { label: "userId", value: <span className="font-mono text-[11px]">{pending.userId}</span> },
              ]
            : undefined
        }
        // Heaviest action (destroy) requires typing the user's email to arm.
        typeToConfirm={pending?.action === "destroy" ? pending.email : undefined}
      />
    </div>
  );
}

// --- Per-row contextual action group ---

function RowActions({
  row,
  role,
  busyKey,
  onRefresh,
  onStart,
  onStop,
  onReprovision,
  onDestroy,
  onDetail,
}: {
  row: Row;
  role: string;
  busyKey: string | null;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onReprovision: () => void;
  onDestroy: () => void;
  onDetail: () => void;
}) {
  const busy = (action: string) => busyKey === `${row.userId}:${action}`;
  const anyBusy = !!busyKey && busyKey.startsWith(`${row.userId}:`);

  const startEnabled = START_OK.has(row.status);
  const stopEnabled = STOP_OK.has(row.status);

  // Clicks live on the action buttons; stop propagation so they don't also open
  // the row detail (onRowClick).
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <IconBtn
        title="Paksa cek status sekarang (di luar auto-refresh 5 dtk)"
        onClick={stop(onRefresh)}
        disabled={anyBusy}
        spinning={busy("refresh")}
      >
        <RefreshCw className="size-3.5" />
      </IconBtn>

      <IconBtn
        title={
          startEnabled
            ? "Jalankan kontainer + tunggu health"
            : "Kontainer sudah jalan / sedang start"
        }
        onClick={stop(onStart)}
        disabled={anyBusy || !startEnabled}
        spinning={busy("start")}
      >
        <Play className="size-3.5" />
      </IconBtn>

      <IconBtn
        title={
          stopEnabled
            ? "Matikan kontainer. Sesi chat user yang aktif akan terputus."
            : "Kontainer tidak sedang berjalan"
        }
        onClick={stop(onStop)}
        disabled={anyBusy || !stopEnabled}
        spinning={busy("stop")}
      >
        <Square className="size-3.5" />
      </IconBtn>

      <RoleGate need="admin" role={role} fallbackTitle="Aksi merusak khusus admin">
        <IconBtn
          title="Hancurkan + bangun ulang kontainer (port & nama dipakai lagi, token dirotasi, skill berbayar dipasang ulang). ±120 dtk."
          onClick={stop(onReprovision)}
          disabled={anyBusy}
          spinning={busy("reprovision")}
          tone="warn"
        >
          <RotateCcw className="size-3.5" />
        </IconBtn>
      </RoleGate>

      <RoleGate need="admin" role={role} fallbackTitle="Hancurkan khusus admin">
        <IconBtn
          title="Hapus kontainer permanen (volume tetap kecuali dihapus terpisah)."
          onClick={stop(onDestroy)}
          disabled={anyBusy}
          spinning={busy("destroy")}
          tone="bad"
        >
          <Trash2 className="size-3.5" />
        </IconBtn>
      </RoleGate>

      <span className="mx-0.5 h-4 w-px bg-zinc-800" aria-hidden />

      <IconBtn title="Buka detail, backup, dan log" onClick={stop(onDetail)} disabled={false}>
        <HardDriveDownload className="size-3.5" />
        <ScrollText className="size-3.5" />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  spinning,
  tone,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  disabled: boolean;
  spinning?: boolean;
  tone?: "warn" | "bad";
  children: React.ReactNode;
}) {
  const toneCls =
    tone === "bad"
      ? "border-red-500/40 text-red-400 hover:bg-red-500/10"
      : tone === "warn"
        ? "border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
        : "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled || spinning}
      className={
        "inline-flex items-center gap-1 rounded border px-1.5 py-1 transition disabled:cursor-not-allowed disabled:opacity-40 " +
        toneCls
      }
    >
      {spinning ? <RefreshCw className="size-3.5 animate-spin" /> : children}
    </button>
  );
}

// --- Drawer detail metadata ---

function DetailMeta({ row }: { row: Row }) {
  return (
    <div className="grid gap-x-6 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2">
      <MetaRow label="Status">
        <StatusBadge value={row.status} map={CONTAINER_STATUS_MAP} />
      </MetaRow>
      <MetaRow label="Port">
        <span className="tabular-nums text-zinc-200">{row.port}</span>
      </MetaRow>
      <MetaRow label="Image">
        <span className="text-zinc-300">{row.imageVersion ?? "—"}</span>
      </MetaRow>
      <MetaRow label="Health terakhir">
        <span className="text-zinc-300">{fmtDateTime(row.lastHealthAt)}</span>
      </MetaRow>
      <MetaRow label="Percobaan provision">
        <span className="tabular-nums text-zinc-300">{row.provisionAttempts}</span>
      </MetaRow>
      <MetaRow label="Throttled">
        {row.balanceThrottledAt ? (
          <Badge tone="warn">{fmtDateTime(row.balanceThrottledAt)}</Badge>
        ) : (
          <span className="text-zinc-500">tidak</span>
        )}
      </MetaRow>
      <MetaRow label="Dibuat">
        <span className="text-zinc-300">{fmtDateTime(row.createdAt)}</span>
      </MetaRow>
      <MetaRow label="userId">
        <span className="font-mono text-[11px] text-zinc-400">{row.userId}</span>
      </MetaRow>
      {row.errorMessage ? (
        <div className="sm:col-span-2">
          <div className="text-xs text-zinc-500">Error terakhir</div>
          <p className="mt-0.5 rounded border border-red-500/25 bg-red-500/5 px-2 py-1 text-[11px] text-red-300">
            {row.errorMessage}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

// --- Confirm dialog copy per action ---

function confirmTitle(p: Pending | null): string {
  if (!p) return "";
  if (p.action === "stop") return `Hentikan kontainer ${p.email}?`;
  if (p.action === "reprovision") return `Bangun ulang kontainer ${p.email}?`;
  return `Hancurkan kontainer ${p.email}`;
}

function confirmLabel(p: Pending | null): string {
  if (!p) return "Lanjutkan";
  if (p.action === "stop") return "Hentikan";
  if (p.action === "reprovision") return "Bangun ulang";
  return "Hancurkan";
}

function confirmBody(p: Pending | null): React.ReactNode {
  if (!p) return undefined;
  if (p.action === "stop")
    return "User yang sedang chat akan terputus. Status akan jadi stopped sampai dimulai lagi.";
  if (p.action === "reprovision")
    return "Kontainer dibangun ulang dari nol. Sesi & memori di volume tetap aman, tapi user terputus ±2 menit (skill berbayar dipasang ulang otomatis).";
  return "Kontainer dihapus permanen. Volume openclaw-user-… & isinya tetap kecuali dihapus terpisah; port dilepas ke pool. Ketik email user untuk mengaktifkan tombol.";
}
