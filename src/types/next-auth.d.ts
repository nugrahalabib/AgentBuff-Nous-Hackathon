// Module augmentation for the admin RBAC role (admin-panel foundation F1).
// NextAuth v5 already types `user.id`; we add `role` to Session.user, User, and
// the JWT so the auth callbacks + server components read it type-safely.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    // `impersonatedBy` is the admin userId when this session is an admin
    // impersonation (D1); undefined for a normal session.
    user: { id: string; role: string; impersonatedBy?: string } &
      DefaultSession["user"];
  }
  interface User {
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    impersonatedBy?: string;
  }
}
