import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { MotionProvider } from "@/components/providers/motion-provider";

export const metadata: Metadata = {
  title: "Masuk / Daftar",
  description:
    "Masuk atau daftar ke AgentBuff — asisten AI pribadi kamu. Setup cuma 2 menit.",
  // Auth pages are thin utility surfaces — keep them out of the search index
  // (still followable) so ranking signals concentrate on the landing page.
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // MotionProvider so the auth-surface framer-motion (mascot float, particles,
  // ring pulse) honors prefers-reduced-motion, same as the landing tree.
  return (
    <MotionProvider>
      <AuthShell>{children}</AuthShell>
    </MotionProvider>
  );
}
