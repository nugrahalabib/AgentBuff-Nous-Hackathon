import { eq, and, desc } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const { id } = await params;

    const [method] = await db
      .select()
      .from(schema.paymentMethods)
      .where(
        and(
          eq(schema.paymentMethods.id, id),
          eq(schema.paymentMethods.userId, userId),
        ),
      );

    if (!method)
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    await db
      .delete(schema.paymentMethods)
      .where(eq(schema.paymentMethods.id, id));

    if (method.isDefault) {
      const [next] = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.userId, userId))
        .orderBy(desc(schema.paymentMethods.createdAt))
        .limit(1);

      if (next) {
        await db
          .update(schema.paymentMethods)
          .set({ isDefault: true })
          .where(eq(schema.paymentMethods.id, next.id));
      }
    }

    return Response.json({ deleted: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
