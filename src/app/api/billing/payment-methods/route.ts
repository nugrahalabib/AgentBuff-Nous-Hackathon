import { eq, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const createPaymentMethodSchema = z.object({
  type: z.string(),
  brand: z.string(),
  lastFour: z.string().length(4).optional(),
  expiry: z.string().optional(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const methods = await db
      .select()
      .from(schema.paymentMethods)
      .where(eq(schema.paymentMethods.userId, userId))
      .orderBy(desc(schema.paymentMethods.isDefault), desc(schema.paymentMethods.createdAt));

    return Response.json(methods);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const body = await req.json();
    const parsed = createPaymentMethodSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );

    const existing = await db
      .select({ id: schema.paymentMethods.id })
      .from(schema.paymentMethods)
      .where(eq(schema.paymentMethods.userId, userId))
      .limit(1);

    const isFirst = existing.length === 0;

    const [method] = await db
      .insert(schema.paymentMethods)
      .values({
        userId,
        type: parsed.data.type,
        brand: parsed.data.brand,
        lastFour: parsed.data.lastFour,
        expiry: parsed.data.expiry,
        isDefault: isFirst,
      })
      .returning();

    return Response.json(method, { status: 201 });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
