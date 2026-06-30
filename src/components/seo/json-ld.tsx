import { siteConfig } from "@/lib/constants";
import { id } from "@/lib/i18n/dictionaries/id";
import { resolveEffectivePlans } from "@/lib/billing/pricing-resolver";
import { PLANS } from "@/lib/billing/plans";

// JSON-LD structured data. We render three entities on every page so search
// engines always have enough context:
//   1. Organization — brand identity, logo, social graph (sameAs).
//   2. WebSite — canonical URL + publisher. No SearchAction (we don't expose a
//      /search endpoint, so advertising one would yield a broken sitelinks box).
//   3. SoftwareApplication — product card metadata. Rupiah pricing, Indonesian
//      market. OP Buff is live (InStock); Full Managed is PreOrder (coming soon).
//      No aggregateRating yet (we don't collect verifiable reviews).
//
// Injected via <script type="application/ld+json"> at the end of <body>.
// suppressHydrationWarning because the JSON string is identical server/client
// but React sometimes flags dangerouslySetInnerHTML as a false positive.
export async function JsonLd() {
  const base = siteConfig.url;
  // Effective (admin-override-aware) prices so the structured-data offers track
  // the real catalog. Full Managed flips InStock once an admin sets it live.
  // SEO structured data must NEVER 500 the page — fall back to the static
  // catalog if the resolver (DB) is unavailable.
  let plans: Record<keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]>;
  try {
    plans = await resolveEffectivePlans();
  } catch {
    plans = PLANS;
  }
  const opMonthly = plans.op_buff.priceMonthly ?? 0;
  const fmMonthly = plans.full_managed.priceMonthly ?? 0;
  const fmLive = plans.full_managed.status === "live";

  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: base,
    logo: `${base}/images/logo.png`,
    description: siteConfig.description,
    founder: {
      "@type": "Person",
      name: siteConfig.creator,
    },
    sameAs: [
      siteConfig.links.twitter,
      siteConfig.links.instagram,
      siteConfig.links.tiktok,
      siteConfig.links.discord,
    ],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      url: siteConfig.whatsapp,
      availableLanguage: ["Indonesian", "English"],
    },
  };

  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: base,
    inLanguage: "id-ID",
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: base,
    },
  };

  const softwareApplication = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteConfig.name,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: siteConfig.description,
    url: base,
    image: `${base}/og-image.png`,
    offers: [
      {
        "@type": "Offer",
        name: "OP Buff",
        price: String(opMonthly),
        priceCurrency: "IDR",
        availability: "https://schema.org/InStock",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: String(opMonthly),
          priceCurrency: "IDR",
          billingIncrement: 1,
          unitCode: "MON",
        },
      },
      {
        "@type": "Offer",
        name: "Full Managed",
        price: String(fmMonthly),
        priceCurrency: "IDR",
        availability: fmLive
          ? "https://schema.org/InStock"
          : "https://schema.org/PreOrder",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: String(fmMonthly),
          priceCurrency: "IDR",
          billingIncrement: 1,
          unitCode: "MON",
        },
      },
    ],
    creator: {
      "@type": "Organization",
      name: siteConfig.name,
      url: base,
    },
  };

  // FAQPage mirrors the on-page FAQ accordion verbatim (default-locale copy).
  // Sourced from the id dictionary so the structured data can never drift from
  // what visitors actually read.
  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: id.faq.items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }}
      />
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(website) }}
      />
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplication) }}
      />
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPage) }}
      />
    </>
  );
}
