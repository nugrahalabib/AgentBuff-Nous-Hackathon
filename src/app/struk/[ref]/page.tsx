import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getStripeReceiptUrl } from "@/lib/hack/stripe";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

// Server component — locale comes from the ?lang= query param (the in-chat card
// links here with the user's current locale), since localStorage isn't readable
// server-side. Defaults to "id".
type Locale = "id" | "en";

const STR = {
  id: {
    notFound: "Struk tidak ditemukan",
    notFoundDesc: (ref: string) => `Nomor pesanan ${ref} tidak ada.`,
    back: "← Kembali ke Chat",
    title: "Bukti Pembayaran",
    paid: "Lunas",
    orderNo: "No. Pesanan",
    date: "Tanggal",
    customer: "Pelanggan",
    itemSub: "Skill marketplace · BuffHub · 1×",
    subtotal: "Subtotal",
    tax: "Pajak",
    totalPaid: "TOTAL DIBAYAR",
    method: "Metode Pembayaran",
    methodValue: "Kartu (Visa) · via Stripe",
    ref: "Ref Pembayaran",
    stripeLink: "Lihat bukti resmi di Stripe →",
    thanks: "Terima kasih sudah berbelanja di BuffHub 🙏",
    secured: "Pembayaran diproses aman oleh Stripe · AgentBuff",
    print: "Cetak / Simpan PDF",
  },
  en: {
    notFound: "Receipt not found",
    notFoundDesc: (ref: string) => `Order number ${ref} does not exist.`,
    back: "← Back to Chat",
    title: "Payment Receipt",
    paid: "Paid",
    orderNo: "Order No.",
    date: "Date",
    customer: "Customer",
    itemSub: "Marketplace skill · BuffHub · 1×",
    subtotal: "Subtotal",
    tax: "Tax",
    totalPaid: "TOTAL PAID",
    method: "Payment Method",
    methodValue: "Card (Visa) · via Stripe",
    ref: "Payment Ref",
    stripeLink: "View official receipt on Stripe →",
    thanks: "Thanks for shopping at BuffHub 🙏",
    secured: "Payment securely processed by Stripe · AgentBuff",
    print: "Print / Save PDF",
  },
} as const;

function rp(n: number): string {
  return `Rp ${Math.max(0, Math.round(n || 0)).toLocaleString("id-ID")}`;
}
function fmtDate(d: Date | string | null, locale: Locale): string {
  if (!d) return "—";
  return (
    new Date(d).toLocaleString(locale === "en" ? "en-GB" : "id-ID", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }) + " WIB"
  );
}

export default async function StrukPage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { ref } = await params;
  const { lang } = await searchParams;
  const locale: Locale = lang === "en" ? "en" : "id";
  const S = STR[locale];

  const [tx] = await db
    .select({
      userId: schema.transactions.userId,
      amountRp: schema.transactions.amountRp,
      status: schema.transactions.status,
      sku: schema.transactions.sku,
      paymentRef: schema.transactions.paymentRef,
      paymentMethod: schema.transactions.paymentMethod,
      paidAt: schema.transactions.paidAt,
      orderId: schema.transactions.midtransOrderId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.midtransOrderId, ref))
    .limit(1);

  if (!tx) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0B0E14] p-6 text-white/70">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
          <p className="text-[15px] font-semibold text-white/90">{S.notFound}</p>
          <p className="mt-1 text-[13px] text-white/50">{S.notFoundDesc(ref)}</p>
        </div>
      </main>
    );
  }

  const [buyer] = await db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, tx.userId))
    .limit(1);
  const [item] = await db
    .select({ title: schema.skillCatalog.title })
    .from(schema.skillCatalog)
    .where(eq(schema.skillCatalog.key, tx.sku ?? ""))
    .limit(1);

  const stripeReceiptUrl = tx.paymentRef ? await getStripeReceiptUrl(tx.paymentRef) : null;

  const name = item?.title ?? tx.sku ?? "Skill BuffHub";
  const buyerName = buyer?.name?.trim() || buyer?.email?.split("@")[0] || "Pengguna AgentBuff";
  const amount = tx.amountRp ?? 0;

  return (
    <main className="receipt-page min-h-screen bg-[#0B0E14] px-4 py-10">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .receipt-page { background: #fff !important; padding: 0 !important; }
          .receipt-card { box-shadow: none !important; border: none !important; margin: 0 !important; }
        }
      `}</style>

      <div className="mx-auto mb-5 flex max-w-[480px] items-center justify-between gap-3 no-print">
        <a href="/app/chat" className="text-[13px] text-white/55 transition-colors hover:text-white/90">
          {S.back}
        </a>
        <PrintButton label={S.print} />
      </div>

      <article className="receipt-card mx-auto max-w-[480px] overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <header className="relative overflow-hidden bg-gradient-to-r from-cyan-500 via-indigo-600 to-fuchsia-600 px-7 py-6 text-white">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/70">AgentBuff · BuffHub</div>
              <h1 className="mt-1 text-[20px] font-bold leading-tight">{S.title}</h1>
            </div>
            <span className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ring-white/30">
              {S.paid}
            </span>
          </div>
        </header>

        {/* Body */}
        <div className="px-7 py-6 text-[#0B0E14]">
          <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
            <dt className="text-zinc-400">{S.orderNo}</dt>
            <dd className="text-right font-mono text-[12px] text-zinc-700">{tx.orderId}</dd>
            <dt className="text-zinc-400">{S.date}</dt>
            <dd className="text-right text-zinc-700">{fmtDate(tx.paidAt, locale)}</dd>
            <dt className="text-zinc-400">{S.customer}</dt>
            <dd className="text-right font-medium text-zinc-800">{buyerName}</dd>
          </dl>

          <div className="my-5 border-t border-dashed border-zinc-200" />

          {/* Item */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-zinc-900">{name}</p>
              <p className="text-[12px] text-zinc-400">{S.itemSub}</p>
            </div>
            <p className="shrink-0 text-[15px] font-semibold text-zinc-900">{rp(amount)}</p>
          </div>

          <div className="my-5 border-t border-zinc-200" />

          <div className="flex items-center justify-between">
            <span className="text-[13px] text-zinc-500">{S.subtotal}</span>
            <span className="text-[13px] text-zinc-700">{rp(amount)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[13px] text-zinc-500">{S.tax}</span>
            <span className="text-[13px] text-zinc-700">Rp 0</span>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-3">
            <span className="text-[14px] font-bold text-zinc-900">{S.totalPaid}</span>
            <span className="text-[18px] font-bold text-emerald-600">{rp(amount)}</span>
          </div>

          {/* Payment */}
          <div className="mt-6 rounded-xl border border-zinc-100 bg-zinc-50/60 px-4 py-3 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">{S.method}</span>
              <span className="font-medium text-zinc-700">{S.methodValue}</span>
            </div>
            {tx.paymentRef ? (
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <span className="text-zinc-400">{S.ref}</span>
                <span className="truncate font-mono text-[11px] text-zinc-600">{tx.paymentRef}</span>
              </div>
            ) : null}
          </div>

          {stripeReceiptUrl ? (
            <a
              href={stripeReceiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="no-print mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-[12.5px] font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              {S.stripeLink}
            </a>
          ) : null}
        </div>

        {/* Footer */}
        <footer className="border-t border-zinc-100 bg-zinc-50 px-7 py-4 text-center">
          <p className="text-[12px] text-zinc-500">{S.thanks}</p>
          <p className="mt-0.5 text-[11px] text-zinc-400">{S.secured}</p>
        </footer>
      </article>
    </main>
  );
}
