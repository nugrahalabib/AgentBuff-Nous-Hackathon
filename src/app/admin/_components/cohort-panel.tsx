"use client";

import { LineChart } from "lucide-react";
import {
  useAdminQuery,
  Section,
  DataTable,
  Badge,
  EmptyState,
  errorToBahasa,
  type Column,
  type Tone,
} from "./ui";

// D2 — subscription retention cohort grid (by start month). Read-only.
type Cohort = { month: string; total: number; active: number; retentionPct: number };
type Resp = { cohorts: Cohort[] };

function retTone(pct: number): Tone {
  if (pct >= 70) return "ok";
  if (pct >= 40) return "warn";
  return "bad";
}

const columns: Column<Cohort>[] = [
  {
    key: "month",
    header: "Bulan mulai",
    cell: (c) => <span className="font-mono text-zinc-300">{c.month}</span>,
  },
  {
    key: "total",
    header: "Total",
    align: "right",
    cell: (c) => <span className="tabular-nums text-zinc-400">{c.total}</span>,
  },
  {
    key: "active",
    header: "Masih aktif",
    align: "right",
    cell: (c) => <span className="tabular-nums text-zinc-400">{c.active}</span>,
  },
  {
    key: "retentionPct",
    header: "Retensi",
    align: "right",
    cell: (c) => <Badge tone={retTone(c.retentionPct)}>{c.retentionPct}%</Badge>,
  },
];

export function CohortPanel() {
  const { data, isLoading, error } = useAdminQuery<Resp>(["admin", "cohort"], "/api/admin/metrics/cohort");

  const cohorts = data?.cohorts ?? [];

  return (
    <Section
      title="Cohort retensi langganan"
      desc="Langganan dikelompokkan per bulan mulai — berapa yang masih aktif (proxy retensi sederhana, bukan per-periode penuh)."
    >
      {error ? (
        <EmptyState
          icon={<LineChart className="size-8" />}
          title="Gagal memuat cohort"
          body={errorToBahasa(error)}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={cohorts}
          rowKey={(c) => c.month}
          isLoading={isLoading}
          empty={
            <EmptyState
              icon={<LineChart className="size-8" />}
              title="Belum ada langganan"
              body="Cohort akan muncul setelah ada langganan pertama yang tercatat."
            />
          }
        />
      )}
    </Section>
  );
}
