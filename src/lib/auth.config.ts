import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auditLog } from "@/lib/security/audit-log";
import { trackEvent } from "@/lib/analytics/track";
import { isFlagEnabled } from "@/lib/admin/flags";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  // 7-day sessions with a rolling 24h refresh. Was unbounded → NextAuth's
  // 30-day default; the shorter window limits the blast radius of a stolen JWT.
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  providers: [
    // Google-OAuth-ONLY auth (Chief decision 2026-06-13). No credentials /
    // password path at all — Google owns identity, email verification, and
    // password recovery. `allowDangerousEmailAccountLinking` is SAFE here:
    // because no password account can ever be created, every account is a
    // unique, Google-verified email; the flag only smooths a pre-migration
    // account linking to Google and cannot be abused to hijack a password
    // account (none exist).
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    // Registration gate (Chief decision 2026-06-13): a brand-new account may
    // ONLY be created from the /register page, where the user actively ticked
    // the Terms + Privacy consent checkbox. This runs BEFORE the adapter's
    // createUser (see @auth/core handle-login: signIn callback fires first, and
    // returning a redirect string aborts the flow before account creation), so
    // a new user who skips consent never gets persisted.
    async signIn({ user, account }) {
      // Only Google OAuth exists; never block a non-OAuth path defensively.
      if (account?.provider !== "google") return true;

      const email = user?.email;
      if (!email) return true;

      // Returning user (a row already exists for this verified-Google email) —
      // they consented at their original signup, so always let them in. This is
      // also what makes /login work for existing users from either page.
      const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (existing) return true;

      // D13 — admin "tutup pendaftaran" flag. Existing users already returned
      // above; a brand-new account is refused while signups are disabled.
      if (await isFlagEnabled("signups.disabled")) {
        auditLog({
          event: "auth.register.blocked",
          outcome: "reject",
          actor: email,
          details: { reason: "signups_disabled" },
        });
        return "/login?error=SignupsClosed";
      }

      // Brand-new user. The register page stamps `agentbuff_auth_intent=register`
      // before starting OAuth (reachable only after the consent checkbox is
      // ticked); the login page stamps `login`. A new user without the register
      // intent is bounced to /register to consent first — no account is created.
      let intent: string | undefined;
      try {
        // Lazy import: a top-level `import { cookies } from "next/headers"`
        // breaks the auth route's module compile under Turbopack (worker crash
        // → every /api/auth/* returns 500 → login spins forever). Importing it
        // dynamically keeps it out of the static module graph; this callback
        // only runs inside the OAuth callback request scope, where next/headers
        // cookies() is valid.
        const { cookies } = await import("next/headers");
        intent = (await cookies()).get("agentbuff_auth_intent")?.value;
      } catch (err) {
        // Reading cookies should always work inside the OAuth route-handler
        // scope. If it ever throws, fail OPEN (allow the signup) rather than
        // hard-blocking every new registration; log loudly so we catch it.
        console.error(
          "[auth] consent-gate cookie read failed, allowing signup:",
          err instanceof Error ? err.message : String(err),
        );
        return true;
      }
      if (intent === "register") return true;

      auditLog({
        event: "auth.register.blocked",
        outcome: "reject",
        actor: email,
        details: { reason: "consent_required", intent: intent ?? "none" },
      });
      return "/register?needConsent=1";
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // Stash the RBAC role for UI/session convenience. The authoritative
        // /admin gate re-reads users.role from the DB (src/lib/admin/rbac.ts),
        // so a stale token can never claim admin even if this is out of date.
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id && session.user) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string | undefined) ?? "user";
        // Surface the impersonation marker (D1) so the /app banner + the stop
        // route can read it without decoding the raw JWT. Minted by the admin
        // impersonate route; the jwt callback preserves it across refreshes
        // (it only overwrites token fields when a fresh `user` is present).
        if (token.impersonatedBy) {
          session.user.impersonatedBy = token.impersonatedBy as string;
        }
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        // Seed the profile row (every account comes through Google OAuth).
        // onboarded defaults false → the /app layout gate sends the user to
        // /onboarding, which provisions the container on COMPLETION. We do NOT
        // provision here anymore (Phase 4 gate flip): a container is created
        // only after the user finishes onboarding, so we never spin up infra
        // for someone who bounces off signup.
        const [existing] = await db
          .select({ id: schema.userProfiles.id })
          .from(schema.userProfiles)
          .where(eq(schema.userProfiles.userId, user.id))
          .limit(1);

        if (!existing) {
          await db.insert(schema.userProfiles).values({
            userId: user.id,
            displayName: user.name ?? user.email?.split("@")[0],
          });
        }
        // Funnel analytics (F2, self-host) — fire-and-forget, fail-safe.
        trackEvent("register", { userId: user.id });
      }
    },
    async signIn({ user }) {
      if (user.id) {
        auditLog({ event: "auth.login", outcome: "ok", actor: user.id });
      }
    },
    async signOut(message) {
      const token = (message as { token?: { id?: unknown } }).token;
      const actor = token && typeof token.id === "string" ? token.id : null;
      auditLog({ event: "auth.logout", outcome: "ok", actor });
    },
  },
  pages: {
    signIn: "/login",
    // Brand-new accounts land on the onboarding flow first; the /app layout gate
    // is the real enforcer (handles users who navigate to /app directly).
    newUser: "/onboarding",
    // OAuth failures (AccessDenied, OAuthCallback, etc.) return to the branded
    // login page with ?error=… instead of NextAuth's bare default error page.
    error: "/login",
  },
});
