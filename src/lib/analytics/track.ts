// NOTE: no `import "server-only"` here. trackEvent is pulled into the plain-Node
// custom-server chain (server.ts → reconcile-worker → settle → track), where the
// `server-only` shim cannot resolve (it only exists under Next's react-server
// bundler condition). This module is server-side by construction anyway — it
// imports the postgres-backed `db`, which can never run in a client bundle.
import { db } from "@/lib/db";
import { analyticsEvents } from "@/lib/db/schema";

export type TrackOpts = {
  userId?: string | null;
  anonId?: string | null;
  sessionId?: string | null;
  props?: Record<string, unknown>;
  utm?: Record<string, unknown>;
};

/**
 * Self-hosted analytics capture (admin-panel foundation F2 — NO 3rd party).
 * Fire-and-forget + fail-safe: a tracking failure must NEVER break the request
 * that triggered it. Inserts one row into analytics_event. Wire this at funnel
 * steps (register, onboarding-complete, trial-active, first-chat, settle, churn)
 * as those surfaces are built; the rollup worker (F4) aggregates into
 * daily_rollup for the admin dashboard.
 */
export function trackEvent(event: string, opts: TrackOpts = {}): void {
  void db
    .insert(analyticsEvents)
    .values({
      event,
      userId: opts.userId ?? null,
      anonId: opts.anonId ?? null,
      sessionId: opts.sessionId ?? null,
      props: opts.props,
      utm: opts.utm,
    })
    .catch(() => {
      /* best-effort: swallow so analytics never breaks the caller */
    });
}
