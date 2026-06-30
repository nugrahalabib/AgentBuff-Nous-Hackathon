// Grant/revoke the admin RBAC role on a user by email (admin-panel foundation F1).
//
//   pnpm tsx --env-file=.env.local scripts/grant-admin.ts <email> [admin|support|user]
//
// Default role = admin. Use `user` to revoke. The /admin gate reads users.role
// from the DB on every request, so the change takes effect on the next request
// (the target may need to re-login only for the role to show in their session UI).

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

async function main() {
  const email = process.argv[2];
  const role = process.argv[3] ?? "admin";
  if (!email) {
    console.error("usage: grant-admin.ts <email> [admin|support|user]");
    process.exit(1);
  }
  if (role !== "admin" && role !== "support" && role !== "user") {
    console.error("role must be one of: admin | support | user");
    process.exit(1);
  }

  const res = await db
    .update(schema.users)
    .set({ role, updatedAt: new Date() })
    .where(eq(schema.users.email, email))
    .returning({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
    });

  if (res.length === 0) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  console.log(`set role=${role} for ${res[0].email} (${res[0].id.slice(0, 8)})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
