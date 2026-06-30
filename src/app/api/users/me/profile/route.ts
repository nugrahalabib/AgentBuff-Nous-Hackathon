import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, session.user.id))
      .limit(1);

    const [engine] = await db
      .select()
      .from(schema.engineConfig)
      .where(eq(schema.engineConfig.userId, session.user.id))
      .limit(1);

    // Trial summary so the profile card can highlight "trial · sisa N hari"
    // (reactive: days computed from endsAt vs now, not the stored status flag).
    const [trialRow] = await db
      .select({
        status: schema.userTrials.status,
        endsAt: schema.userTrials.endsAt,
      })
      .from(schema.userTrials)
      .where(eq(schema.userTrials.userId, session.user.id))
      .limit(1);
    const trial = trialRow
      ? {
          status: trialRow.status,
          endsAt: trialRow.endsAt.toISOString(),
          daysLeft: Math.max(
            0,
            Math.ceil((trialRow.endsAt.getTime() - Date.now()) / 86_400_000),
          ),
        }
      : null;

    return Response.json({
      profile: profile ?? null,
      engine: engine ?? null,
      trial,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
    });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

const updateSchema = z.object({
  legalName: z.string().optional(),
  displayName: z.string().optional(),
  nickname: z.string().optional(),
  whatsapp: z.string().optional(),
  dob: z.string().optional(),
  role: z.string().optional(),
  industryIds: z.string().optional(),
  avatarEmoji: z.string().optional(),
  // Per-account UI language preference (mirrors the i18n locale).
  locale: z.enum(["id", "en"]).optional(),
});

export async function PUT(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success)
      return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });

    const data = parsed.data;

    await db
      .update(schema.userProfiles)
      .set({
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.nickname !== undefined && { nickname: data.nickname }),
        ...(data.whatsapp !== undefined && { whatsapp: data.whatsapp }),
        ...(data.dob !== undefined && { dob: data.dob }),
        ...(data.role !== undefined && { role: data.role }),
        ...(data.industryIds !== undefined && { industryIds: data.industryIds }),
        ...(data.avatarEmoji !== undefined && { avatarEmoji: data.avatarEmoji }),
        ...(data.locale !== undefined && { locale: data.locale }),
        updatedAt: new Date(),
      })
      .where(eq(schema.userProfiles.userId, session.user.id));

    // Also update user.name if legalName provided
    if (data.legalName) {
      await db
        .update(schema.users)
        .set({ name: data.legalName, updatedAt: new Date() })
        .where(eq(schema.users.id, session.user.id));
    }

    const [updated] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, session.user.id))
      .limit(1);

    return Response.json({ profile: updated });
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
