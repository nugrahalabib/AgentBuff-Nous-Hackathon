/**
 * HACKATHON demo helper — flip a catalog item to `available` so the BuffHub
 * Shop card shows "Beli Sekarang" and /api/billing/skill accepts it.
 * Usage: pnpm tsx --env-file=.env.local scripts/hack-flip-pos.ts [slug]
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { invalidateCatalogCache } from "@/lib/billing/skill-catalog";

const slug = process.argv[2] ?? "pos-umkm";

async function main() {
  const res = await db
    .update(schema.skillCatalog)
    .set({ status: "available" })
    .where(eq(schema.skillCatalog.key, slug))
    .returning({ key: schema.skillCatalog.key, status: schema.skillCatalog.status });
  invalidateCatalogCache();
  console.log("flipped:", res.length ? res : `(no row for '${slug}' — was it seeded?)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
