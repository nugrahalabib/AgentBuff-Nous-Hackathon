import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    // Energy system OFF (BYOK) — don't seed or expose a balance for a feature
    // that isn't live. Flip HERMES_ENERGY_GATE_ENABLED to re-enable.
    if (!hermesConfig.energyGateEnabled)
      return Response.json({ enabled: false, balance: 0, maxBalance: 0, lastTopupAt: null });

    let [energy] = await db
      .select()
      .from(schema.userEnergy)
      .where(eq(schema.userEnergy.userId, userId));

    if (!energy) {
      [energy] = await db
        .insert(schema.userEnergy)
        .values({ userId, balance: 100, maxBalance: 100 })
        .returning();
    }

    return Response.json({
      enabled: true,
      balance: energy.balance,
      maxBalance: energy.maxBalance,
      lastTopupAt: energy.lastTopupAt,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
