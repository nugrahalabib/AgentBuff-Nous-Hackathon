"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { GatewayProvider } from "@/lib/app/gateway-provider";
import {
  EMPTY_ANSWERS,
  toAnswersPayload,
  type OnboardingAnswers,
} from "@/lib/onboarding/answers";
import {
  GhostButton,
  PrimaryButton,
  StepProgress,
  WizardCard,
} from "./primitives";
import {
  StepKenalan,
  StepPeran,
  StepQuest,
  isKenalanValid,
  isPeranValid,
  isQuestValid,
} from "./steps-early";
import {
  StepActivate,
  StepForge,
  isByokValid,
  isForgeValid,
} from "./steps-late";
import { StepByokLive } from "./step-byok-live";
import { OnboardingRail } from "./onboarding-rail";

const TOTAL_STEPS = 6;

type LaunchStatus = "idle" | "submitting" | "error";

export function OnboardingWizard({
  initialStep,
  initialAnswers,
}: {
  initialStep: number;
  initialAnswers: OnboardingAnswers;
}) {
  const { t } = useI18n();
  const o = t.onboarding;

  const [answers, setAnswers] = useState<OnboardingAnswers>({
    ...EMPTY_ANSWERS,
    ...initialAnswers,
  });
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 0), TOTAL_STEPS - 1));
  const [direction, setDirection] = useState<1 | -1>(1);
  const [saving, setSaving] = useState(false);
  const [launch, setLaunch] = useState<LaunchStatus>("idle");
  const [launchError, setLaunchError] = useState<string | undefined>();
  const [confirmRestart, setConfirmRestart] = useState(false);
  // Surface a failed save so "tap Lanjut, nothing happens" never reads as broken.
  const [saveError, setSaveError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  // Provision the user's container in the BACKGROUND once they reach the persona
  // step (3), so it's READY by the BYOK step (4) — which connects to the LIVE
  // container for real OAuth + key writes (no Postgres staging). Trial only
  // starts at Aktivasi, so an early container for an abandoner is reclaimed by
  // the stale-container cleanup cron, not charged.
  const [provisioning, setProvisioning] = useState(false);
  const [containerStatus, setContainerStatus] = useState<string | null>(null);
  const containerReady = containerStatus === "running";
  const containerFailed =
    containerStatus === "failed" || containerStatus === "destroyed";

  useEffect(() => {
    if (step < 3 || provisioning) return;
    setProvisioning(true);
    fetch("/api/users/me/container/retry", { method: "POST" }).catch(() => {});
  }, [step, provisioning]);

  const retryProvision = useCallback(() => {
    setContainerStatus(null);
    fetch("/api/users/me/container/retry", { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    if (
      !provisioning ||
      containerStatus === "running" ||
      containerStatus === "failed" ||
      containerStatus === "destroyed"
    )
      return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/users/me/container", { cache: "no-store" });
        if (res.ok && active) {
          const d = (await res.json()) as { status?: string };
          setContainerStatus(d.status ?? null);
        }
      } catch {
        /* transient — keep polling */
      }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [provisioning, containerStatus]);

  const set = useCallback(
    (patch: Partial<OnboardingAnswers>) =>
      setAnswers((a) => ({ ...a, ...patch })),
    [],
  );

  // Capture the browser's real timezone once — the most accurate per-user
  // signal (city is collected separately as a marketing label).
  useEffect(() => {
    if (answers.timezone) return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) set({ timezone: tz });
    } catch {
      /* ignore — backend falls back to the global default */
    }
  }, [answers.timezone, set]);

  const valid = [
    isKenalanValid,
    isPeranValid,
    isQuestValid,
    isForgeValid,
    isByokValid,
    () => true,
  ][step](answers);

  const saveProgress = useCallback(
    async (nextStep: number): Promise<boolean> => {
      try {
        const res = await fetch("/api/users/me/onboarding", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step: nextStep, answers: toAnswersPayload(answers) }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    [answers],
  );

  const goNext = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    const ok = await saveProgress(step + 1);
    setSaving(false);
    if (!ok) {
      // Keep answers in memory + the CTA enabled so the user can just retry,
      // but tell them WHY nothing advanced instead of failing silently.
      setSaveError(o.errors.network);
      return;
    }
    setDirection(1);
    setStep((s) => s + 1);
  };

  const goBack = () => {
    if (step === 0) return;
    setSaveError(null);
    setDirection(-1);
    setStep((s) => s - 1);
  };

  const restart = async () => {
    setConfirmRestart(false);
    try {
      await fetch("/api/users/me/onboarding", { method: "DELETE" });
    } catch {
      /* best-effort */
    }
    setAnswers({ ...EMPTY_ANSWERS, timezone: answers.timezone });
    setDirection(-1);
    setStep(0);
  };

  const mapError = (code: string): string => {
    switch (code) {
      case "INCOMPLETE":
        return o.errors.incomplete;
      case "INVALID_KEY":
        return o.errors.invalidKey;
      case "PROVISION_FAILED":
        return o.errors.provisionFailed;
      case "RATE_LIMITED":
        return o.errors.rateLimited;
      default:
        return o.errors.generic;
    }
  };

  const launchNow = async () => {
    setLaunch("submitting");
    setLaunchError(undefined);
    // Ensure the DB has the final answers before completion reads them.
    const saved = await saveProgress(TOTAL_STEPS);
    if (!saved) {
      setLaunch("error");
      setLaunchError(o.errors.network);
      return;
    }
    try {
      const res = await fetch("/api/users/me/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = (await res.json()) as { redirect?: string };
        window.location.href = data.redirect ?? "/app";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setLaunch("error");
      setLaunchError(mapError(data.error ?? "GENERIC"));
    } catch {
      setLaunch("error");
      setLaunchError(o.errors.network);
    }
  };

  const stepCta = [
    o.kenalan.cta,
    o.peran.cta,
    o.quest.cta,
    o.forge.cta,
    o.byok.cta,
  ][step];

  const isActivate = step === TOTAL_STEPS - 1;
  const hideFooter = isActivate && launch === "submitting";

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)] lg:items-start">
      <OnboardingRail
        answers={answers}
        step={step}
        total={TOTAL_STEPS}
        stepLabels={o.stepLabels}
        stepsLeftLabel={o.stepsLeftLabel}
        lastStepLabel={o.lastStepLabel}
        stepperNavLabel={o.stepperNavLabel}
      />
      <WizardCard>
      <StepProgress
        total={TOTAL_STEPS}
        current={step}
        valueText={`${o.stepOf
          .replace("{n}", String(step + 1))
          .replace("{total}", String(TOTAL_STEPS))} · ${o.stepLabels[step]}`}
      />

      <div className="flex items-center justify-between px-6 pt-1 pb-3 sm:px-8">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/80">
          {o.stepOf.replace("{n}", String(step + 1)).replace("{total}", String(TOTAL_STEPS))}{" "}
          · {o.stepLabels[step]}
        </span>
        {step > 0 && launch !== "submitting" ? (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-white/50 transition-colors hover:text-white/80"
          >
            <ArrowLeft className="size-3" />
            {o.backLabel}
          </button>
        ) : null}
      </div>

      <div className="min-h-[440px] px-6 pb-6 sm:px-8 sm:pb-8">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: reduceMotion ? 0 : direction * 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : direction * -36 }}
            transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: "easeOut" }}
          >
            {step === 0 && <StepKenalan answers={answers} set={set} />}
            {step === 1 && <StepPeran answers={answers} set={set} />}
            {step === 2 && <StepQuest answers={answers} set={set} />}
            {step === 3 && <StepForge answers={answers} set={set} />}
            {step === 4 &&
              (containerReady ? (
                <GatewayProvider>
                  <StepByokLive answers={answers} set={set} />
                </GatewayProvider>
              ) : (
                <ByokPreparing
                  title={o.byok.preparingTitle}
                  body={o.byok.preparingBody}
                  failed={containerFailed}
                  failTitle={o.errors.provisionFailed}
                  retryLabel={o.activate.retryLabel}
                  onRetry={retryProvision}
                />
              ))}
            {step === 5 && (
              <StepActivate
                answers={answers}
                status={launch}
                errorText={launchError}
                onLaunch={launchNow}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {!hideFooter ? (
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] bg-black/20 px-6 py-4 sm:px-8">
          {confirmRestart ? (
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-white/60">{o.restartConfirm}</span>
              <button
                type="button"
                onClick={restart}
                className="text-[12px] font-semibold text-red-300 hover:text-red-200"
              >
                {o.restartLabel}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRestart(false)}
                className="text-[12px] font-medium text-white/40 hover:text-white/70"
              >
                {o.restartCancel}
              </button>
            </div>
          ) : (
            <GhostButton onClick={() => setConfirmRestart(true)}>
              {o.restartLabel}
            </GhostButton>
          )}

          {!isActivate ? (
            <div className="flex flex-col items-end gap-1.5">
              {saveError ? (
                <span className="text-[11px] font-medium text-red-300" role="alert">
                  {saveError}
                </span>
              ) : null}
              <PrimaryButton
                onClick={goNext}
                disabled={!valid}
                loading={saving}
                icon={<ArrowRight className="size-4" />}
              >
                {stepCta}
              </PrimaryButton>
            </div>
          ) : null}
        </div>
      ) : null}
      </WizardCard>
    </div>
  );
}

// Shown on the BYOK step while the container is still booting in the background
// (or an error + retry if provisioning failed, so the user never gets stuck on
// an endless spinner).
function ByokPreparing({
  title,
  body,
  failed,
  failTitle,
  retryLabel,
  onRetry,
}: {
  title: string;
  body: string;
  failed: boolean;
  failTitle: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-red-500/40 bg-red-500/10 text-2xl">
          ⚠️
        </div>
        <h2 className="font-display text-lg font-bold">{failTitle}</h2>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-[13px] font-semibold text-cyan-200 transition-colors hover:bg-cyan-400/15"
        >
          {retryLabel}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <Loader2 className="size-9 animate-spin text-cyan-300" />
      <h2 className="font-display text-lg font-bold">{title}</h2>
      <p className="max-w-sm text-[13px] leading-relaxed text-white/55">{body}</p>
    </div>
  );
}
