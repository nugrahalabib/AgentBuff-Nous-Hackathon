// Auth module — NextAuth v5 re-exports only.
// Server-side: import { auth } from "@/lib/auth.config" directly.
// Client-side: import { useSession, signIn, signOut } from "next-auth/react" directly.
//
// This file is kept for backward compatibility but all consumers
// should import from next-auth/react or auth.config directly.

export { auth as getServerSession } from "./auth.config";
