"use client";

import { useI18n } from "@/lib/i18n/context";

/**
 * WCAG 2.4.1 (Bypass Blocks) — the first focusable element on the page. Hidden
 * until focused, then jumps a keyboard / screen-reader user straight to
 * `<main id="main-content">`, past the fixed navbar.
 */
export function SkipLink() {
  const { t } = useI18n();
  return (
    <a
      href="#main-content"
      className="sr-only rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200]"
    >
      {t.nav.skipToContent}
    </a>
  );
}
