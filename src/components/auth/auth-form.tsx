"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Info, Loader2 } from "lucide-react";
import { signIn } from "next-auth/react";
import { useI18n } from "@/lib/i18n/context";
import { clearAgentbuffClientState } from "@/lib/app/client-state-reset";

type Mode = "login" | "register";

/**
 * Google-OAuth-ONLY auth (Chief decision 2026-06-13). There is no password
 * form, no register endpoint, no reset flow — Google owns identity, email
 * verification, and recovery. Login and register are the same action; `mode`
 * only varies the surrounding copy.
 */
export function AuthForm({
  mode,
  needConsent = false,
  oauthError = false,
  next,
}: {
  mode: Mode;
  needConsent?: boolean;
  oauthError?: boolean;
  next?: string;
}) {
  const { t } = useI18n();
  const copy = mode === "login" ? t.auth.login : t.auth.register;
  const [loading, setLoading] = useState(false);
  // Post-auth destination: honor a same-origin `?next=` (deep-link bounce),
  // else the app. The `//` guard blocks protocol-relative open-redirects.
  const callbackUrl =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
  // Register requires explicit consent: the Google CTA stays locked until the
  // user ticks the Terms + Privacy checkbox. Login users already consented at
  // signup, so the gate only applies in register mode.
  const [agreed, setAgreed] = useState(false);
  const consentBlocked = mode === "register" && !agreed;

  const onGoogleSso = () => {
    if (loading || consentBlocked) return;
    setLoading(true);
    // Wipe ALL stale AgentBuff client state from any previous user before
    // switching session. Must match the bare "agentbuff" prefix — the live
    // /app keys use a colon namespace ("agentbuff:app:*"), which the old
    // dot-only match silently skipped, leaking one user's drafts/notes/history
    // into the next account on a shared browser (cross-user audit 2026-06-15).
    clearAgentbuffClientState();
    // Stamp the registration-consent intent for the server-side signIn gate
    // (auth.config.ts). Only /register — reachable here only once the consent
    // checkbox is ticked — sends `register`; /login sends `login`, which the
    // gate treats as existing-users-only and bounces new signups to /register.
    // Lax + short-lived so it survives the OAuth round-trip without lingering.
    document.cookie = `agentbuff_auth_intent=${mode}; path=/; max-age=600; samesite=lax`;
    signIn("google", { callbackUrl });
  };

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col gap-6"
    >
      {/* Header */}
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-[2.1rem]">
          {copy.headline}{" "}
          <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">
            {copy.headlineHighlight}
          </span>
          .
        </h1>
        <p className="text-sm leading-relaxed text-white/60">{copy.subheadline}</p>
      </div>

      {/* Google OAuth failed → NextAuth bounced back here with ?error= */}
      {oauthError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-3 text-[13px] leading-relaxed text-red-100"
        >
          <Info aria-hidden className="mt-px size-4 shrink-0 text-red-300" />
          <span>{t.auth.login.oauthError}</span>
        </div>
      )}

      {/* Bounced here by the registration gate — explain why + nudge consent */}
      {mode === "register" && needConsent && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-3 text-[13px] leading-relaxed text-amber-100"
        >
          <Info aria-hidden className="mt-px size-4 shrink-0 text-amber-300" />
          <span>{t.auth.register.needConsentNotice}</span>
        </div>
      )}

      {/* Consent checkbox (register only) — gates the Google CTA below.
          Defaults UNCHECKED: the user must actively opt in, never pre-ticked. */}
      {mode === "register" && (
        <label className="flex cursor-pointer select-none items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 transition-colors hover:border-white/20">
          <span className="relative mt-px flex size-5 shrink-0 items-center justify-center">
            <input
              id="agree-consent"
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="peer size-5 cursor-pointer appearance-none rounded-md border border-white/30 bg-white/[0.04] transition-colors checked:border-transparent checked:bg-gradient-to-br checked:from-cyan-400 checked:to-fuchsia-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0E14]"
            />
            <Check
              aria-hidden
              strokeWidth={3.5}
              className="pointer-events-none absolute size-3.5 text-[#0B0E14] opacity-0 transition-opacity peer-checked:opacity-100"
            />
          </span>
          <span id="consent-label" className="text-[13px] font-medium leading-relaxed text-white/80">
            {t.auth.register.agreement}{" "}
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-semibold text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline"
            >
              {t.auth.register.agreementTerms}
            </Link>{" "}
            {t.auth.register.agreementAnd}{" "}
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-semibold text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline"
            >
              {t.auth.register.agreementPrivacy}
            </Link>
            .
          </span>
        </label>
      )}

      {/* Google — the only sign-in method */}
      <button
        type="button"
        onClick={onGoogleSso}
        disabled={loading || consentBlocked}
        aria-busy={loading}
        aria-describedby={consentBlocked ? "consent-label" : undefined}
        className="group relative flex h-12 w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-white px-4 text-sm font-semibold text-slate-900 shadow-[0_10px_30px_-10px_rgba(255,255,255,0.3)] transition-all hover:shadow-[0_14px_36px_-10px_rgba(255,255,255,0.45)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {copy.ctaLoading}
          </>
        ) : (
          <>
            <GoogleIcon />
            {copy.google}
          </>
        )}
        <span
          aria-hidden
          className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-cyan-200/40 to-transparent transition-transform duration-700 group-hover:translate-x-full"
        />
      </button>

      {/* Switch mode */}
      <div className="flex items-center justify-center gap-1.5 border-t border-white/5 pt-5 text-sm">
        <span className="text-white/55">{copy.switchPrompt}</span>
        <Link
          href={mode === "login" ? "/register" : "/login"}
          className="font-semibold text-cyan-300 transition-colors hover:text-cyan-200"
        >
          {copy.switchLink}
        </Link>
      </div>
    </motion.div>
  );
}

function GoogleIcon() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.12A6.96 6.96 0 0 1 5.47 12c0-.73.13-1.44.37-2.12V7.04H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.96l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.61 0 3.06.55 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.04l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}
