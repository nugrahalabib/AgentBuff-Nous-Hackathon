// Throwaway: end-to-end SUBSCRIPTION payment verification against Midtrans.
// Exercises the REAL production code (no mocks) on a throwaway user that is
// fully torn down at the end. SANDBOX-ONLY (refuses to run if prod).
//   pnpm tsx --env-file=.env.local scripts/_test-payment-e2e.ts
//
// AgentBuff has NO energy system (BYOK) — this only tests the SUBSCRIPTION
// path (the real product, Rp99.000). Email sending is disabled in-process so
// test receipts don't bounce into the inbox (email is verified by _test-email).
//
// Covers:
//   A. Live sandbox charge (real Midtrans API) — only if a real SB- key exists
//   B. Webhook signature verify (valid + forged + tampered)
//   C. Settle money-safety: amount cross-check + order-not-found
//   D. Subscription activation + idempotent replay (trial -> converted, +30d)
//   E. (best-effort) full HTTP webhook route if the dev server is up

// Disable the mailer BEFORE importing anything that might touch it — the email
// system is verified separately; here we don't want receipts sent at all.
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  createCharge,
  getTransactionStatus,
  cancelTransaction,
  verifySignature,
  assertPositiveIntegerIdr,
} from "@/lib/midtrans";
import { applySettlement } from "@/lib/billing/settle";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

const SERVER_URL = "http://localhost:617";
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY ?? "";
const PRICE = 99000; // OP Buff monthly — the real product price.

function sig(orderId: string, statusCode: string, gross: string): string {
  return createHash("sha512")
    .update(orderId + statusCode + gross + SERVER_KEY)
    .digest("hex");
}

async function txStatus(orderId: string): Promise<string | null> {
  const [t] = await db
    .select({ status: schema.transactions.status })
    .from(schema.transactions)
    .where(eq(schema.transactions.midtransOrderId, orderId));
  return t?.status ?? null;
}
async function subByOrder(orderId: string) {
  const [s] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.midtransOrderId, orderId));
  return s ?? null;
}

// Insert a pending subscription transaction + subscription row (mirrors the
// /api/billing/subscription checkout exactly).
async function seedPendingSub(uid: string, orderId: string) {
  await db.insert(schema.transactions).values({
    userId: uid,
    type: "subscription",
    description: "op_buff (monthly)",
    amountRp: PRICE,
    status: "pending",
    midtransOrderId: orderId,
  });
  await db.insert(schema.subscriptions).values({
    userId: uid,
    tier: "op_buff",
    billingCycle: "monthly",
    priceRp: PRICE,
    status: "pending",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    midtransOrderId: orderId,
  });
}

