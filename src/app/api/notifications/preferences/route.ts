import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const updatePrefsSchema = z.object({
  aiTasks: z.boolean().optional(),
  system: z.boolean().optional(),
  store: z.boolean().optional(),
  lowEnergy: z.boolean().optional(),
  waEnabled: z.boolean().optional(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const [prefs] = await db
      .select()
      .from(schema.notifPrefs)
      .where(eq(schema.notifPrefs.userId, userId));

    if (!prefs) {
      return Response.json({
        aiTasks: true,
        system: true,
        store: true,
        lowEnergy: true,
        waEnabled: false,
      });
    }

    return Response.json({
      aiTasks: prefs.aiTasks,
      system: prefs.system,
      store: prefs.store,
      lowEnergy: prefs.lowEnergy,
      waEnabled: prefs.waEnabled,
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const userId = session.user.id;

    const body = await req.json();
    const parsed = updatePrefsSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "VALIDATION_ERROR", details: parsed.error.issues },
        { status: 400 },
      );

    const updates = parsed.data;

    await db
      .insert(schema.notifPrefs)
      .values({
        userId,
        aiTasks: updates.aiTasks ?? true,
        system: updates.system ?? true,
        store: updates.store ?? true,
        lowEnergy: updates.lowEnergy ?? true,
        waEnabled: updates.waEnabled ?? false,
      })
      .onConflictDoUpdate({
        target: schema.notifPrefs.userId,
        set: updates,
      });

    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
