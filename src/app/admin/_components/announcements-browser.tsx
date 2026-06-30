"use client";

import { useState } from "react";
import { AlertTriangle, Send } from "lucide-react";
import {
  apiFetch,
  fmtDateTime,
  Badge,
  Section,
  FormRow,
  Select,
  Toggle,
  DataTable,
  EmptyState,
  ConfirmDialog,
  useAdminQuery,
  useAdminMutation,
  type Column,
  type Option,
} from "./ui";

type Ann = {
  id: string;
  message: string;
  tab: string;
  audience: string;
  highPriority: boolean;
  recipientCount: number;
  createdAt: string;
};
type Resp = { rows: Ann[] };
type SendResp = { ok: true; recipients: number };

// Enums grounded in src/app/api/admin/announcements/route.ts (TABS, AUDIENCES).
// Values stay the raw server enum; labels are operator-friendly Bahasa.
const TAB_OPTIONS: Option[] = [
  { value: "chat", label: "Chat", hint: "Tab chat utama" },
  { value: "billing", label: "Tagihan", hint: "Tab tagihan / langganan" },
  { value: "skills", label: "Skill / Item", hint: "Tab marketplace skill" },
  { value: "channels", label: "Saluran", hint: "Tab saluran (WA/TG/dll)" },
  { value: "system", label: "Sistem", hint: "Pengumuman umum / maintenance" },
];

const AUDIENCE_OPTIONS: Option[] = [
  { value: "all", label: "Semua user", hint: "Seluruh akun terdaftar" },
  { value: "onboarded", label: "Sudah onboarding", hint: "Sudah selesai onboarding" },
  { value: "trial", label: "Trial aktif", hint: "Masih dalam masa trial 14 hari" },
  { value: "subscribed", label: "Berlangganan", hint: "Langganan status aktif" },
];

const MSG_MAX = 500;
const LABEL_MAX = 60;
const HREF_MAX = 300;

