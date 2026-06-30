"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, CheckCircle2, XCircle, QrCode, ArrowLeft } from "lucide-react";
import { validateParentOrigin } from "../_lib/parent-origin";

type PaymentType = "qris" | "gopay" | "bank_transfer";

type ChargeResponse = {
  transactionId: string;
  order_id?: string;
  transaction_id?: string;
  status_code?: string;
  actions?: { name: string; method: string; url: string }[];
  qr_string?: string;
  va_numbers?: { bank: string; va_number: string }[];
};

type TxSnapshot = {
  id: string;
  type: string;
  status: string;
  description: string;
  amountRp: number;
  energyDelta: number;
  sku: string | null;
  installedAt: string | null;
  lastInstallError: string | null;
};

// Every popup kind maps the gateway status it's waiting for to fire the
// "settled" message and auto-close. Topup + subscription are done when the
// transaction hits "completed"; skill installs keep going until the backend
// re-confirms as "installed".
export type SettleWhen = "completed" | "installed";

export type CheckoutProduct = {
  title: string;
  subtitle?: string;
  priceRp: number;
  // Message payload that the parent (Lit UI) will see on success. Must stay
  // non-sensitive — parent uses it to refresh its local caches.
  kind: "skill" | "topup" | "subscription";
  // Extra kind-specific fields the parent may care about.
  meta?: Record<string, string | number | null>;
};

