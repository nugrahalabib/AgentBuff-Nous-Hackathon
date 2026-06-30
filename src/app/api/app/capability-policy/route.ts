import { auth } from "@/lib/auth.config";
import { resolveCapabilityPolicy } from "@/lib/admin/capability-policy";

// D13 — the /app client reads this once to hydrate the capability predicate store
// (setCapabilityPolicy). Authenticated users only; returns the admin-set hide/lock
// lists (all empty by default = mirror-engine). No write here.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    return Response.json(await resolveCapabilityPolicy());
  } catch {
    // Fail open to the mirror-engine default — never break the picker on a hiccup.
    return Response.json({
      hiddenSkills: [],
      hiddenToolsets: [],
      essentialToolsets: [],
      essentialSkills: [],
    });
  }
}