function friendlyTab(v: string): string {
  return TAB_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
function friendlyAudience(v: string): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

export function AnnouncementsBrowser() {
  const { data, isLoading } = useAdminQuery<Resp>(
    ["admin", "announcements"],
    "/api/admin/announcements",
  );

  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("chat");
  const [audience, setAudience] = useState("all");
  const [highPriority, setHighPriority] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [actionHref, setActionHref] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Action button must be both-or-neither (plan: "label tanpa link = tombol mati").
  const labelTrimmed = actionLabel.trim();
  const hrefTrimmed = actionHref.trim();
  const actionPartial = (labelTrimmed.length > 0) !== (hrefTrimmed.length > 0);
  const canSend = message.trim().length > 0 && !actionPartial;

  const send = useAdminMutation<void, SendResp>(
    () =>
      apiFetch<SendResp>("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          tab,
          audience,
          highPriority,
          actionLabel: labelTrimmed || undefined,
          actionHref: hrefTrimmed || undefined,
        }),
      }),
    {
      successMessage: (r) =>
        `Terkirim ke ${r.recipients.toLocaleString("id-ID")} user.`,
      invalidate: [["admin", "announcements"]],
      onSuccess: () => {
        // Only reset on success — on error, keep the form filled for retry.
        setMessage("");
        setActionLabel("");
        setActionHref("");
        setConfirmOpen(false);
      },
      onError: () => setConfirmOpen(false),
    },
  );

  const charTone =
    message.length >= MSG_MAX
      ? "text-red-400"
      : message.length >= MSG_MAX - 50
        ? "text-amber-400"
        : "text-zinc-500";

  const columns: Column<Ann>[] = [
    {
      key: "createdAt",
      header: "Waktu",
      align: "left",
      className: "whitespace-nowrap text-zinc-500",
      cell: (a) => fmtDateTime(a.createdAt),
    },
    {
      key: "message",
      header: "Pesan",
      cell: (a) => (
        <div className="min-w-0">
          <span className="block max-w-md truncate text-zinc-300" title={a.message}>
            {a.message}
          </span>
          {a.highPriority ? (
            <span className="mt-0.5 inline-block">
              <Badge tone="warn">prioritas</Badge>
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "audience",
      header: "Audiens",
      cell: (a) => <span className="text-zinc-400">{friendlyAudience(a.audience)}</span>,
    },
    {
      key: "tab",
      header: "Tab",
      cell: (a) => <span className="text-zinc-500">{friendlyTab(a.tab)}</span>,
    },
    {
      key: "recipientCount",
      header: "Penerima",
      align: "right",
      className: "tabular-nums text-zinc-300",
      cell: (a) => a.recipientCount.toLocaleString("id-ID"),
    },
  ];

  return (
    <Section
      title="Pengumuman (Broadcast)"
      desc="Kirim notifikasi in-app ke sekelompok user sekaligus — muncul di lonceng notif mereka."
    >
      <div className="space-y-6">
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Broadcast tidak bisa ditarik. Sekali terkirim, notifikasi sudah masuk
            inbox tiap user.
          </span>
        </div>

        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <FormRow
            label="Pesan"
            required
            help="Tampil persis seperti di lonceng notif user."
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MSG_MAX))}
              rows={3}
              maxLength={MSG_MAX}
              placeholder="Pesan pengumuman… (muncul sebagai notifikasi in-app)"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
            <div className={`text-right text-[11px] tabular-nums ${charTone}`}>
              {message.length}/{MSG_MAX}
            </div>
          </FormRow>

          <FormRow
            label="Tombol aksi (opsional)"
            help="Isi keduanya atau kosongkan keduanya. Label tanpa link = tombol mati."
            error={actionPartial ? "Lengkapi label dan link tombol." : undefined}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={actionLabel}
                onChange={(e) => setActionLabel(e.target.value.slice(0, LABEL_MAX))}
                maxLength={LABEL_MAX}
                placeholder="Label tombol (mis. Lihat detail)"
                className="min-w-[12ch] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
              <input
                value={actionHref}
                onChange={(e) => setActionHref(e.target.value.slice(0, HREF_MAX))}
                maxLength={HREF_MAX}
                placeholder="Link tombol (mis. /app/shop)"
                className="min-w-[12ch] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
              />
            </div>
          </FormRow>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Tab tujuan" help="Di tab mana notif ini nongol saat user buka app.">
              <Select value={tab} onChange={setTab} options={TAB_OPTIONS} />
            </FormRow>
            <FormRow
              label="Audiens"
              help="Trial aktif = masih dalam 14 hari. Berlangganan = status aktif."
            >
              <Select value={audience} onChange={setAudience} options={AUDIENCE_OPTIONS} />
            </FormRow>
          </div>

          <FormRow
            label="Prioritas tinggi"
            help="Aktif = notif ditandai penting. Pakai untuk hal mendesak saja."
          >
            <Toggle
              checked={highPriority}
              onChange={setHighPriority}
              label={highPriority ? "Ditandai penting" : "Normal"}
            />
          </FormRow>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              disabled={send.isPending || !canSend}
              onClick={() => setConfirmOpen(true)}
              className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              <Send className="size-3.5" />
              {send.isPending ? "Mengirim…" : "Kirim broadcast"}
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-zinc-300">Riwayat broadcast</div>
          <DataTable<Ann>
            columns={columns}
            rows={data?.rows ?? []}
            rowKey={(a) => a.id}
            isLoading={isLoading}
            empty={<EmptyState title="Belum ada broadcast." body="Broadcast yang kamu kirim akan tercatat di sini." />}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => send.mutate()}
        loading={send.isPending}
        title="Kirim broadcast?"
        body="Sekali kirim, langsung masuk inbox semua penerima. Tidak bisa dibatalkan."
        confirmLabel="Kirim sekarang"
        summary={[
          { label: "Audiens", value: friendlyAudience(audience) },
          { label: "Tab tujuan", value: friendlyTab(tab) },
          {
            label: "Prioritas",
            value: highPriority ? "Tinggi" : "Normal",
            tone: highPriority ? "warn" : "muted",
          },
          ...(labelTrimmed ? [{ label: "Tombol", value: labelTrimmed }] : []),
        ]}
      />
    </Section>
  );
}
