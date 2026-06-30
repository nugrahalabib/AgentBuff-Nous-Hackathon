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

    // Energy system OFF (BYOK) — nothing to sell yet.
    if (!hermesConfig.energyGateEnabled) return Response.json([]);

    const bundles = await db
      .select()
      .from(schema.energyBundles)
      .where(eq(schema.energyBundles.active, true));

    return Response.json(bundles);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
