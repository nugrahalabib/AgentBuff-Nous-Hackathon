// D15 regression smoke test — proves the admin email-copy override chain:
// DB row -> loadEmailCopyOverrides() cache reload -> SYNC template fn reflects it
// -> reset returns to compiled default. Cleans up its own row in finally so the
// override table is left exactly as found.
// Run: pnpm tsx --env-file=.env.local scripts/test-email-template-override.ts
import { db } from "@/lib/db";
import { emailTemplateOverrides } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import {
  emailTemplateDefault,
  loadEmailCopyOverrides,
  trialExpiredEmail,
} from "@/lib/email/templates";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
}

const KEY = "trialExpired" as const;
const LOCALE = "id" as const;
const MARKER = `__TEST_OVERRIDE_${Date.now()}__`;

async function deleteRow(): Promise<void> {
  await db
    .delete(emailTemplateOverrides)
    .where(
      and(
        eq(emailTemplateOverrides.templateKey, KEY),
        eq(emailTemplateOverrides.locale, LOCALE),
      ),
    );
}

async function main(): Promise<void> {
  // Guard: bail if an override already exists for this key so we never clobber a
  // real admin edit.
  const existing = await db
    .select()
    .from(emailTemplateOverrides)
    .where(
      and(
        eq(emailTemplateOverrides.templateKey, KEY),
        eq(emailTemplateOverrides.locale, LOCALE),
      ),
    );
  if (existing.length > 0) {
    console.error(
      `SKIP: a real override for (${KEY}, ${LOCALE}) exists — not touching it.`,
    );
    process.exit(0);
  }

  const def = emailTemplateDefault(LOCALE, KEY);
  console.log(`default subject: "${def.subject}"`);

  try {
    await db.insert(emailTemplateOverrides).values({
      templateKey: KEY,
      locale: LOCALE,
      fields: { subject: MARKER },
    });
    await loadEmailCopyOverrides();

    const overridden = trialExpiredEmail(LOCALE);
    assert(overridden.subject === MARKER, "sync template fn reflects DB override after reload");
    assert(overridden.subject !== def.subject, "overridden subject differs from default");

    await deleteRow();
    await loadEmailCopyOverrides();
    const reset = trialExpiredEmail(LOCALE);
    assert(reset.subject === def.subject, "reset to default after override row deleted");

    console.log("\nALL PASS — D15 email template override chain verified end-to-end.");
  } finally {
    await deleteRow();
    await loadEmailCopyOverrides();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
