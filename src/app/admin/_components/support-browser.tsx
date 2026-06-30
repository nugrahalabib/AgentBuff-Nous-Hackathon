"use client";

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import {
  apiFetch,
  fmtDateTime,
  StatusBadge,
  Section,
  KeyValueGrid,
  TabIntro,
  EmptyState,
  RoleGate,
  useAdminQuery,
  useAdminMutation,
  useToast,
  errorToBahasa,
  str,
  SearchInput,
  SegmentedControl,
  Select,
  FilterBar,
  DataTable,
  Pagination,
  Drawer,
  type Option,
  type StatusMap,
  type Column,
} from "./ui";

type Row = {
  id: string;
  ref: string;
  userId: string | null;
  email: string | null;
  category: string;
  subject: string;
  message: string;
  status: string;
  reply: string | null;
  repliedAt: string | null;
  repliedBy: string | null;
  createdAt: string;
};
type ListResp = {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  openCount: number;
};

// Status enum (server: open/in_progress/answered/closed) -> tone + Bahasa label.
const STATUS_MAP: StatusMap = {
  open: { tone: "warn", label: "Baru", hint: "Belum disentuh" },
  in_progress: { tone: "info", label: "Diproses", hint: "Sedang ditangani" },
  answered: { tone: "ok", label: "Dijawab", hint: "Sudah dibalas tim" },
  closed: { tone: "muted", label: "Ditutup", hint: "Selesai / ditutup" },
};
const STATUS_OPTIONS: Option[] = Object.entries(STATUS_MAP).map(([value, e]) => ({
  value,
  label: e.label,
  hint: e.hint,
  tone: e.tone,
}));

// Category enum — user picks this when filing a ticket.
const CAT_LABEL: Record<string, string> = {
  keluhan: "Keluhan",
  pengembangan: "Pengembangan",
  pertanyaan: "Pertanyaan",
};
const CAT_OPTIONS: Option[] = [
  { value: "", label: "Semua kategori" },
  ...Object.entries(CAT_LABEL).map(([value, label]) => ({ value, label })),
];

// Canned reply templates (insert into composer, then edit).
const REPLY_TEMPLATES: { label: string; text: string }[] = [
  {
    label: "Terima kasih sudah lapor",
    text: "Halo! Terima kasih sudah melaporkan ini. Tim kami sedang menelaah dan akan kabari secepatnya.",
  },
  {
    label: "Bug dikonfirmasi",
    text: "Terima kasih laporannya. Bug ini sudah kami konfirmasi dan sedang dalam perbaikan. Kami update setelah selesai.",
  },
  {
    label: "Butuh info tambahan",
    text: "Untuk membantu lebih cepat, boleh bagikan detail tambahan: langkah yang kamu lakukan, dan kapan terakhir terjadi?",
  },
  {
    label: "Sudah diperbaiki",
    text: "Masalah ini sudah kami perbaiki. Mohon coba ulang dan beri tahu kami kalau masih ada kendala.",
  },
];

const MAX_REPLY = 4000;
const PAGE_SIZE = 25;

