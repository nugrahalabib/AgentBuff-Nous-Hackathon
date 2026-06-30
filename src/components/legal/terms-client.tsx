"use client";

import { useI18n } from "@/lib/i18n/context";
import { LegalPageLayout } from "./legal-page-layout";

export function TermsClient() {
  const { t } = useI18n();
  const ts = t.legal.terms;

  return (
    <LegalPageLayout
      heroTitle={ts.heroTitle}
      sections={ts.sections}
    />
  );
}
