import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminActor } from "@/lib/admin/rbac";

// Admin user detail (D1 User Hub). Read-only — admin AND support may read.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getAdminActor();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  try {
    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        image: schema.users.image,
        suspended: schema.users.suspended,
        suspendedReason: schema.users.suspendedReason,
        suspendedAt: schema.users.suspendedAt,
        deletionScheduledAt: schema.users.deletionScheduledAt,
        deletionReason: schema.users.deletionReason,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);

    if (!user) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    const [
      profile,
      container,
      trial,
      activeSub,
      energy,
      agentsCount,
      skillsCount,
      txCount,
      recentTx,
      subHistory,
    ] = await Promise.all([
      db
        .select({
          nickname: schema.userProfiles.nickname,
          displayName: schema.userProfiles.displayName,
          onboarded: schema.userProfiles.onboarded,
          onboardingStep: schema.userProfiles.onboardingStep,
          timezone: schema.userProfiles.timezone,
          city: schema.userProfiles.city,
          country: schema.userProfiles.country,
          focus: schema.userProfiles.focus,
          whatsapp: schema.userProfiles.whatsapp,
          role: schema.userProfiles.role,
          businessName: schema.userProfiles.businessName,
          referralSource: schema.userProfiles.referralSource,
        })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          status: schema.userContainers.status,
          port: schema.userContainers.port,
          containerName: schema.userContainers.containerName,
          imageVersion: schema.userContainers.imageVersion,
          errorMessage: schema.userContainers.errorMessage,
          provisionAttempts: schema.userContainers.provisionAttempts,
          lastHealthAt: schema.userContainers.lastHealthAt,
          balanceThrottledAt: schema.userContainers.balanceThrottledAt,
        })
        .from(schema.userContainers)
        .where(eq(schema.userContainers.userId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          status: schema.userTrials.status,
          startedAt: schema.userTrials.startedAt,
          endsAt: schema.userTrials.endsAt,
          convertedAt: schema.userTrials.convertedAt,
        })
        .from(schema.userTrials)
        .where(eq(schema.userTrials.userId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          tier: schema.subscriptions.tier,
          status: schema.subscriptions.status,
          billingCycle: schema.subscriptions.billingCycle,
          priceRp: schema.subscriptions.priceRp,
          startsAt: schema.subscriptions.startsAt,
          expiresAt: schema.subscriptions.expiresAt,
          autoRenew: schema.subscriptions.autoRenew,
        })
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, id),
            eq(schema.subscriptions.status, "active"),
          ),
        )
        .orderBy(desc(schema.subscriptions.createdAt))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          balance: schema.userEnergy.balance,
          maxBalance: schema.userEnergy.maxBalance,
        })
        .from(schema.userEnergy)
        .where(eq(schema.userEnergy.userId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ c: count() })
        .from(schema.userAgents)
        .where(eq(schema.userAgents.userId, id))
        .then((r) => r[0]?.c ?? 0),
      db
        .select({ c: count() })
        .from(schema.containerSkills)
        .where(eq(schema.containerSkills.userId, id))
        .then((r) => r[0]?.c ?? 0),
      db
        .select({ c: count() })
        .from(schema.transactions)
        .where(eq(schema.transactions.userId, id))
        .then((r) => r[0]?.c ?? 0),
      db
        .select({
          id: schema.transactions.id,
          type: schema.transactions.type,
          description: schema.transactions.description,
          amountRp: schema.transactions.amountRp,
          status: schema.transactions.status,
          createdAt: schema.transactions.createdAt,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.userId, id))
        .orderBy(desc(schema.transactions.createdAt))
        .limit(5),
      db
        .select({
          id: schema.subscriptionHistory.id,
          fromTier: schema.subscriptionHistory.fromTier,
          toTier: schema.subscriptionHistory.toTier,
          fromStatus: schema.subscriptionHistory.fromStatus,
          toStatus: schema.subscriptionHistory.toStatus,
          reason: schema.subscriptionHistory.reason,
          at: schema.subscriptionHistory.at,
        })
        .from(schema.subscriptionHistory)
        .where(eq(schema.subscriptionHistory.userId, id))
        .orderBy(desc(schema.subscriptionHistory.at))
        .limit(10),
    ]);

    return Response.json({
      user,
      profile,
      container,
      trial,
      activeSub,
      energy,
      counts: { agents: agentsCount, skills: skillsCount, transactions: txCount },
      recentTransactions: recentTx,
      subscriptionHistory: subHistory,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