export type PopupCheckoutProps = {
  product: CheckoutProduct;
  settleWhen: SettleWhen;
  // Initiate payment. Accepts the chosen payment type and returns the
  // charge + transactionId.
  initiate: (paymentType: PaymentType) => Promise<ChargeResponse>;
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60_000;

function formatRp(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

export function PopupCheckout(props: PopupCheckoutProps) {
  const { product, settleWhen, initiate } = props;
  const [paymentType, setPaymentType] = useState<PaymentType>("qris");
  const [phase, setPhase] = useState<
    "pick" | "charging" | "await-payment" | "settled" | "error" | "expired"
  >("pick");
  const [charge, setCharge] = useState<ChargeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTx] = useState<TxSnapshot | null>(null);
  const parentOriginRef = useRef<string | null>(null);

  useEffect(() => {
    // Resolve + freeze the parent origin from URL query once.
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    parentOriginRef.current = validateParentOrigin(u.searchParams.get("parent"));
  }, []);

  const postToParent = (payload: Record<string, unknown>) => {
    const origin = parentOriginRef.current;
    if (!origin) return;
    try {
      window.opener?.postMessage({ source: "agentbuff-billing", ...payload }, origin);
    } catch {
      /* opener closed */
    }
  };

  // Poll once we have a transactionId — drives the settled state.
  useEffect(() => {
    if (phase !== "await-payment" || !charge?.transactionId) return;

    let cancelled = false;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const tick = async () => {
      if (cancelled) return;
      // Deadline reached without settlement → surface an actionable "expired"
      // state instead of leaving the spinner running forever.
      if (Date.now() > deadline) {
        setPhase("expired");
        return;
      }
      try {
        const r = await fetch(`/api/billing/transactions/${charge.transactionId}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (r.ok) {
          const snap = (await r.json()) as TxSnapshot;
          if (cancelled) return;
          setTx(snap);
          const done =
            (settleWhen === "completed" &&
              (snap.status === "completed" || snap.status === "installed")) ||
            (settleWhen === "installed" && snap.status === "installed");
          const failed = snap.status === "failed" || snap.status === "install_failed";
          if (done) {
            setPhase("settled");
            postToParent({
              event: "billing:settled",
              kind: product.kind,
              transactionId: snap.id,
              sku: snap.sku,
              energyDelta: snap.energyDelta,
              meta: product.meta ?? null,
            });
            setTimeout(() => window.close(), 2500);
            return;
          }
          if (failed) {
            setPhase("error");
            setError(snap.lastInstallError ?? "Pembayaran gagal. Coba lagi ya.");
            return;
          }
        }
      } catch {
        /* transient — keep polling */
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };

    const timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, charge, settleWhen, product]);

  const handlePay = async () => {
    setPhase("charging");
    setError(null);
    try {
      const c = await initiate(paymentType);
      setCharge(c);
      setPhase("await-payment");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Gagal mulai pembayaran.");
    }
  };

  const handleCancel = () => {
    postToParent({ event: "billing:cancelled", kind: product.kind });
    window.close();
  };

  const qrisUrl = useMemo(() => {
    if (!charge?.actions) return null;
    const qr = charge.actions.find((a) => /qr/i.test(a.name));
    return qr?.url ?? null;
  }, [charge]);

  const vaNumber = charge?.va_numbers?.[0];
  const gopayDeeplink = charge?.actions?.find((a) => /deeplink/i.test(a.name))?.url;

  return (
    <div className="min-h-[440px] rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm p-6 space-y-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Image
            src="/images/logo.png"
            alt="AgentBuff"
            width={28}
            height={28}
            className="rounded"
          />
          <span className="text-sm font-display text-white/80">AgentBuff Billing</span>
        </div>
        {phase !== "settled" && (
          <button
            onClick={handleCancel}
            className="text-xs text-white/50 hover:text-white/80 inline-flex items-center gap-1"
            type="button"
          >
            <ArrowLeft className="size-3" />
            Batal
          </button>
        )}
      </header>

      <div className="space-y-1.5">
        <h1 className="text-lg font-display text-white">{product.title}</h1>
        {product.subtitle ? (
          <p className="text-sm text-white/60">{product.subtitle}</p>
        ) : null}
        <p className="text-2xl font-display bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">
          {formatRp(product.priceRp)}
        </p>
      </div>

      {phase === "pick" ? (
        <PaymentPicker value={paymentType} onChange={setPaymentType} onPay={handlePay} />
      ) : null}

      {phase === "charging" ? (
        <div className="flex flex-col items-center gap-2 py-6 text-white/60">
          <Loader2 className="size-6 animate-spin" />
          <span className="text-sm">Nyiapin instruksi bayar...</span>
        </div>
      ) : null}

      {phase === "await-payment" && charge ? (
        <div className="space-y-3">
          {qrisUrl ? (
            <div className="rounded-xl bg-white p-4 flex flex-col items-center gap-2">
              <Image
                src={qrisUrl}
                alt="QRIS code"
                width={240}
                height={240}
                unoptimized
              />
              <span className="text-xs text-black/60 flex items-center gap-1">
                <QrCode className="size-3" /> Scan pakai GoPay / OVO / DANA / ShopeePay
              </span>
            </div>
          ) : null}

          {gopayDeeplink ? (
            <a
              href={gopayDeeplink}
              target="_blank"
              rel="noreferrer"
              className="block w-full rounded-xl bg-emerald-500/90 text-white text-center py-3 font-display"
            >
              Buka GoPay
            </a>
          ) : null}

          {vaNumber ? (
            <div className="rounded-xl border border-white/10 p-3 text-sm">
              <div className="text-white/50 text-xs mb-1">Transfer ke Virtual Account</div>
              <div className="flex items-center justify-between">
                <span className="font-display">{vaNumber.bank.toUpperCase()}</span>
                <span className="font-mono text-cyan-300">{vaNumber.va_number}</span>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2 justify-center text-xs text-white/50">
            <Loader2 className="size-3 animate-spin" />
            <span>Nunggu pembayaran kamu...</span>
          </div>
        </div>
      ) : null}

      {phase === "settled" ? (
        <div className="flex flex-col items-center gap-2 py-6 text-emerald-300">
          <CheckCircle2 className="size-8" />
          <span className="text-sm">Sukses! Popup nutup otomatis...</span>
        </div>
      ) : null}

      {phase === "error" ? (
        <div className="flex flex-col items-center gap-2 py-4 text-red-300 text-center">
          <XCircle className="size-8" />
          <span className="text-sm">{error}</span>
          <button
            onClick={() => {
              setPhase("pick");
              setError(null);
              setCharge(null);
            }}
            type="button"
            className="mt-2 text-xs text-white/70 underline underline-offset-2"
          >
            Coba lagi
          </button>
        </div>
      ) : null}

      {phase === "expired" ? (
        <div className="flex flex-col items-center gap-2 py-4 text-amber-300 text-center">
          <XCircle className="size-8" />
          <span className="text-sm">
            Pesanan kedaluwarsa. Ulangi pembayaran ya.
          </span>
          <button
            onClick={() => {
              setPhase("pick");
              setError(null);
              setCharge(null);
              setTx(null);
            }}
            type="button"
            className="mt-2 text-xs text-white/70 underline underline-offset-2"
          >
            Ulangi
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PaymentPicker({
  value,
  onChange,
  onPay,
}: {
  value: PaymentType;
  onChange: (v: PaymentType) => void;
  onPay: () => void;
}) {
  const options: { id: PaymentType; label: string; sub: string }[] = [
    { id: "qris", label: "QRIS", sub: "GoPay · OVO · DANA · ShopeePay" },
    { id: "gopay", label: "GoPay", sub: "Deeplink ke app" },
    { id: "bank_transfer", label: "Transfer Bank", sub: "BCA Virtual Account" },
  ];
  return (
    <div className="space-y-3">
      <div className="space-y-2" role="radiogroup" aria-label="Metode pembayaran">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={`w-full text-left rounded-xl border p-3 transition ${
              value === o.id
                ? "border-cyan-400/60 bg-cyan-400/10"
                : "border-white/10 bg-white/[0.02] hover:border-white/20"
            }`}
          >
            <div className="text-sm font-display">{o.label}</div>
            <div className="text-xs text-white/50">{o.sub}</div>
          </button>
        ))}
      </div>
      <button
        onClick={onPay}
        type="button"
        className="w-full rounded-xl bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-500 text-[#0B0E14] font-display py-3"
      >
        Bayar Sekarang
      </button>
    </div>
  );
}
