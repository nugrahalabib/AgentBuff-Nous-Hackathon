import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/constants";

// PWA manifest. `display: "standalone"` makes "Add to Home Screen" on
// Android/iOS open without browser chrome. `theme_color` matches the
// landing background so the status bar blends on mobile.
//
// Icons: we ship one 512x512 maskable + one 180x180 Apple touch variant.
// Next 16 auto-routes /icon.png + /apple-icon.png via src/app conventions,
// and /images/icon-512.png is a spare for manifest-only referencing.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AgentBuff — Asisten AI Pribadi untuk Bisnis",
    short_name: "AgentBuff",
    description: siteConfig.description,
    start_url: "/",
    display: "standalone",
    background_color: "#030014",
    theme_color: "#030014",
    orientation: "portrait-primary",
    lang: "id",
    categories: ["productivity", "business", "utilities"],
    icons: [
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/images/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
