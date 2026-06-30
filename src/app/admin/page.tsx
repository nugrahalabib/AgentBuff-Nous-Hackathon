import type { ReactNode } from "react";
import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { CheckCircle2, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { Badge, EmptyState, Section, TabIntro, type Tone } from "./_components/ui";

export const dynamic = "force-dynamic";

// Ambang "butuh perhatian" — angka di atas ini menyalakan border + dot pada kartu.
const ATTENTION_THRESHOLDS = {
  pendingTx: 0,
  newLeads: 0,
} as const;

async function n(query: Promise<{ c: number }[]>): Promise<number> {
  const [row] = await query;
  return row?.c ?? 0;
}

type MetricCardProps = {
  label: string;
  value: number;
  hint: string;
  href: string;
  ariaLabel: string;
  attention?: Tone;
};

function MetricCard({ label, value, hint, href, ariaLabel, attention }: MetricCardProps) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      title={hint}
      className={cn(
        "group relative flex flex-col rounded-xl border bg-zinc-900/40 p-4 transition-colors",
        "hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
        attention === "warn" && "border-amber-500/40 hover:border-amber-500/60",
        attention === "info" && "border-cyan-500/40 hover:border-cyan-500/60",
        !attention && "border-zinc-800",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-zinc-500">
          {attention && (
            <span
              className={cn(
                "size-1.5 rounded-full",
                attention === "warn" ? "bg-amber-500" : "bg-cyan-500",
              )}
            />
          )}
          {label}
        </span>
        <ArrowUpRight className="size-3.5 text-zinc-600 transition-colors group-hover:text-cyan-400" />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
        {value.toLocaleString("id-ID")}
      </div>
      <div className="mt-1 text-[11px] text-zinc-600">{hint}</div>
      <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-700 transition-colors group-hover:text-zinc-500">
        Klik untuk lihat daftar
      </div>
    </Link>
  );
}

type AttentionItem = {
  tone: Tone;
  text: ReactNode;
  href: string;
  cta: string;
};

export default async function AdminDashboardPage() {
  const [users, activeSubs, activeTrials, runningContainers, pendingTx, newLeads] =
    await Promise.all([
      n(db.select({ c: count() }).from(schema.users)),
      n(
        db
          .select({ c: count() })
          .from(schema.subscriptions)
          .where(eq(schema.subscriptions.status, "active")),
      ),
      n(
        db
          .select({ c: count() })
          .from(schema.userTrials)
          .where(eq(schema.userTrials.status, "active")),
      ),
      n(
        db
          .select({ c: count() })
          .from(schema.userContainers)
          .where(eq(schema.userContainers.status, "running")),
      ),
      n(
        db
          .select({ c: count() })
          .from(schema.transactions)
          .where(eq(schema.transactions.status, "pending")),
      ),
      n(
        db
          .select({ c: count() })
          .from(schema.earlyAccessLeads)
          .where(eq(schema.earlyAccessLeads.status, "new")),
      ),
    ]);

  const cards: MetricCardProps[] = [
    {
      label: "Total pengguna",
      value: users,
      hint: "Semua akun terdaftar",
      href: "/admin/pengguna",
      ariaLabel: `Total pengguna: ${users}, buka daftar`,
    },
    {
      label: "Langganan aktif",
      value: activeSubs,
      hint: "status = active",
      href: "/admin/langganan?status=active",
      ariaLabel: `Langganan aktif: ${activeSubs}, buka daftar`,
    },
    {
      label: "Trial aktif",
      value: activeTrials,
      hint: "14 hari berjalan",
      href: "/admin/langganan?tab=trial&status=active",
      ariaLabel: `Trial aktif: ${activeTrials}, buka daftar`,
    },
    {
      label: "Kontainer running",
      value: runningContainers,
      hint: "Engine hidup",
      href: "/admin/kontainer?status=running",
      ariaLabel: `Kontainer running: ${runningContainers}, buka daftar`,
    },
    {
      label: "Transaksi pending",
      value: pendingTx,
      hint: "Menunggu webhook",
      href: "/admin/transaksi?status=pending",
      ariaLabel: `Transaksi pending: ${pendingTx}, buka daftar`,
      attention: pendingTx > ATTENTION_THRESHOLDS.pendingTx ? "warn" : undefined,
    },
    {
      label: "Lead baru",
      value: newLeads,
      hint: "Early-access belum dihubungi",
      href: "/admin/marketing?status=new",
      ariaLabel: `Lead baru: ${newLeads}, buka daftar`,
      attention: newLeads > ATTENTION_THRESHOLDS.newLeads ? "info" : undefined,
    },
  ];

  const attention: AttentionItem[] = [];
  if (pendingTx > ATTENTION_THRESHOLDS.pendingTx) {
    attention.push({
      tone: "warn",
      text: `${pendingTx.toLocaleString("id-ID")} transaksi pending menunggu rekonsiliasi`,
      href: "/admin/transaksi?status=pending",
      cta: "Tinjau",
    });
  }
  if (newLeads > ATTENTION_THRESHOLDS.newLeads) {
    attention.push({
      tone: "info",
      text: `${newLeads.toLocaleString("id-ID")} lead baru belum dihubungi`,
      href: "/admin/marketing?status=new",
      cta: "Buka",
    });
  }

  return (
    <div>
      <TabIntro
        eyebrow="Dasbor"
        title="Ringkasan"
        what="Foto cepat kondisi platform hari ini — angka langsung dari database, diperbarui tiap halaman dibuka."
        canDo={[
          "Lihat 6 angka kunci sekilas (pengguna, langganan, trial, kontainer, transaksi, lead).",
          "Klik kartu mana pun untuk lompat ke daftar lengkapnya.",
          "Cek 'Perlu perhatian' untuk hal yang butuh ditindak sekarang.",
        ]}
        how="Scan dari kiri-atas. Angka berwarna kuning/merah berarti ada yang minta ditengok — klik kartunya untuk menindak."
        legend={[
          { tone: "warn", label: "Transaksi pending" },
          { tone: "info", label: "Lead baru" },
        ]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {cards.map((c) => (
          <MetricCard key={c.label} {...c} />
        ))}
      </div>

      <Section
        title="Perlu perhatian"
        desc="Daftar singkat hal yang butuh kamu tindak sekarang."
        className="mt-6"
      >
        {attention.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="size-8 text-emerald-500/70" />}
            title="Semua aman"
            body="Tidak ada yang minta perhatian saat ini."
          />
        ) : (
          <ul className="space-y-2">
            {attention.map((a, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
              >
                <span className="flex items-center gap-2 text-sm text-zinc-300">
                  <Badge tone={a.tone}>{a.tone === "warn" ? "Penting" : "Info"}</Badge>
                  {a.text}
                </span>
                <Link
                  href={a.href}
                  className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:border-cyan-500/60 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
                >
                  {a.cta}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