export function SupportBrowser({ role = "admin" }: { role?: string }) {
  const isReadOnly = role !== "admin";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Row | null>(null);

  const listUrl = (() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status) p.set("status", status);
    if (category) p.set("category", category);
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    return `/api/admin/support?${p.toString()}`;
  })();

  const { data, isLoading, error, refetch } = useAdminQuery<ListResp>(
    ["admin", "support", q, status, category, page, pageSize],
    listUrl,
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize ?? PAGE_SIZE)));
  const curPage = data?.page ?? page;

  // Quick-set status from a row without opening the drawer. Optimistic-ish:
  // toast + Undo, then refetch. Re-uses the same PATCH contract as the drawer.
  const quickSet = useAdminMutation<{ id: string; status: string }, { ok: boolean }>(
    ({ id, status: s }) =>
      apiFetch<{ ok: boolean }>(`/api/admin/support/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: s }),
      }),
    { invalidate: [["admin", "support"]] },
  );
  const { toast } = useToast();

  const onQuickSet = (row: Row, next: string) => {
    if (next === row.status) return;
    const prev = row.status;
    quickSet.mutate({ id: row.id, status: next });
    toast(`Status ${row.ref} → ${STATUS_MAP[next]?.label ?? next}`, {
      tone: "ok",
      action: {
        label: "Urungkan",
        onClick: () => quickSet.mutate({ id: row.id, status: prev }),
      },
    });
  };

  // Status filter as a segmented control. Only "Baru" has a server count
  // (openCount); the others render without a count rather than fabricate one.
  const statusFilterOptions: Option[] = [
    { value: "", label: "Semua" },
    {
      value: "open",
      label: data ? `Baru (${data.openCount})` : "Baru",
      hint: STATUS_MAP.open.hint,
    },
    { value: "in_progress", label: "Diproses", hint: STATUS_MAP.in_progress.hint },
    { value: "answered", label: "Dijawab", hint: STATUS_MAP.answered.hint },
    { value: "closed", label: "Ditutup", hint: STATUS_MAP.closed.hint },
  ];

  const columns: Column<Row>[] = [
    {
      key: "ref",
      header: "Ref",
      cell: (r) => <span className="font-mono text-xs text-zinc-300">{r.ref}</span>,
    },
    {
      key: "email",
      header: "User",
      cell: (r) => <span className="text-zinc-400">{r.email ?? "Anonim"}</span>,
    },
    {
      key: "category",
      header: "Kategori",
      cell: (r) => (
        <span className="text-zinc-400">{CAT_LABEL[r.category] ?? r.category}</span>
      ),
    },
    {
      key: "subject",
      header: "Subjek",
      cell: (r) => (
        <span className="block max-w-xs truncate text-zinc-200" title={r.subject}>
          {r.subject}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) =>
        isReadOnly ? (
          <StatusBadge value={r.status} map={STATUS_MAP} />
        ) : (
          <span onClick={(e) => e.stopPropagation()}>
            <Select
              value={r.status}
              onChange={(v) => onQuickSet(r, v)}
              options={STATUS_OPTIONS}
            />
          </span>
        ),
    },
    {
      key: "createdAt",
      header: "Masuk",
      align: "right",
      cell: (r) => <span className="text-zinc-500">{fmtDateTime(r.createdAt)}</span>,
    },
  ];

  const emptyNode =
    q || status || category ? (
      <EmptyState
        icon={<LifeBuoy className="size-8" />}
        title="Tak ada tiket cocok"
        body="Tidak ada tiket untuk filter / pencarian ini. Ganti filter atau bersihkan pencarian."
      />
    ) : (
      <EmptyState
        icon={<LifeBuoy className="size-8" />}
        title="Belum ada tiket"
        body="Tiket masuk otomatis dari form keluhan / pengembangan / pertanyaan di halaman /bantuan."
      />
    );

  return (
    <div className="space-y-3">
      <TabIntro
        eyebrow="OPS · DUKUNGAN"
        title="Dukungan"
        what="Inbox tiket dukungan — baca keluhan/pertanyaan user, lihat konteks akunnya, balas, lalu set status. Balasan otomatis mengirim notifikasi in-app ke user dan menandai tiket 'Dijawab'."
        canDo={[
          "Cari & filter tiket per status dan kategori.",
          "Buka tiket → baca pesan + konteks user (trial/sub/kontainer/energy/jumlah agen-skill-transaksi).",
          "Tulis balasan (≤4000 char), sisipkan template, dan set status.",
        ]}
        how="1) Pilih filter status (mis. 'Baru'). 2) Klik tiket. 3) Tulis balasan / pilih template. 4) Simpan. Mengirim balasan otomatis set status 'Dijawab' + kirim notifikasi ke user lewat /bantuan (bukan email)."
        legend={[
          { tone: "warn", label: "Baru" },
          { tone: "info", label: "Diproses" },
          { tone: "ok", label: "Dijawab" },
          { tone: "muted", label: "Ditutup" },
        ]}
        warning={
          isReadOnly
            ? "Mode baca-saja (Support). Kamu bisa baca tiket & konteks user, tapi membalas / mengubah status hanya bisa dilakukan admin."
            : undefined
        }
      />

      <FilterBar
        actions={
          <span className="text-xs text-zinc-500">
            {isLoading
              ? "Memuat…"
              : `${total.toLocaleString("id-ID")} tiket · ${data?.openCount ?? 0} baru`}
          </span>
        }
      >
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Cari subjek atau nomor ref…"
          scopeHint="subjek & nomor ref (maks 100 char)"
        />
        <SegmentedControl
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={statusFilterOptions}
          size="sm"
        />
        <div className="w-44">
          <Select
            value={category}
            onChange={(v) => {
              setCategory(v);
              setPage(1);
            }}
            options={CAT_OPTIONS}
            placeholder="Semua kategori"
          />
        </div>
      </FilterBar>

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{errorToBahasa(error)}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded border border-red-500/40 px-2 py-0.5 text-xs hover:bg-red-500/20"
          >
            Coba lagi
          </button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        empty={emptyNode}
        onRowClick={(r) => setSelected(r)}
      />

      <Pagination
        page={curPage}
        totalPages={totalPages}
        onPage={(p) => setPage(Math.max(1, p))}
        pageSize={data?.pageSize ?? pageSize}
        onPageSize={(n) => {
          setPageSize(n);
          setPage(1);
        }}
        total={total}
      />

      <TicketDrawer
        ticket={selected}
        role={role}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function TicketDrawer({
  ticket,
  role,
  onClose,
}: {
  ticket: Row | null;
  role: string;
  onClose: () => void;
}) {
  const isReadOnly = role !== "admin";

  if (!ticket) return null;

  return (
    <Drawer open onClose={onClose} title={ticket.subject} subtitle={ticket.ref}>
      <TicketDrawerBody ticket={ticket} isReadOnly={isReadOnly} onClose={onClose} />
    </Drawer>
  );
}

// Body is a separate component keyed by ticket id (via the Drawer remount) so
// reply/status reset cleanly when a different ticket is opened.
function TicketDrawerBody({
  ticket,
  isReadOnly,
  onClose,
}: {
  ticket: Row;
  isReadOnly: boolean;
  onClose: () => void;
}) {
  const [reply, setReply] = useState(ticket.reply ?? "");
  const [status, setStatus] = useState(ticket.status);

  const tooLong = reply.length > MAX_REPLY;
  const trimmedReply = reply.trim();
  const hasReplyChange = trimmedReply.length > 0 && trimmedReply !== (ticket.reply ?? "").trim();
  const hasStatusChange = status !== ticket.status;
  const canSave = !isReadOnly && !tooLong && (hasReplyChange || hasStatusChange);

  const save = useAdminMutation<void, { ok: boolean }>(
    () =>
      apiFetch<{ ok: boolean }>(`/api/admin/support/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: trimmedReply || undefined,
          // Only send status when the admin actually changed it, so the server's
          // "reply with no explicit status -> answered" auto-rule fires on an
          // untouched dropdown (otherwise a reply on an 'open' ticket would keep
          // it 'open'). An explicit status change is still honored.
          status: hasStatusChange ? status : undefined,
        }),
      }),
    {
      successMessage: "Balasan terkirim, user dapat notifikasi.",
      invalidate: [["admin", "support"]],
      onSuccess: onClose,
    },
  );

  const insertTemplate = (text: string) => {
    setReply((cur) => (cur.trim() ? `${cur.trim()}\n\n${text}` : text));
  };

  return (
    <div className="space-y-5">
      <Section title="Tiket">
        <KeyValueGrid
          items={[
            { label: "User", value: ticket.email ?? "Anonim (tanpa akun)" },
            { label: "Kategori", value: CAT_LABEL[ticket.category] ?? ticket.category },
            {
              label: "Status",
              value: <StatusBadge value={ticket.status} map={STATUS_MAP} />,
            },
            { label: "Masuk", value: fmtDateTime(ticket.createdAt) },
            ...(ticket.repliedAt
              ? [
                  {
                    label: "Dibalas",
                    value: `${fmtDateTime(ticket.repliedAt)}${ticket.repliedBy ? " · oleh tim" : ""}`,
                  },
                ]
              : []),
          ]}
        />
      </Section>

      {ticket.userId ? <UserContextSection userId={ticket.userId} /> : null}

      <Section title="Pesan">
        <p className="whitespace-pre-wrap text-sm text-zinc-300">{ticket.message}</p>
      </Section>

      <Section title="Balasan & status">
        {isReadOnly ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              Mode baca-saja (Support). Minta admin untuk membalas tiket ini.
            </div>
            {ticket.reply ? (
              <p className="whitespace-pre-wrap text-sm text-zinc-400">{ticket.reply}</p>
            ) : (
              <p className="text-xs text-zinc-600">Belum ada balasan.</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-zinc-500">Template:</span>
              {REPLY_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() => insertTemplate(tpl.text)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-cyan-500/40 hover:text-cyan-300"
                >
                  {tpl.label}
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={6}
                placeholder="Tulis balasan untuk user… (mengirim balasan otomatis set status Dijawab + kirim notifikasi ke user)"
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-500">
                  Dikirim sebagai notifikasi in-app (ke /bantuan), bukan email.
                </span>
                <span className={tooLong ? "text-red-400" : "text-zinc-500"}>
                  {reply.length}/{MAX_REPLY}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <SegmentedControl
                  value={status}
                  onChange={(v) => setStatus(v)}
                  options={STATUS_OPTIONS}
                  size="sm"
                />
              </div>
              <RoleGate
                need="admin"
                role={isReadOnly ? "support" : "admin"}
                fallbackTitle="Balas khusus admin"
              >
                <button
                  type="button"
                  disabled={!canSave || save.isPending}
                  title={
                    !canSave && !save.isPending
                      ? "Tulis balasan atau ubah status dulu."
                      : undefined
                  }
                  onClick={() => save.mutate()}
                  className="ml-auto rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {save.isPending ? "Mengirim…" : "Kirim balasan"}
                </button>
              </RoleGate>
            </div>
            <p className="text-[11px] text-zinc-500">
              Kalau kamu balas tanpa ubah status, tiket otomatis jadi{" "}
              <span className="text-zinc-300">Dijawab</span>. Ubah manual untuk override.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

// D16 — compact user-context panel inside a support ticket. Reuses the admin
// user-detail API so support can see trial/sub/container at a glance without
// leaving the ticket.
type UserCtx = {
  trial: { status: string; endsAt: string } | null;
  activeSub: { tier?: unknown } | null;
  container: { status?: unknown } | null;
  energy: { balance: number; maxBalance: number } | null;
  counts: { agents: number; skills: number; transactions: number };
};

function UserContextSection({ userId }: { userId: string }) {
  const { data, isLoading, error } = useAdminQuery<UserCtx>(
    ["admin", "support-userctx", userId],
    `/api/admin/users/${userId}`,
  );

  return (
    <Section title="Konteks user">
      {isLoading ? (
        <div className="text-xs text-zinc-600">Memuat…</div>
      ) : error || !data ? (
        <div className="text-xs text-zinc-600">Tidak bisa memuat konteks.</div>
      ) : (
        <KeyValueGrid
          cols={2}
          items={[
            {
              label: "Trial",
              value: data.trial
                ? `${data.trial.status} · ${fmtDateTime(data.trial.endsAt)}`
                : "—",
            },
            {
              label: "Langganan",
              value: data.activeSub ? str(data.activeSub.tier) ?? "aktif" : "—",
            },
            {
              label: "Kontainer",
              value: data.container ? str(data.container.status) ?? "—" : "—",
            },
            {
              label: "Saldo",
              value: data.energy
                ? `Rp ${data.energy.balance.toLocaleString("id-ID")} / Rp ${data.energy.maxBalance.toLocaleString("id-ID")}`
                : "—",
            },
            {
              label: "Agen / Skill / Transaksi",
              value: `${data.counts.agents} / ${data.counts.skills} / ${data.counts.transactions}`,
            },
          ]}
        />
      )}
    </Section>
  );
}
