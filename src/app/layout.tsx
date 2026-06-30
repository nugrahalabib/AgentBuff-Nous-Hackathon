import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Analytics } from "@vercel/analytics/next";
import { plusJakarta, spaceGrotesk } from "@/lib/fonts";
import { siteConfig } from "@/lib/constants";
import { I18nProvider } from "@/lib/i18n/context";
import { resolveCmsOverrides } from "@/lib/cms/resolve";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { JsonLd } from "@/components/seo/json-ld";
import { SkipLink } from "@/components/layout/skip-link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.name} — Asisten AI Pribadi untuk Bisnis Kamu`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [
    "asisten AI",
    "AI untuk bisnis",
    "AI WhatsApp",
    "chatbot UMKM",
    "AI Indonesia",
    "agentbuff",
    "AI marketplace",
    "otomasi bisnis",
    "balas chat otomatis",
    "AI pribadi",
  ],
  authors: [{ name: siteConfig.creator }],
  creator: siteConfig.creator,
  metadataBase: new URL(siteConfig.url),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "id_ID",
    alternateLocale: "en_US",
    url: siteConfig.url,
    title: `${siteConfig.name} — Asisten AI Pribadi untuk Bisnis Kamu`,
    description: siteConfig.description,
    siteName: siteConfig.name,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: siteConfig.name,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@agentbuff",
    creator: "@agentbuff",
    title: `${siteConfig.name} — Asisten AI Pribadi untuk Bisnis Kamu`,
    description: siteConfig.description,
    images: ["/og-image.png"],
  },
  icons: {
    // Small 64px favicon (~8KB) so browser tabs don't decode the 512px logo.
    icon: "/favicon-64.png",
    apple: "/images/apple-icon.png",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  // Mobile browser chrome (address bar / PWA) matches the dark brand surface.
  themeColor: "#030014",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // D8: resolve published CMS overrides for both locales server-side so the
  // landing renders the admin-edited copy on first paint (no fallback flash).
  // Cached 30s; failure degrades to the hardcoded dictionary.
  const [idOverrides, enOverrides] = await Promise.all([
    resolveCmsOverrides("id").catch(() => ({})),
    resolveCmsOverrides("en").catch(() => ({})),
  ]);
  return (
    <html
      lang="id"
      className={`${plusJakarta.variable} ${spaceGrotesk.variable}`}
      suppressHydrationWarning
    >
      <body
        className="min-h-screen bg-background font-sans text-foreground antialiased"
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <AuthSessionProvider>
            <QueryProvider>
              <I18nProvider overrides={{ id: idOverrides, en: enOverrides }}>
                <SkipLink />
                {children}
              </I18nProvider>
            </QueryProvider>
          </AuthSessionProvider>
        </ThemeProvider>
        <JsonLd />
        <Analytics />
      </body>
    </html>
  );
}
