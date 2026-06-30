"use client";

import { useI18n } from "@/lib/i18n/context";
import { LegalPageLayout } from "./legal-page-layout";

export function PrivacyClient() {
  const { t } = useI18n();
  const p = t.legal.privacy;

  return (
    <LegalPageLayout
      heroTitle={p.heroTitle}
      sections={p.sections}
      pillars={p.pillars}
    />
  );
}
