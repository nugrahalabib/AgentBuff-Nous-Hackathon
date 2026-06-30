/**
 * Postgres foreign-key violation (SQLSTATE 23503) raised when an authenticated
 * JWT references a `user` row that no longer exists (deleted in a reset) and a
 * charge INSERTs into `transaction(user_id)`. The INSERT *correctly* fails — the
 * fix is to surface it as an auth problem (401 SESSION_INVALID) so the client
 * bounces to a fresh login, instead of a scary 500. Used by every billing charge
 * route so the three can't drift in how they handle a stale session.
 */
export function isStaleSessionError(e: unknown): boolean {
  return (e as { cause?: { code?: string } })?.cause?.code === "23503";
}
