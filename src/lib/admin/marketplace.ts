import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

// Get-or-create the single first-party house seller (admin = seller#0).
// First-party listings are commission-exempt (0%).
export async function ensureFirstPartySeller(): Promise<string> {
  const [existing] = await db
    .select({ id: schema.sellers.id })
    .from(schema.sellers)
    .where(eq(schema.sellers.type, "first_party"))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.sellers)
    .values({
      type: "first_party",
      displayName: "AgentBuff",
      status: "active",
      commissionPct: 0,
    })
    .returning({ id: schema.sellers.id });
  return created.id;
}
