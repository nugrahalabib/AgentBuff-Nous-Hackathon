"use client";

import { CalendarClock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useAdminQuery,
  Section,
  Badge,
  StatusBadge,
  EmptyState,
  DataTable,
  fmtDate,
  errorToBahasa,
  TIERS,
  type Column,
  type StatusMap,
  type Tone,
} from "./ui";

// D2 — subscription expiry calendar panel. Day-bucket counts + the soonest list,
// for renewal outreach. Read-only (admin/support) — a monitor surface, not an
// action surface, so no mutations / confirm dialogs live here.
type Soon = {
  email: string | null;
  tier: string;
  billingCycle: string;
  expiresAt: string;
  days: number;
};
type Resp = {
  total: number;
  buckets: { overdue: number; today: number; in7: number; in30: number; later: number };
  soonest: Soon[];
};

const BUCKETS: { key: keyof Resp["buckets"]; label: string; tone: Tone }[] = [
  { key: "overdue", label: "Lewat", tone: "bad" },
  { key: "today", label: "Hari ini", tone: "warn" },
  { key: "in7", label: "≤ 7 hari", tone: "warn" },
  { key: "in30", label: "≤ 30 hari", tone: "info" },
  { key: "later", label: "> 30 hari", tone: "muted" },
];

// Tier label/tone map for StatusBadge, derived from the shared TIERS enum so
// labels never drift from the rest of the admin surface.
const TIER_MAP: StatusMap = Object.fromEntries(
  TIERS.map((t) => [t.value, { tone: t.tone ?? "muted", label: t.label }]),
);

const BUCKET_NUM: Record<Tone, string> = {
  bad: "text-red-300",
  warn: "text-amber-300",
  info: "text-cyan-300",
  ok: "text-emerald-300",
  muted: "text-zinc-300",
};

const BILLING_LABEL: Record<string, string> = {
  monthly: "Bulanan",
  yearly: "Tahunan",
};

function daysTone(days: number): Tone {
  if (days < 0) return "bad";
  if (days <= 7) return "warn";
  if (days <= 30) return "info";
  return "muted";
}

function daysLabel(days: number): string {
  if (days < 0) return `Lewat ${Math.abs(days)}h`;
  if (days === 0) return "Hari ini";
  return `${days}h lagi`;
}

function BucketCard({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-center">
      <div className={cn("text-xl font-semibold tabular-nums", BUCKET_NUM[tone])}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

const COLUMNS: Column<Soon>[] = [
  {
    key: "days",
    header: "Sisa waktu",
    cell: (s) => <Badge tone={daysTone(s.days)}>{daysLabel(s.days)}</Badge>,
    align: "left",
    className: "whitespace-nowrap",
  },
  {
    key: "email",
    header: "Pengguna",
    cell: (s) => <span className="text-zinc-200">{s.email ?? "—"}</span>,
  },
  {
    key: "tier",
    header: "Tier",
    cell: (s) => <StatusBadge value={s.tier} map={TIER_MAP} />,
  },
  {
    key: "billingCycle",
    header: "Siklus",
    cell: (s) => (
      <span className="text-zinc-400">{BILLING_LABEL[s.billingCycle] ?? s.billingCycle}</span>
    ),
  },
  {
    key: "expiresAt",
    header: "Kadaluarsa",
    cell: (s) => <span className="text-zinc-400">{fmtDate(s.expiresAt)}</span>,
    align: "right",
  },
];

export function ExpiryPanel() {
  const { data, isLoading, isError, error } = useAdminQuery<Resp>(
    ["admin", "expiry"],
    "/api/admin/metrics/expiry",
  );

  const totalAttention = data ? data.buckets.overdue + data.buckets.today + data.buckets.in7 : 0;

  return (
    <Section
      title="Kalender kadaluarsa langganan"
      desc="Pantau langganan aktif berdasarkan sisa hari sampai kadaluarsa untuk merencanakan ajakan perpanjangan."
      actions={
        data ? (
          <Badge tone="muted">{data.total} langganan aktif</Badge>
        ) : undefined
      }
    >
      {isError ? (
        <EmptyState
          icon={<AlertTriangle className="size-8 text-red-400" />}
          title="Gagal memuat kalender"
          body={errorToBahasa(error)}
        />
      ) : (
        <div className="space-y-4">
          {totalAttention > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {totalAttention} langganan butuh perhatian (lewat, hari ini, atau ≤ 7 hari).
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {BUCKETS.map((b) => (
              <BucketCard
                key={b.key}
                label={b.label}
                value={data?.buckets[b.key] ?? 0}
                tone={b.tone}
              />
            ))}
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Paling dekat berakhir
            </div>
            <DataTable<Soon>
              columns={COLUMNS}
              rows={data?.soonest ?? []}
              rowKey={(s) => `${s.email ?? "anon"}-${s.expiresAt}`}
              isLoading={isLoading}
              empty={
                <EmptyState
                  icon={<CalendarClock className="size-8" />}
                  title="Belum ada langganan aktif"
                  body="Saat ada langganan aktif, yang paling dekat kadaluarsa akan muncul di sini."
                />
              }
            />
          </div>
        </div>
      )}
    </Section>
  );
}
