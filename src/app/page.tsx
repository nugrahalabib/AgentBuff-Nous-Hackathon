import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { HomeHero } from "@/components/home/hero";
import { HomeModelMarquee } from "@/components/home/model-marquee";
import { HomeStatusPanel } from "@/components/home/status-panel";
import { HomeSkillTree } from "@/components/home/skill-tree";
import { HomeCustomAgent } from "@/components/home/custom-agent";
import { HomeVsComparison } from "@/components/home/vs-comparison";
import { HomeWallOfFame } from "@/components/home/wall-of-fame";
import { HomeItemShop } from "@/components/home/item-shop";
import { HomeFaq } from "@/components/home/faq";
import { WhatsAppFloat } from "@/components/shared/whatsapp-float";
import { StickyMobileCTA } from "@/components/shared/sticky-mobile-cta";
import { MotionProvider } from "@/components/providers/motion-provider";

export default function HomePage() {
  return (
    <MotionProvider>
      <Navbar />
      <main id="main-content">
        <HomeHero />
        <HomeModelMarquee />
        <HomeStatusPanel />
        <HomeSkillTree />
        <HomeCustomAgent />
        <HomeVsComparison />
        <HomeWallOfFame />
        <HomeItemShop />
        <HomeFaq />
      </main>
      <Footer />
      <WhatsAppFloat />
      <StickyMobileCTA />
    </MotionProvider>
  );
}
