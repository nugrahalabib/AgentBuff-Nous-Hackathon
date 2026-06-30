"use client";

/**
 * AccountLocaleSync — on /app load, pull the per-ACCOUNT UI language
 * (user_profile.locale) and apply it via the i18n context. localStorage alone
 * only covers the same browser; this makes the language choice follow the user
 * across devices/browsers. One-time fetch, renders nothing.
 *
 * The Settings "Bahasa tampilan" control writes both (i18n+localStorage instantly
 * AND PUT /api/users/me/profile), so on the same browser DB == localStorage and
 * this is a no-op. The only visible switch is on a fresh device where
 * localStorage is empty but the account has a saved preference.
 */
import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useAppStore } from "@/lib/app/store";

export function AccountLocaleSync() {
  const { locale, setLocale } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const setShowToolProgress = useAppStore((s) => s.setShowToolProgress);

  // Hydrate the web chat-verbosity pref (per-browser, localStorage) on load.
  useEffect(() => {
    try {
      if (localStorage.getItem("agentbuff:app:tool-progress") === "0") {
        setShowToolProgress(false);
      }
    } catch {
      /* default (show) */
    }
  }, [setShowToolProgress]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const lc = data?.profile?.locale;
        if ((lc === "id" || lc === "en") && lc !== localeRef.current) {
          setLocale(lc);
        }
      })
      .catch(() => {
        /* best-effort — localStorage default already applied */
      });
    return () => {
      cancelled = true;
    };
  }, [setLocale]);

  return null;
}