async function main() {
  // ── Safety guards ────────────────────────────────────────────────
  if (process.env.MIDTRANS_IS_PRODUCTION === "true") {
    console.error("REFUSING: MIDTRANS_IS_PRODUCTION=true. Sandbox only.");
    process.exit(1);
  }
  if (!SERVER_KEY) {
    console.error("MIDTRANS_SERVER_KEY not set.");
    process.exit(1);
  }
  const isSandboxKey = SERVER_KEY.startsWith("SB-");
  console.log(
    `Midtrans subscription e2e — key: ${isSandboxKey ? "SANDBOX" : "NON-SANDBOX (live charge skipped)"}\n`,
  );

  const uid = `test-pay-${Date.now()}`;

  try {
    await db.insert(schema.users).values({
      id: uid,
      email: `payment-e2e+${uid}@example.com`,
      name: "Payment E2E Test",
    });

    // ── A. Live sandbox charge ──────────────────────────────────────
    console.log("A. Live sandbox charge (real Midtrans API)");
    const chargeOrder = `TEST-CHG-${Date.now()}`;
    if (!isSandboxKey) {
      console.log(
        "  (skipped — .env.local has no sandbox key 'SB-Mid-server-...'; provide real sandbox keys to exercise the live charge)",
      );
    } else try {
      const charge = await createCharge({
        orderId: chargeOrder,
        grossAmount: PRICE,
        paymentType: "qris",
        customerEmail: "payment-e2e@example.com",
      });
      check(
        "charge accepted (status_code 201)",
        charge.status_code === "201",
        charge.status_code + " " + charge.status_message,
      );
      check(
        "charge returned a QRIS payload",
        Boolean(charge.qr_string || charge.actions?.some((a) => /qr/i.test(a.name))),
      );
      const st = await getTransactionStatus(chargeOrder);
      check("get-status returns pending", st.transaction_status === "pending", st.transaction_status);
      try {
        await cancelTransaction(chargeOrder);
      } catch {
        /* sandbox may not allow cancel on pending QRIS — harmless */
      }
    } catch (e) {
      check("live charge call", false, e instanceof Error ? e.message : e);
    }

    // amount guard (pure)
    let threwNonInt = false;
    try {
      assertPositiveIntegerIdr(PRICE + 0.5, "gross");
    } catch {
      threwNonInt = true;
    }
    check("amount guard rejects non-integer", threwNonInt);
    let threwZero = false;
    try {
      assertPositiveIntegerIdr(0, "gross");
    } catch {
      threwZero = true;
    }
    check("amount guard rejects zero", threwZero);

    // ── B. Signature verify ─────────────────────────────────────────
    console.log("\nB. Webhook signature verification");
    const so = "SIGTEST-1";
    const g = `${PRICE}.00`;
    check("valid signature passes", verifySignature(so, "200", g, sig(so, "200", g)));
    check("forged signature rejected", verifySignature(so, "200", g, "deadbeef") === false);
    check("tampered amount rejected", verifySignature(so, "200", "1.00", sig(so, "200", g)) === false);

    // ── C. Settle money-safety ──────────────────────────────────────
    console.log("\nC. Settle money-safety");
    // amount mismatch — must NOT settle
    const oMis = `TEST-MIS-${Date.now()}`;
    await seedPendingSub(uid, oMis);
    await applySettlement(oMis, "1.00", "ref-mis", "127.0.0.1");
    check("amount mismatch leaves tx pending", (await txStatus(oMis)) === "pending");
    check("amount mismatch leaves sub pending", (await subByOrder(oMis))?.status === "pending");
    // order not found — must not throw
    let notFoundOk = true;
    try {
      await applySettlement(`TEST-NONE-${Date.now()}`, g, "x", "127.0.0.1");
    } catch {
      notFoundOk = false;
    }
    check("unknown order is a safe no-op (no throw)", notFoundOk);

    // ── D. Subscription activation + idempotency ────────────────────
    console.log("\nD. Subscription activation (the real product path)");
    await db.insert(schema.userTrials).values({
      userId: uid,
      endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      status: "active",
    });
    const oSub = `TEST-SUB-${Date.now()}`;
    await seedPendingSub(uid, oSub);
    await applySettlement(oSub, g, "ref-sub", "127.0.0.1");
    check("subscription tx -> completed", (await txStatus(oSub)) === "completed");
    const sub1 = await subByOrder(oSub);
    check("subscription -> active", sub1?.status === "active", sub1?.status);
    const days = sub1 ? Math.round((sub1.expiresAt.getTime() - Date.now()) / 86_400_000) : 0;
    check("expiresAt ~30 days from pay date", days >= 29 && days <= 31, `${days}d`);
    const [trial] = await db
      .select()
      .from(schema.userTrials)
      .where(eq(schema.userTrials.userId, uid));
    check("trial -> converted", trial?.status === "converted", trial?.status);

    // idempotent replay — must NOT re-activate / re-extend
    const expiresBefore = sub1?.expiresAt.getTime();
    await applySettlement(oSub, g, "ref-sub", "127.0.0.1");
    const sub2 = await subByOrder(oSub);
    check(
      "replay leaves subscription unchanged (no double-extend)",
      sub2?.status === "active" && sub2?.expiresAt.getTime() === expiresBefore,
    );

    // ── E. Full HTTP webhook route (best-effort) ────────────────────
    console.log("\nE. Full HTTP webhook route (dev server)");
    let serverUp = false;
    try {
      const r = await fetch(`${SERVER_URL}/api/auth/session`, { signal: AbortSignal.timeout(2500) });
      serverUp = r.ok;
    } catch {
      serverUp = false;
    }
    if (!serverUp) {
      console.log("  (skipped — dev server on :617 not reachable)");
    } else {
      const oHook = `TEST-HOOK-${Date.now()}`;
      await seedPendingSub(uid, oHook);
      const post = (sigKey: string) =>
        fetch(`${SERVER_URL}/api/billing/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id: oHook,
            status_code: "200",
            gross_amount: g,
            signature_key: sigKey,
            transaction_status: "settlement",
            transaction_id: "test-hook-ref",
          }),
        });
      const bad = await post("forged-signature");
      check("HTTP webhook rejects forged signature (403)", bad.status === 403, bad.status);
      check("forged webhook left tx pending", (await txStatus(oHook)) === "pending");
      const good = await post(sig(oHook, "200", g));
      check("HTTP webhook accepts valid signature (200)", good.status === 200, good.status);
      let settled = false;
      for (let i = 0; i < 10 && !settled; i++) {
        await new Promise((r) => setTimeout(r, 400));
        settled = (await txStatus(oHook)) === "completed";
      }
      check("valid webhook settled tx -> completed", settled);
    }
  } finally {
    // Tear down — deleting the user cascades tx/sub/trial/notifications.
    await db.delete(schema.users).where(eq(schema.users.id, uid));
    console.log("\ncleanup: throwaway user deleted (cascade).");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
