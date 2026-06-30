import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const tab = req.nextUrl.searchParams.get("tab");

    const conditions = [eq(schema.notifications.userId, userId)];
    if (tab && ["tasks", "system", "store"].includes(tab)) {
      conditions.push(eq(schema.notifications.tab, tab));
    }

    const items = await db
      .select()
      .from(schema.notifications)
      .where(and(...conditions))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);

    return Response.json(items);
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
