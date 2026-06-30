import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function PUT(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;
    const { id } = await params;

    const [existing] = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.userId, userId),
        ),
      )
      .limit(1);

    if (!existing)
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    await db
      .update(schema.notifications)
      .set({ read: true })
      .where(eq(schema.notifications.id, id));

    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
