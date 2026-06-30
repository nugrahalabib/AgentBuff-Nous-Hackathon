import type { Metadata } from "next";

import { Navbar } from "@/components/layout/navbar";
import { MotionProvider } from "@/components/providers/motion-provider";
import { ShopTab } from "@/components/app/tabs/shop-tab";

export const metadata: Metadata = {
  title: "Item Shop — AgentBuff",
  description:
    "Jelajahi skill & app untuk agent AI-mu. Lihat-lihat gratis; login untuk install & aktifin dari dalam app.",
};

// Public, read-only marketplace. Renders the EXACT same component as the in-app
// Item Shop (`ShopTab`), just in `publicMode` — so design + content stay one
// single source of truth. Every buy/waitlist/subscribe action gates to login;
// logged-in users do the real thing inside /app/shop. `ShopTab` fetches the
// public catalog client-side (`/api/skills/buffhub`).
//
// Navbar is `fixed h-16`, so the shell is `h-[100dvh]` with `pt-16` to give
// ShopTab's internal scroll a bounded height below the bar.
export default function MarketplacePage() {
  return (
    <MotionProvider>
      <Navbar />
      <main
        id="main-content"
        className="h-[100dvh] bg-[#0B0E14] pt-16 text-white"
      >
        <ShopTab publicMode />
      </main>
    </MotionProvider>
  );
}
