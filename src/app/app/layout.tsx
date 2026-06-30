import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { provisionContainer } from "@/lib/hermes/docker";
import { GatewayProvider } from "@/lib/app/gateway-provider";
import { resolveAccessState } from "@/lib/billing/trial-resolver";
import { resolveFlag } from "@/lib/admin/flags";
import { AppShell } from "./_components/app-shell";
import { LobyWaiting } from "@/components/loby/loby-waiting";
import { TrialLockedOverlay } from "@/components/app/trial-locked-overlay";
import { ImpersonationBanner } from "@/components/app/impersonation-banner";
import { DemoEarnNotification } from "@/components/app/demo-earn-notification";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?next=/app");
  }

  const userId = session.user.id;

  // ── Moderation gate ──────────────────────────────────────────────────
  // A suspended account is blocked here BEFORE any onboarding/trial/container
  // logic. The admin "suspend" action also docker-stops the container, so there
  // is nothing to fall through to — show a plain blocked screen with no retry or
  // pay path (those don't apply to a moderation block). Authoritative check:
  // reads users.suspended live, so a suspension takes effect on the next load.
  const [acct] = await db
    .select({
      suspended: schema.users.suspended,
      reason: schema.users.suspendedReason,
      role: schema.users.role,
      deletionScheduledAt: schema.users.deletionScheduledAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (acct?.suspended) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[#0B0E14] p-6 text-white">
        <div className="max-w-md space-y-3 text-center">
          <div className="text-lg font-semibold">Akun ditangguhkan</div>
          <p className="text-sm text-white/60">
            Akun kamu sedang ditangguhkan oleh admin
            {acct.reason ? `: ${acct.reason}` : ""}. Hubungi support kalau menurutmu
            ini keliru.
          </p>
        </div>
      </div>
    );
  }
  // Grace-delete window (D1): account is scheduled for deletion — block access
  // but tell the user it's recoverable by contacting support before the date.
  if (acct?.deletionScheduledAt && acct.deletionScheduledAt > new Date()) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[#0B0E14] p-6 text-white">
        <div className="max-w-md space-y-3 text-center">
          <div className="text-lg font-semibold">Akun dijadwalkan dihapus</div>
          <p className="text-sm text-white/60">
            Akun kamu dijadwalkan untuk dihapus pada{" "}
            {acct.deletionScheduledAt.toLocaleDateString("id-ID", {
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
            . Hubungi support sebelum tanggal itu kalau ini keliru — masih bisa
            dipulihkan.
          </p>
        </div>
      </div>
    );
  }

  // ── Maintenance gate (D13 feature flag) ──────────────────────────────
  // When maintenance.enabled is on, non-staff users see a maintenance screen.
  // admin/support bypass so they can keep working AND turn it back off (the
  // /admin route tree is NOT gated here), so a flipped flag can never lock the
  // operator out. Default-off (no flag row) → zero effect.
  const isStaff = acct?.role === "admin" || acct?.role === "support";
  if (!isStaff) {
    const maint = await resolveFlag("maintenance.enabled");
    if (maint.enabled) {
      const msg =
        typeof maint.value === "string" && maint.value.trim()
          ? maint.value
          : "AgentBuff lagi maintenance sebentar. Coba lagi nanti ya.";
      return (
        <div className="relative flex min-h-screen items-center justify-center bg-[#0B0E14] p-6 text-white">
          <div className="max-w-md space-y-3 text-center">
            <div className="text-2xl">🛠️</div>
            <div className="text-lg font-semibold">Sedang Maintenance</div>
            <p className="text-sm text-white/60">{msg}</p>
          </div>
        </div>
      );
    }
  }

  // ── Onboarding gate (Phase 4) ────────────────────────────────────────
  // Un-onboarded users finish /onboarding first — that flow is where the
  // container gets provisioned. Reaching /app un-onboarded would otherwise show
  // a waiting screen for a container that is never provisioned here, so bounce.
  const [profile] = await db
    .select({ onboarded: schema.userProfiles.onboarded })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);
  if (!profile?.onboarded) {
    redirect("/onboarding");
  }

  // Trial/subscription gate — BEFORE the container fetch + readiness gate. An
  // expired-trial user with no active sub is locked behind the pay overlay; the
  // lifecycle worker docker-stops their container at expiry, and LobyWaiting
  // would only show a spinner — trapping exactly these users with no way to pay
  // or log out. resolveAccessState needs only userId, so evaluate it first and
  // skip the container round-trip entirely for locked users.
  const access = await resolveAccessState(userId);
  if (access.locked) {
    return (
      <div className="relative min-h-screen bg-[#0B0E14] text-white">
        <TrialLockedOverlay reason={access.reason ?? "trial"} />
      </div>
    );
  }

  const [row] = await db
    .select({
      status: schema.userContainers.status,
      errorMessage: schema.userContainers.errorMessage,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  // Container not ready yet → show the provisioning waiting screen RIGHT HERE.
  // We deliberately do NOT redirect to /loby: that route renders the raw Hermes
  // engine dashboard (operator-only) and must never reach end users. LobyWaiting
  // polls /api/users/me/container and reloads this page once the container is
  // "running", which re-runs this guard and renders the app.
  if (!row) {
    provisionContainer(userId).catch((err) =>
      console.error("[app] hermes provision failed:", err),
    );
    return <LobyWaiting initialStatus="queued" />;
  }
  if (row.status !== "running") {
    return (
      <LobyWaiting
        initialStatus={row.status}
        errorMessage={row.errorMessage ?? undefined}
      />
    );
  }

  // Container running. Apply-recovery: if the onboarding apply job didn't finish
  // (BYOK keys still 'staged'), re-dress the agent now that the container is
  // confirmed running. Cheap staged-check first; idempotent + fire-and-forget,
  // so it adds no latency to a healthy load and closes the activation-cliff
  // recovery loop for the rare failed-apply case.
  void (async () => {
    const staged = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.userId, userId), eq(schema.apiKeys.status, "staged")))
      .limit(1);
    if (staged.length > 0) {
      const { applyOnboardingToContainer } = await import(
        "@/lib/onboarding/apply-to-container"
      );
      await applyOnboardingToContainer(userId, {
        port: row.port,
        bridgeToken: row.gatewayToken,
      });
    }
  })().catch((e) => console.error("[app] apply-recovery dispatch failed:", e));

  // access (trial/sub state) was resolved above, before the container gate.
  return (
    <div className="relative min-h-screen bg-[#0B0E14] text-white">
      {/* Ambient orbs + grid — mirrors basecamp-client chrome exactly.
          Fixed + pointer-events:none so it stays behind AppShell even
          when the shell sits inside an overflow-hidden flex tree. */}
      <div
        aria-hidden
        className="pointer-events-none fixed -left-40 top-20 z-0 size-[480px] rounded-full blur-[160px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(34,211,238,0.28), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -right-40 bottom-10 z-0 size-[520px] rounded-full blur-[180px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(217,70,239,0.22), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.4) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse at center, black 25%, transparent 80%)",
        }}
      />
      <div className="relative z-10 flex min-h-screen flex-col">
        {session.user.impersonatedBy ? <ImpersonationBanner /> : null}
        <DemoEarnNotification />
        <GatewayProvider>
          <AppShell trial={access.hasActiveSub ? null : access.trial}>
            {children}
          </AppShell>
        </GatewayProvider>
      </div>
    </div>
  );
}
