import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { stripeChargeIdr } from "@/lib/hack/stripe";
import { connectPosMcp } from "@/lib/hack/pos-mcp";

// HACKATHON internal endpoint — lets the in-container AGENT trigger a BuffHub
// purchase (the agent has no NextAuth cookie, so it can't hit /api/billing/skill).
// Loopback + shared-secret gated. Records a real transaction ONLY after a real
// Stripe TEST charge succeeds, then the "berhasil dipasang" notification + deducts
// the demo wallet. The purchased skill is pre-staged in the container, so it's
// usable immediately. INTEGRITY: a "purchased" result NEVER appears without a real
// PaymentIntent behind it — if the charge fails we return ok:false (the card shows
// "gagal" + retry) and write nothing.

function isLoopback(req: Request): boolean {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const host = (req.headers.get("host") ?? "").split(":")[0];
  // host.docker.internal resolves to the host; the request arrives on loopback.
  return (
    !xff ||
    xff === "127.0.0.1" ||
    xff === "::1" ||
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "host.docker.internal"
  );
}

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_BRIDGE_SECRET;
  const given = request.headers.get("x-internal-secret");
  if (!secret || given !== secret || !isLoopback(request)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  let payload: { userId?: string; slug?: string };
  try {
    payload = (await request.json()) as { userId?: string; slug?: string };
  } catch {
    return Response.json({ error: "BAD_JSON" }, { status: 400 });
  }
  const { slug } = payload;
  if (!slug) {
    return Response.json({ error: "MISSING_SLUG" }, { status: 400 });
  }
  // The agent need only send the secret + slug. Resolve the buyer: explicit
  // userId, else the single demo user that owns a container (hackathon DB = 1 user).
  let userId = payload.userId ?? null;
  if (!userId) {
    const [row] = await db
      .select({ userId: schema.userContainers.userId })
      .from(schema.userContainers)
      .limit(1);
    userId = row?.userId ?? null;
  }
  if (!userId) {
    return Response.json({ error: "NO_USER" }, { status: 404 });
  }

  // Resolve the catalog item (price + name + status) straight from the DB.
  const [item] = await db
    .select({
      title: schema.skillCatalog.title,
      priceRp: schema.skillCatalog.priceRp,
      status: schema.skillCatalog.status,
    })
    .from(schema.skillCatalog)
    .where(eq(schema.skillCatalog.key, slug))
    .limit(1);
  if (!item) {
    return Response.json({ error: "UNKNOWN_SKILL" }, { status: 404 });
  }
  const amountRp = item.priceRp ?? 0;
  const name = item.title ?? slug;

  // Only sell what's actually available — never charge for a coming_soon SKU.
  // Mirrors the user-checkout gate (api/billing/skill). Placed BEFORE the charge.
  if (item.status !== "available") {
    return Response.json(
      {
        ok: false,
        slug,
        name,
        amountRp,
        error: "SKILL_NOT_AVAILABLE",
        message: `Skill '${name}' is not available for purchase yet.`,
      },
      { status: 200 },
    );
  }

  // Identify the buyer so the Stripe "Pelanggan" column shows the real user (the
  // agent is spending on behalf of this AgentBuff user). Use their actual name,
  // falling back to the email local-part if the name is unset.
  const [buyer] = await db
    .select({ email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const buyerName =
    buyer?.name?.trim() || buyer?.email?.split("@")[0] || "Pengguna AgentBuff";

  // Idempotency / no double-charge: if this user already owns this skill (a prior
  // installed transaction exists), short-circuit to the existing receipt instead of
  // firing a SECOND real Stripe charge. Demo resets clear transactions, so a fresh
  // take's first buy still charges; only an accidental re-fire (Nemotron re-running
  // the tool) within a session collapses to the existing receipt.
  const [owned] = await db
    .select({
      paymentRef: schema.transactions.paymentRef,
      orderId: schema.transactions.midtransOrderId,
      paidAt: schema.transactions.paidAt,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.sku, slug),
        eq(schema.transactions.type, "skill-install"),
        eq(schema.transactions.status, "installed"),
      ),
    )
    .orderBy(desc(schema.transactions.paidAt))
    .limit(1);
  if (owned?.paymentRef) {
    let posMcpExisting: { ok: boolean; status: string } | null = null;
    if (slug === "pos-umkm") {
      const [c] = await db
        .select({ containerName: schema.userContainers.containerName })
        .from(schema.userContainers)
        .where(eq(schema.userContainers.userId, userId))
        .limit(1);
      if (c?.containerName) posMcpExisting = await connectPosMcp(c.containerName);
    }
    const webAppUrlExisting =
      slug === "pos-umkm"
        ? process.env.POS_WEBAPP_URL ?? "http://localhost:7703"
        : undefined;
    return Response.json({
      ok: true,
      alreadyOwned: true,
      posMcp: posMcpExisting,
      slug,
      name,
      amountRp,
      stripePaymentIntent: owned.paymentRef,
      webAppUrl: webAppUrlExisting,
      receiptRef: owned.orderId,
      paidAt: owned.paidAt ? owned.paidAt.toISOString() : undefined,
      message: `You already own '${name}' — no extra charge.`,
    });
  }

  // Charge FIRST. No real PaymentIntent => no purchase recorded, no success card.
  const charge = await stripeChargeIdr({
    amountRp,
    description: `BuffHub: agent bought skill '${slug}'`,
    metadata: { kind: "buffhub_buy", skill: slug },
    customer: buyer?.email ? { name: buyerName, email: buyer.email } : undefined,
  });
  if (!charge.ok || !charge.id) {
    return Response.json(
      {
        ok: false,
        slug,
        name,
        amountRp,
        error: charge.error ?? "STRIPE_FAILED",
        message: `Payment of Rp ${amountRp.toLocaleString("id-ID")} for '${name}' failed. Please try again.`,
      },
      { status: 200 },
    );
  }
  const pi = charge.id;
  const now = new Date();
  const orderId = `hack-${slug}-${now.getTime()}`;

  await db.insert(schema.transactions).values({
    userId,
    type: "skill-install",
    description: `Beli skill '${name}' dari BuffHub`,
    amountRp,
    status: "installed",
    sku: slug,
    paymentRef: pi,
    paymentMethod: "stripe_test",
    paidAt: now,
    installedAt: now,
    midtransOrderId: orderId,
  });

  await db.insert(schema.notifications).values({
    userId,
    tab: "shop",
    icon: "check-circle",
    highPriority: true,
    text: `Skill '${name}' berhasil dipasang ke agenmu. Langsung bisa dipakai!`,
    actionLabel: "Buka Chat",
    actionHref: "/app",
  });

  // Deduct the demo wallet (clamped at 0).
  await db
    .update(schema.userEnergy)
    .set({ balance: sql`GREATEST(0, ${schema.userEnergy.balance} - ${amountRp})` })
    .where(eq(schema.userEnergy.userId, userId));

  // Record ownership (best-effort; the transaction row above is the durable
  // purchase record, so this stays non-fatal). source="marketplace" marks it as
  // a BuffHub purchase vs a bundled skill.
  try {
    await db
      .insert(schema.containerSkills)
      .values({ userId, skillKey: slug, source: "marketplace" })
      .onConflictDoNothing();
  } catch {
    /* non-fatal for the demo */
  }

  // If they bought the POS skill, connect the agent to the real AgentBuff POS MCP
  // server so the purchase actually unlocks operating the POS (best-effort).
  let posMcp: { ok: boolean; status: string } | null = null;
  if (slug === "pos-umkm") {
    const [c] = await db
      .select({ containerName: schema.userContainers.containerName })
      .from(schema.userContainers)
      .where(eq(schema.userContainers.userId, userId))
      .limit(1);
    if (c?.containerName) {
      posMcp = await connectPosMcp(c.containerName);
    }
  }

  // The POS skill ships a real web app — offer to open it (the success card
  // renders a "Buka Aplikasi POS" button when webAppUrl is present).
  const webAppUrl =
    slug === "pos-umkm"
      ? process.env.POS_WEBAPP_URL ?? "http://localhost:7703"
      : undefined;

  return Response.json({
    ok: true,
    posMcp,
    slug,
    name,
    amountRp,
    stripePaymentIntent: pi,
    webAppUrl,
    receiptRef: orderId,
    paidAt: now.toISOString(),
    message: `Skill '${name}' purchased (Rp ${amountRp.toLocaleString("id-ID")}) & installed.`,
  });
}
