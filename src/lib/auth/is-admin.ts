// Allowlist gate for the raw Hermes engine dashboard (`/loby`) — an
// operator-only inspection surface used to audit each user's engine state.
// It must NEVER be exposed to end users.
//
// Admin emails come from the `ADMIN_EMAILS` env var (comma-separated). We FAIL
// CLOSED: if the var is unset/empty, nobody is an admin, so `/loby` bounces
// everyone to `/app` and the raw engine can never leak. To regain access, set
// `ADMIN_EMAILS` to the Google email(s) that should see the engine dashboard.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return false;
  const allow = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}
