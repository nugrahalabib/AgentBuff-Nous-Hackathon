import { db } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  // Drop the synthetic smoke-test lead so the real lead table stays clean.
  await db
    .delete(s.earlyAccessLeads)
    .where(eq(s.earlyAccessLeads.email, "tes.chief@example.com"));
  const rows = await db.select().from(s.earlyAccessLeads);
  console.log("ROWS:", rows.length);
  for (const r of rows) {
    console.log(
      `- ${r.name} <${r.email}> wa=${r.whatsapp} tier=${r.tier} status=${r.status} note=${r.note} at=${r.createdAt?.toISOString?.() ?? r.createdAt}`,
    );
  }
  process.exit(0);
}

main();
