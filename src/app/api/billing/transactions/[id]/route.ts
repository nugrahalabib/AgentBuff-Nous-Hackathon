import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const { id } = await params;
    if (!id || id.length > 80) {
      return Response.json({ error: "INVALID_ID" }, { status: 400 });
    }

    const [tx] = await db
      .select({
        id: schema.transactions.id,
        type: schema.transactions.type,
        status: schema.transactions.status,
        description: schema.transactions.description,
        amountRp: schema.transactions.amountRp,
        energyDelta: schema.transactions.energyDelta,
        sku: schema.transactions.sku,
        installedAt: schema.transactions.installedAt,
        lastInstallError: schema.transactions.lastInstallError,
        createdAt: schema.transactions.createdAt,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.userId, userId),
        ),
      )
      .limit(1);

    if (!tx) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    return Response.json(tx);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
