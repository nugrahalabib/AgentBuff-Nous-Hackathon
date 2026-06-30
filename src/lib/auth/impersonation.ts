// D1 — admin impersonation (login-as) session minting. Crafts a NextAuth JWT for
// a target user and writes it into the session cookie, preserving an
// `impersonatedBy` marker so the /app banner + the stop route can unwind it and
// every admin route still re-reads the IMPERSONATED user's DB role (so the
// impersonator drops admin power while acting as a regular user).
//
// Salt = the session cookie name (how Auth.js v5 derives the JWT salt); secret +
// secure-cookie logic mirror src/lib/hermes/ws-proxy.ts exactly so the minted
// token round-trips through `auth()`.
import { encode } from "next-auth/jwt";
import { cookies } from "next/headers";

const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // matches auth.config session.maxAge

function authSecret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET/NEXTAUTH_SECRET not configured");
  return s;
}

function isSecureCookie(): boolean {
  return !!process.env.AUTH_URL && process.env.AUTH_URL.startsWith("https://");
}

function sessionCookieName(): string {
  return isSecureCookie()
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

export type SessionTokenPayload = {
  id: string;
  role: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
  impersonatedBy?: string;
};

/** Mint a session JWT for `payload` and write it into the session cookie. The
 *  caller is responsible for authz + audit; this only handles the crypto/cookie. */
export async function writeSessionCookie(
  payload: SessionTokenPayload,
): Promise<void> {
  const name = sessionCookieName();
  const token = await encode({
    token: {
      ...payload,
      sub: payload.id,
    },
    secret: authSecret(),
    salt: name,
    maxAge: SESSION_MAX_AGE,
  });
  const store = await cookies();
  store.set(name, token, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}
