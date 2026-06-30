"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { signIn } from "next-auth/react";
import {
  Crown,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Check,
} from "lucide-react";
import { formatRp, type BillingCycle } from "@/lib/billing/plans";
import { addCalendarPeriod } from "@/lib/billing/period";
import { validateParentOrigin } from "@/app/billing/_lib/parent-origin";

const IS_PROD = process.env.NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION === "true";
const SNAP_JS_URL = IS_PROD
  ? "https://app.midtrans.com/snap/snap.js"
  : "https://app.sandbox.midtrans.com/snap/snap.js";
const CLIENT_KEY = process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY ?? "";

const POLL_MS = 3000;
const POLL_DEADLINE_MS = 10 * 60_000;

const PERKS = [
  "Engine AgentBuff hosted 24/7",
  "Agen tanpa batas + semua skill premium",
  "Semua channel (WhatsApp, Telegram, dll)",
  "Pakai API key & model kamu sendiri (BYOK)",
];

type Phase =
  | "idle"
  | "starting"
  | "embed"
  | "settling"
  | "done"
  | "error"
  | "expired";

export function CheckoutClient({
  isAuthed,
  initialCycle,
  currentTier,
  currentStatus,
  currentExpiresAt,
  priceMonthly,
  priceYearly,
}: {
  isAuthed: boolean;
  initialCycle: BillingCycle;
  /** Resolved current tier (server-side). null for guests. */
  currentTier: "starter" | "op_buff" | "guild_master" | null;
  /** Resolved subscription status (server-side). null for guests. */
  currentStatus: "active" | "starter_default" | "expired" | "canceled" | null;
  /** ISO expiry of the current sub, when any. Drives the renewal preview. */
  currentExpiresAt: string | null;
  /** Admin-effective OP Buff prices (server-resolved). The amount sent as
   *  expectedPriceRp so the charge can reject a mid-session admin change. */
  priceMonthly: number;
  priceYearly: number;
}) {
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [snapReady, setSnapReady] = useState(false);
  const [snapLoadFailed, setSnapLoadFailed] = useState(false);
  const [embedToken, setEmbedToken] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [settlingElapsed, setSettlingElapsed] = useState(0);
  // Captured on the client only — the reset-mode preview (now + 1 period) must
  // not be computed during SSR or it can mismatch on hydration.
  const [nowMs, setNowMs] = useState<number | null>(null);
  // Seconds left on the post-success redirect to /app/riwayat (full-page flow).
  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // Transient hint shown in the settling card (e.g. rate-limited manual check).
  const [checkHint, setCheckHint] = useState<string | null>(null);
  // Promo coupon (preview-only; the charge re-validates + reserves it).
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountRp: number;
    finalRp: number;
  } | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);

  const parentOriginRef = useRef<string | null>(null);
  const settledRef = useRef(false);
  const txIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);
  const cancelledRef = useRef(false);
  const embeddedRef = useRef(false);
  const redirectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prices come from the server-resolved props (admin-effective), NOT the static
  // catalog — so display matches what the charge route will compute.
  const priceFor = (c: BillingCycle) => (c === "yearly" ? priceYearly : priceMonthly);
  const price = priceFor(cycle);
  const saveMonths =
    priceMonthly > 0 && priceYearly > 0
      ? Math.max(0, Math.round((priceMonthly * 12 - priceYearly) / priceMonthly))
      : 0;
  const elapsedLabel =
    settlingElapsed < 60
      ? `${settlingElapsed} detik`
      : `${Math.floor(settlingElapsed / 60)} menit`;

  // Checkout mode derived from the resolved sub state:
  //   enterprise  → already Guild Master; no self-serve OP Buff purchase.
  //   renewal     → active OP Buff; paying EXTENDS from the current expiry.
  //   reactivate  → lapsed (expired/canceled); paying RESETS from now.
  //   fresh       → starter / trial / guest; paying activates from now.
  const currentExpiryDate = currentExpiresAt ? new Date(currentExpiresAt) : null;
  // Once nowMs is captured (client), an active sub whose expiry has already
  // passed is treated as lapsed → reactivate (reset), matching what the backend
  // would actually write. Before nowMs (SSR) we trust the server's status.
  const expiryInFuture =
    currentExpiryDate !== null &&
    (nowMs === null || currentExpiryDate.getTime() > nowMs);
  const mode: "enterprise" | "renewal" | "reactivate" | "fresh" =
    currentTier === "guild_master"
      ? "enterprise"
      : currentStatus === "active" && currentTier === "op_buff" && expiryInFuture
        ? "renewal"
        : currentStatus === "expired" ||
            currentStatus === "canceled" ||
            (currentStatus === "active" &&
              currentTier === "op_buff" &&
              !expiryInFuture)
          ? "reactivate"
          : "fresh";

  // Expiry preview using the EXACT rule the backend settles with (period.ts):
  // renewal stacks on the current expiry (deterministic → SSR-safe); reset modes
  // count from `now` (client-only via nowMs → no hydration mismatch).
  const previewBase =
    mode === "renewal" && currentExpiryDate
      ? currentExpiryDate
      : nowMs !== null
        ? new Date(nowMs)
        : null;
  const previewExpiry = previewBase ? addCalendarPeriod(previewBase, cycle) : null;

  const titleText =
    mode === "renewal"
      ? "Perpanjang OP Buff"
      : mode === "reactivate"
        ? "Aktifkan Lagi OP Buff"
        : mode === "enterprise"
          ? "Kamu di Guild Master"
          : "Aktifkan OP Buff";
  const subtitleText =
    mode === "renewal"
      ? "Tambah masa aktif — lanjut carry tanpa putus."
      : mode === "reactivate"
        ? "Langganan kamu sudah berakhir. Aktifkan lagi yuk."
        : mode === "enterprise"
          ? "Paket kamu sudah lebih tinggi dari OP Buff."
          : "Buff lengkap buat hustler yang serius level up.";
  // What the user actually pays (coupon-discounted when applied).
  const payAmount = appliedCoupon ? appliedCoupon.finalRp : price;
  const payLabel =
    mode === "renewal"
      ? `Perpanjang · ${formatRp(payAmount)}`
      : mode === "reactivate"
        ? `Aktifkan Lagi · ${formatRp(payAmount)}`
        : `Lanjut ke Bayar · ${formatRp(payAmount)}`;

  // Close the popup (opener re-fetches sub state on focus) or, full-page, go to
  // the app. Reused by the enterprise card + the 409 backstop.
  const exitToApp = () => {
    if (window.opener) {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    } else {
      window.location.href = "/app";
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    parentOriginRef.current = validateParentOrigin(
      new URL(window.location.href).searchParams.get("parent"),
    );
  }, []);

  // Capture "now" once on the client for the reset-mode expiry preview.
  useEffect(() => setNowMs(Date.now()), []);

  // Stop the settle-poll chain if the page/popup unmounts mid-poll.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (redirectTimerRef.current) clearInterval(redirectTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Live "diproses Xs" counter while confirming settlement — reassures the user
  // that something is happening (esp. for slow async methods like VA/transfer).
  useEffect(() => {
    if (phase !== "settling") {
      setSettlingElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setSettlingElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [phase]);

  // Belt-and-suspenders snap.js readiness: poll for window.snap in case the
  // <Script> onReady/onLoad doesn't fire (cached script, race). Guarantees the
  // pay button never stays stuck on "Memuat pembayaran…".
  useEffect(() => {
    if (typeof window !== "undefined" && window.snap) {
      setSnapReady(true);
      return;
    }
    const id = setInterval(() => {
      if (typeof window !== "undefined" && window.snap) {
        setSnapReady(true);
        clearInterval(id);
      }
    }, 400);
    // If snap.js never registers window.snap within 20s (ad-block / CSP / network
    // failure), surface a reload affordance instead of leaving the pay button
    // stuck on "Memuat pembayaran…" forever.
    const stop = setTimeout(() => {
      clearInterval(id);
      if (typeof window !== "undefined" && !window.snap) setSnapLoadFailed(true);
    }, 20000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, []);

  // Embed the Snap widget ONLY after #snap-container is in the DOM. phase=embed
  // re-renders the container first; calling snap.embed before the div exists
  // renders nothing (the empty-container bug).
  useEffect(() => {
    if (phase !== "embed" || !embedToken || embeddedRef.current) return;
    if (!window.snap) return;
    embeddedRef.current = true;
    window.snap.embed(embedToken, {
      embedId: "snap-container",
      language: "id",
      onSuccess: () => {
        if (txIdRef.current) pollSettle(txIdRef.current);
      },
      onPending: () => {
        if (txIdRef.current) pollSettle(txIdRef.current);
      },
      onError: (res) => {
        setError(
          typeof res?.status_message === "string"
            ? res.status_message
            : "Pembayaran gagal.",
        );
        setPhase("error");
      },
      onClose: () => {
        if (!settledRef.current) setPhase("idle");
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, embedToken]);

  // Settlement is owned by the webhook → poll the DB until the row is completed,
  // THEN signal the parent (popup) or redirect (full-page). Guarded so the
  // snap onSuccess + the poll can't double-fire.
  const finishSettled = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setPhase("done");
    const origin = parentOriginRef.current;
    // Branch on window.opener FIRST: a popup must NEVER self-navigate to /app
    // (that would close our own surface while the opener never learns the
    // payment settled and stays stale). Only the full-page (no opener) flow
    // redirects itself. A popup with a missing/invalid ?parent simply closes —
    // the opener re-fetches sub state on focus regardless.
    if (window.opener) {
      if (origin) {
        try {
          window.opener.postMessage(
            {
              source: "agentbuff-billing",
              event: "billing:settled",
              kind: "subscription",
              transactionId: txIdRef.current,
              meta: { tier: "op_buff", cycle },
            },
            origin,
          );
        } catch {
          /* opener gone */
        }
      }
      closeTimerRef.current = setTimeout(() => {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }, 1800);
    } else {
      // Full-page flow: count down, then send the user to their payment history
      // so they immediately see the settled transaction + new expiry.
      const REDIRECT_SECONDS = 5;
      setRedirectIn(REDIRECT_SECONDS);
      redirectTimerRef.current = setInterval(() => {
        setRedirectIn((prev) => {
          const next = (prev ?? 1) - 1;
          if (next <= 0) {
            if (redirectTimerRef.current) clearInterval(redirectTimerRef.current);
            window.location.href = "/app/riwayat";
            return 0;
          }
          return next;
        });
      }, 1000);
    }
  };

  const goToRiwayat = () => {
    if (redirectTimerRef.current) clearInterval(redirectTimerRef.current);
    window.location.href = "/app/riwayat";
  };

  const pollSettle = (transactionId: string) => {
    // snap.embed fires both onPending AND onSuccess for some methods → guard so
    // we never spawn two overlapping poll chains (one would leak its timer).
    if (pollingRef.current || settledRef.current) return;
    pollingRef.current = true;
    setPhase("settling");
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let backoffCount = 0;
    const tick = async () => {
      if (cancelledRef.current || settledRef.current) return;
      if (Date.now() > deadline) {
        setPhase("expired");
        return;
      }
      try {
        // POST /reconcile actively asks Midtrans (Get-Status) and settles if
        // paid — NOT a read of our DB. This is what makes a paid order flip from
        // "Diproses" to active within seconds in dev (no webhook) and is the
        // webhook-loss safety net in prod.
        const r = await fetch(
          `/api/billing/transactions/${transactionId}/reconcile`,
          { method: "POST", credentials: "include", cache: "no-store" },
        );
        if (r.status === 429) {
          // Rate-limited — exponential back off (cap 30s) so the auto-poll never
          // burns the per-minute budget and starves the manual "Cek status".
          const backoffMs = Math.min(POLL_MS * 2 ** backoffCount, 30_000);
          backoffCount += 1;
          pollTimerRef.current = setTimeout(tick, backoffMs);
          return;
        }
        backoffCount = 0;
        if (r.ok) {
          const snap = (await r.json()) as { status?: string };
          if (snap.status === "completed" || snap.status === "installed") {
            finishSettled();
            return;
          }
          if (snap.status === "failed") {
            setError("Pembayaran gagal. Coba lagi ya.");
            setPhase("error");
            return;
          }
        }
      } catch {
        /* transient — keep polling */
      }
      pollTimerRef.current = setTimeout(tick, POLL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_MS);
  };

  // Manual "Cek status sekarang" — a one-shot check so the user isn't gated by
  // the poll interval (card payments settle in seconds; this surfaces it fast).
  const checkNow = async () => {
    if (!txIdRef.current || settledRef.current) return;
    setChecking(true);
    try {
      const r = await fetch(
        `/api/billing/transactions/${txIdRef.current}/reconcile`,
        { method: "POST", credentials: "include", cache: "no-store" },
      );
      if (cancelledRef.current) return; // unmounted mid-flight
      if (r.status === 429) {
        setCheckHint("Terlalu sering cek — tunggu sebentar ya.");
        setTimeout(() => setCheckHint(null), 4000);
        return;
      }
      if (r.ok) {
        const snap = (await r.json()) as { status?: string };
        if (cancelledRef.current) return;
        if (snap.status === "completed" || snap.status === "installed") {
          finishSettled();
          return;
        }
        if (snap.status === "failed") {
          setError("Pembayaran gagal. Coba lagi ya.");
          setPhase("error");
          return;
        }
      }
    } catch {
      /* transient — the background poll keeps trying */
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  };

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    setCouponChecking(true);
    setCouponMsg(null);
    try {
      const r = await fetch("/api/billing/coupon/validate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, tier: "op_buff", billingCycle: cycle }),
      });
      const b = (await r.json()) as {
        valid?: boolean;
        error?: string;
        discountRp?: number;
        finalRp?: number;
      };
      if (b.valid && b.finalRp != null) {
        setAppliedCoupon({
          code: code.toUpperCase(),
          discountRp: b.discountRp ?? 0,
          finalRp: b.finalRp,
        });
        setCouponMsg(null);
      } else {
        setAppliedCoupon(null);
        setCouponMsg(
          b.error === "EXPIRED"
            ? "Kupon kedaluwarsa."
            : b.error === "EXHAUSTED"
              ? "Kuota kupon habis."
              : b.error === "TIER_MISMATCH"
                ? "Kupon tidak berlaku untuk paket ini."
                : b.error === "FULL_DISCOUNT"
                  ? "Kupon ini tidak bisa dipakai (total jadi 0)."
                  : "Kode kupon tidak valid.",
        );
      }
    } catch {
      setCouponMsg("Gagal cek kupon. Coba lagi.");
    } finally {
      setCouponChecking(false);
    }
  };

  const handlePay = async () => {
    setPhase("starting");
    setError(null);
    try {
      const r = await fetch("/api/billing/subscription", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "op_buff",
          billingCycle: cycle,
          expectedPriceRp: price,
          couponCode: appliedCoupon ? appliedCoupon.code : undefined,
        }),
      });
      if (r.status === 401) {
        // Stale/expired session — fresh login, then back to checkout. Preserve
        // ?parent so the popup→opener settle bridge survives the round-trip.
        const parent = new URL(window.location.href).searchParams.get("parent");
        const back = `/checkout?cycle=${cycle}${
          parent ? `&parent=${encodeURIComponent(parent)}` : ""
        }`;
        window.location.href = `/login?next=${encodeURIComponent(back)}`;
        return;
      }
      if (r.status === 409) {
        const b = await r.json().catch(() => ({ error: "UNKNOWN" }));
        if (b.error === "PRICE_CHANGED") {
          // Admin changed the price between page-load and pay. Refuse to charge
          // the old amount; reload so the page re-resolves the new price and the
          // user confirms it explicitly.
          setError(
            "Harga baru saja diperbarui. Halaman dimuat ulang untuk menampilkan harga terbaru.",
          );
          setPhase("error");
          closeTimerRef.current = setTimeout(() => window.location.reload(), 1800);
          return;
        }
        if (b.error === "PENDING_ORDER_EXISTS") {
          // A charge for this user is already in flight — Midtrans may still
          // settle it. Don't create a second order (would double-charge); steer
          // the user to wait / check their payment history.
          setError(
            "Ada pembayaran kamu yang masih diproses. Tunggu sebentar atau cek Riwayat Bayar dulu sebelum coba lagi.",
          );
          setPhase("error");
          return;
        }
        // Backstop: an enterprise (guild_master) user can't self-serve buy OP
        // Buff. Normally the page already renders the enterprise card and never
        // shows a pay button; this only fires on a race (sub changed mid-session).
        exitToApp();
        return;
      }
      if (!r.ok) {
        const b = await r.json().catch(() => ({ error: "UNKNOWN" }));
        throw new Error(String(b.error ?? `HTTP ${r.status}`));
      }
      const { token, transactionId } = (await r.json()) as {
        token: string;
        transactionId: string;
      };
      txIdRef.current = transactionId;
      if (!window.snap) {
        throw new Error("Pembayaran belum siap. Refresh halaman ya.");
      }
      embeddedRef.current = false;
      setEmbedToken(token);
      // The embed effect runs AFTER #snap-container renders (phase=embed).
      setPhase("embed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memulai pembayaran.");
      setPhase("error");
    }
  };

  const handleGuestRegister = async () => {
    // Mark register intent (auth.config allows new-account creation) then
    // Google sign-in. New users land on /onboarding (NextAuth newUser);
    // returning users come back to /checkout.
    document.cookie =
      "agentbuff_auth_intent=register; path=/; max-age=600; samesite=lax";
    // Forward ?parent so the popup settle signal still reaches the opener after
    // the OAuth round-trip (validateParentOrigin re-checks it on return).
    const parent = new URL(window.location.href).searchParams.get("parent");
    const parentParam = parent ? `&parent=${encodeURIComponent(parent)}` : "";
    await signIn("google", {
      callbackUrl: `/checkout?cycle=${cycle}${parentParam}`,
    });
  };

  return (
    <>
      <Script
        src={SNAP_JS_URL}
        data-client-key={CLIENT_KEY}
        strategy="afterInteractive"
        onReady={() => setSnapReady(true)}
        onLoad={() => setSnapReady(true)}
        onError={() => setSnapLoadFailed(true)}
      />

      <div className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-7 backdrop-blur-xl shadow-[0_30px_120px_-40px_rgba(99,102,241,0.5)] sm:p-9">
        {/* Brand */}
        <div className="mb-6 flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-cyan-300/80">
            AgentBuff
          </span>
          <span className="text-white/20">·</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/40">
            Checkout
          </span>
        </div>

        {/* Title */}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#030014]">
            <Crown className="size-5" />
          </span>
          <div>
            <h1 className="font-display text-xl font-black leading-tight">
              {titleText}
            </h1>
            <p className="text-xs text-white/50">{subtitleText}</p>
          </div>
        </div>

        {mode === "enterprise" ? (
          /* Enterprise (Guild Master) — already a higher tier than OP Buff. No
             self-serve purchase; just acknowledge + send them to the app. */
          <div className="mt-6 space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm text-white/75">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-300" />
              <span>
                Akun kamu ada di paket{" "}
                <strong className="text-white">Guild Master</strong> (enterprise)
                — sudah mencakup semua fitur OP Buff. Nggak perlu beli OP Buff
                lagi.
              </span>
            </div>
            <button
              type="button"
              onClick={exitToApp}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 font-display font-bold text-[#030014] transition hover:brightness-95"
            >
              Buka App
            </button>
          </div>
        ) : (
          <>
        {/* Cycle picker */}
        <div className="mt-6">
          <div className="mb-1.5 text-xs text-white/45">Periode</div>
          <div
            role="radiogroup"
            aria-label="Periode langganan"
            className="grid grid-cols-2 gap-2"
          >
            {(["monthly", "yearly"] as BillingCycle[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cycle === c}
                disabled={phase === "embed" || phase === "settling"}
                onClick={() => {
                  setCycle(c);
                  // A coupon's preview is cycle-specific; clear it on switch.
                  setAppliedCoupon(null);
                  setCouponMsg(null);
                }}
                className={`rounded-xl border p-3 text-left transition disabled:opacity-50 ${
                  cycle === c
                    ? "border-cyan-400/60 bg-cyan-400/10"
                    : "border-white/10 bg-white/[0.02] hover:border-white/20"
                }`}
              >
                <div className="font-display text-sm">
                  {c === "monthly" ? "Bulanan" : "Tahunan"}
                </div>
                <div className="text-xs text-white/50">
                  {formatRp(priceFor(c))}
                  {c === "yearly"
                    ? saveMonths > 0
                      ? ` · hemat ${saveMonths} bulan`
                      : ""
                    : "/bulan"}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Perks */}
        <ul className="mt-5 grid gap-2">
          {PERKS.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm text-white/70">
              <Check className="mt-0.5 size-4 shrink-0 text-cyan-300" />
              {p}
            </li>
          ))}
        </ul>

        {/* Price */}
        <div className="mt-6 flex items-baseline gap-1.5">
          <span className="font-display text-3xl font-black">
            {formatRp(price)}
          </span>
          <span className="text-sm text-white/40">
            {cycle === "monthly" ? "/bulan" : "/tahun"}
          </span>
        </div>

        {/* Promo coupon */}
        {isAuthed && phase !== "embed" && phase !== "settling" && phase !== "done" ? (
          <div className="mt-4">
            <div className="flex items-center gap-2">
              <input
                value={couponInput}
                onChange={(e) => {
                  setCouponInput(e.target.value.toUpperCase());
                  setCouponMsg(null);
                }}
                placeholder="Kode promo (opsional)"
                className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm uppercase text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none"
              />
              <button
                type="button"
                onClick={applyCoupon}
                disabled={couponChecking || !couponInput.trim()}
                className="rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-40"
              >
                {couponChecking ? "…" : "Pakai"}
              </button>
            </div>
            {appliedCoupon ? (
              <div className="mt-2 flex items-center justify-between rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-100">
                <span>
                  Kupon {appliedCoupon.code} — hemat {formatRp(appliedCoupon.discountRp)}
                </span>
                <span className="font-semibold">{formatRp(appliedCoupon.finalRp)}</span>
              </div>
            ) : couponMsg ? (
              <p className="mt-2 text-xs text-red-300">{couponMsg}</p>
            ) : null}
          </div>
        ) : null}

        {/* Expiry preview — what the user is promised, computed with the SAME
            rule the backend settles with (period.ts). Renewal shows the extend;
            reactivate/fresh show the reset target. */}
        {isAuthed && previewExpiry && phase !== "done" ? (
          <div className="mt-5 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3 text-xs">
            {mode === "renewal" && currentExpiryDate ? (
              <>
                <div className="flex items-center justify-between text-white/55">
                  <span>Masa aktif sekarang</span>
                  <span className="text-white/80">
                    s/d {formatLongDate(currentExpiryDate)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-semibold text-cyan-100">
                  <span>Setelah perpanjang</span>
                  <span>s/d {formatLongDate(previewExpiry)}</span>
                </div>
              </>
            ) : mode === "reactivate" && currentExpiryDate ? (
              <>
                <div className="flex items-center justify-between text-white/55">
                  <span>Berakhir</span>
                  <span className="text-white/80">
                    {formatLongDate(currentExpiryDate)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-semibold text-cyan-100">
                  <span>Aktif lagi sampai</span>
                  <span>{formatLongDate(previewExpiry)}</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between font-semibold text-cyan-100">
                <span>Aktif sampai</span>
                <span>{formatLongDate(previewExpiry)}</span>
              </div>
            )}
          </div>
        ) : null}

        {/* ── Action zone ── */}
        {!isAuthed ? (
          <div className="mt-6 space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] p-3 text-xs text-white/70">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-300" />
              <span>
                Daftar dulu (gratis, pakai Google) — kamu langsung dapat 14 hari
                coba semua fitur. Upgrade ke OP Buff kapan aja dari dalam app.
              </span>
            </div>
            <button
              type="button"
              onClick={handleGuestRegister}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 font-display font-bold text-[#030014] transition hover:brightness-95"
            >
              <GoogleGlyph />
              Lanjut dengan Google
            </button>
          </div>
        ) : phase === "embed" ? (
          <div className="mt-6">
            <div
              id="snap-container"
              className="min-h-[520px] w-full overflow-hidden rounded-xl"
            />
          </div>
        ) : phase === "settling" ? (
          <div className="mt-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] p-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-cyan-400/10">
              <Loader2 className="size-6 animate-spin text-cyan-300" />
            </div>
            <h3 className="mt-3 font-display text-base font-bold text-white">
              Pembayaran diterima — mengaktifkan langganan…
            </h3>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-white/55">
              Halaman ini update otomatis begitu langganan aktif. Untuk transfer
              bank/VA, konfirmasi bisa butuh beberapa menit — kamu nggak perlu
              bayar ulang.
            </p>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
              Diproses {elapsedLabel}
            </p>
            <button
              type="button"
              onClick={checkNow}
              disabled={checking}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-60"
            >
              {checking ? <Loader2 className="size-4 animate-spin" /> : null}
              Cek status sekarang
            </button>
            {checkHint ? (
              <p className="mt-2 text-xs text-amber-200/80">{checkHint}</p>
            ) : null}
          </div>
        ) : phase === "done" ? (
          <div className="mt-6 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.06] p-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-400/10">
              <CheckCircle2 className="size-7 text-emerald-300" />
            </div>
            <h3 className="mt-3 font-display text-base font-bold text-white">
              Pembayaran berhasil! Buff kamu aktif.
            </h3>
            <p className="mt-1.5 text-sm text-white/55">
              {redirectIn !== null
                ? `Mengalihkan ke Riwayat Bayar dalam ${redirectIn} detik…`
                : "Mengalihkan…"}
            </p>
            {redirectIn !== null ? (
              <button
                type="button"
                onClick={goToRiwayat}
                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-400/20"
              >
                Lihat Riwayat Bayar sekarang
              </button>
            ) : null}
          </div>
        ) : phase === "error" ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4 text-center text-sm text-red-200">
            <XCircle className="size-7" />
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                pollingRef.current = false;
                embeddedRef.current = false;
                setPhase("idle");
                setError(null);
              }}
              className="mt-1 text-xs text-white/70 underline underline-offset-2"
            >
              Coba lagi
            </button>
          </div>
        ) : snapLoadFailed ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-center text-sm text-amber-200">
            <XCircle className="size-7" />
            <span>
              Gagal memuat sistem pembayaran. Cek koneksi atau matikan ad-blocker,
              lalu muat ulang halaman.
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-1 text-xs text-white/70 underline underline-offset-2"
            >
              Muat ulang halaman
            </button>
          </div>
        ) : phase === "expired" ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-center text-sm text-amber-200">
            <XCircle className="size-7" />
            <span>Pesanan kedaluwarsa. Ulangi pembayaran ya.</span>
            <button
              type="button"
              onClick={() => {
                settledRef.current = false;
                txIdRef.current = null;
                pollingRef.current = false;
                embeddedRef.current = false;
                setPhase("idle");
                setError(null);
              }}
              className="mt-1 text-xs text-white/70 underline underline-offset-2"
            >
              Ulangi
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handlePay}
            disabled={phase === "starting" || !snapReady}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 px-4 py-3.5 font-display font-bold text-[#030014] shadow-[0_12px_34px_-12px_rgba(99,102,241,0.7)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60"
          >
            {phase === "starting" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Menyiapkan...
              </>
            ) : !snapReady ? (
              "Memuat pembayaran..."
            ) : (
              payLabel
            )}
          </button>
        )}

        {isAuthed ? (
          <p className="mt-4 text-center text-[11px] text-white/35">
            Bayar pakai metode apa pun: kartu, semua bank (VA), QRIS,
            GoPay/OVO/DANA/ShopeePay, dan lainnya. Aman lewat Midtrans.
          </p>
        ) : null}
          </>
        )}
      </div>
    </>
  );
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function GoogleGlyph() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 4.75 12 4.75Z"
      />
    </svg>
  );
}
