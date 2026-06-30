import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { provisionContainer } from "@/lib/hermes/docker";
import { hermesConfig } from "@/lib/hermes/config";
import { LobyWaiting } from "@/components/loby/loby-waiting";
import { isAdminEmail } from "@/lib/auth/is-admin";

export const dynamic = "force-dynamic";

/**
 * /loby — gateway to the user's raw Hermes admin dashboard.
 *
 *   - No container row yet → provision Hermes in background, show waiting
 *     spinner.
 *   - Container row but not running → waiting spinner (status / error).
 *   - Container running → server redirect to the per-container Hermes
 *     dashboard (`hermes dashboard` web UI on port 9119 inside the
 *     container, published to `127.0.0.1:<port + dashboardPortOffset>`).
 *
 * Why two surfaces:
 *   - `/app` is the custom AgentBuff React UI — what end-users get after
 *     login. Default landing after auth.
 *   - `/loby` is the raw Hermes admin UI — what chief uses to inspect
 *     engine state directly + compare against /app feature coverage.
 *     Same role `/loby` had pre-migration for the per-port OpenClaw
 *     Lit UI.
 *
 * Dashboard auths transparently: Hermes injects its ephemeral session
 * token into the index HTML at serve time (window.__HERMES_SESSION_TOKEN__),
 * so the browser tab gets auth on first GET. No login page, no token
 * fragment to mess with.
 */
export default async function LobyPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?next=/loby");

  // /loby renders the RAW Hermes engine dashboard — an operator-only audit
  // surface for inspecting each user's engine state. End users must NEVER land
  // here; bounce them to the custom AgentBuff app. Admins are allowlisted via
  // the ADMIN_EMAILS env var (fail closed: empty list = nobody).
  if (!isAdminEmail(session.user.email)) redirect("/app");

  const userId = session.user.id;

  const [row] = await db
    .select()
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  if (!row) {
    provisionContainer(userId).catch((err) =>
      console.error("[loby] hermes provision failed:", err),
    );
    return <LobyWaiting initialStatus="queued" />;
  }

  if (row.status !== "running") {
    return (
      <LobyWaiting
        initialStatus={row.status}
        errorMessage={row.errorMessage ?? undefined}
      />
    );
  }

  // Compute the dashboard's host-side port. Deterministic offset from
  // the bridge port keeps us from needing a 2nd column in user_container.
  const host = hermesConfig.publicHost;
  const dashboardPort = row.port + hermesConfig.dashboardPortOffset;
  redirect(`http://${host}:${dashboardPort}/`);
}
