import { eq } from "drizzle-orm";
import { auth, signOut } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { destroyContainer } from "@/lib/hermes/docker";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const userId = session.user.id;

  // Destroys the container + wipes the volume + deletes the user row (cascade).
  // Rate-limit per-user so a stolen session / scripted loop can't churn
  // destroy→reprovision (also slows trial-farming via delete+re-register).
  const rl = take(keyFromRequest("account-delete", req, userId), 3, 60 * 60_000);
  if (!rl.ok) {
    return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  try {
    await destroyContainer(userId);
  } catch (err) {
    console.error("[account/delete] destroy failed:", err);
    // Proceed anyway — better to delete the account than leave a dangling one.
  }

  await db.delete(schema.users).where(eq(schema.users.id, userId));

  try {
    await signOut({ redirect: false });
  } catch {
    /* signOut may complain outside request scope */
  }

  return Response.json({ ok: true });
}
