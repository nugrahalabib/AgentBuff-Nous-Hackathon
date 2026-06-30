"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import { id } from "./dictionaries/id";
import { en } from "./dictionaries/en";
import { applyDotPathOverrides } from "./apply-overrides";
import { setSessionUtilsLocale } from "@/lib/app/session-utils";
import { setToolDisplayLocale } from "@/lib/app/tool-display";
import { setErrorsLocale } from "@/lib/app/errors";
import type { Dictionary } from "./types";

export type Locale = "id" | "en";

/** Flat { "dot.path": value } CMS overrides per locale (D8 landing CMS).
 *  Resolved server-side and passed from the root layout; absent = use the
 *  hardcoded dictionary. */
export type CmsOverrides = Partial<Record<Locale, Record<string, unknown>>>;

const dictionaries: Record<Locale, Dictionary> = { id, en };

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Dictionary;
}

const I18nContext = createContext<I18nContextType | null>(null);

const LOCALE_KEY = "agentbuff.locale";

export function I18nProvider({
  children,
  overrides,
}: {
  children: React.ReactNode;
  overrides?: CmsOverrides;
}) {
  const [locale, setLocaleState] = useState<Locale>("id");

  // Merge CMS overrides over the static dictionaries once (both locales, so the
  // client locale toggle works without a refetch). No overrides = identity.
  const merged = useMemo<Record<Locale, Dictionary>>(
    () =>
      overrides
        ? {
            id: applyDotPathOverrides(dictionaries.id, overrides.id),
            en: applyDotPathOverrides(dictionaries.en, overrides.en),
          }
        : dictionaries,
    [overrides],
  );

  useEffect(() => {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === "en" || stored === "id") {
      // Intentional post-mount setState: localStorage isn't available during SSR,
      // so the locale must default to "id" for the server render and be synced
      // here on the client to avoid a hydration mismatch. A lazy useState
      // initializer reading localStorage would mismatch server vs client.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocaleState(stored);
      document.documentElement.lang = stored;
      setSessionUtilsLocale(stored);
      setToolDisplayLocale(stored);
      setErrorsLocale(stored);
    } else {
      setSessionUtilsLocale("id");
      setToolDisplayLocale("id");
      setErrorsLocale("id");
    }
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    document.documentElement.lang = newLocale;
    localStorage.setItem(LOCALE_KEY, newLocale);
    setSessionUtilsLocale(newLocale);
    setToolDisplayLocale(newLocale);
    setErrorsLocale(newLocale);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t: merged[locale] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within I18nProvider");
  return context;
}
