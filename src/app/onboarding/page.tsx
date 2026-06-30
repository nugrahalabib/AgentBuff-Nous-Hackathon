import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import { userProfiles } from "@/lib/db/schema";
import { fromAnswersPayload } from "@/lib/onboarding/answers";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export const dynamic = "force-dynamic";

// The onboarding gate target. A logged-in but not-yet-onboarded user lands here
// (redirected from /app by the layout gate). Completing the wizard provisions
// the container, forges the agent, and starts the 14-day trial — see the
// complete route. Already-onboarded users are bounced to /app.
export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?next=/onboarding");
  }

  const [profile] = await db
    .select({
      onboarded: userProfiles.onboarded,
      step: userProfiles.onboardingStep,
      answers: userProfiles.onboardingAnswers,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, session.user.id))
    .limit(1);

  if (profile?.onboarded) {
    redirect("/app");
  }

  const initialStep = profile?.step ?? 0;
  const initialAnswers = fromAnswersPayload(profile?.answers ?? null);
  // Prefill the call-name from the Google profile so a just-registered user
  // doesn't retype it (Chief: auto-tarik data, jangan input ulang). Only when
  // the user hasn't already entered one.
  if (!initialAnswers.nickname && session.user.name) {
    initialAnswers.nickname = session.user.name.trim().split(/\s+/)[0] ?? "";
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0B0E14] p-4 text-white">
      <div
        aria-hidden
        className="pointer-events-none fixed -left-40 top-10 z-0 size-[480px] rounded-full blur-[160px]"
        style={{
          background: "radial-gradient(closest-side, rgba(34,211,238,0.26), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -right-40 bottom-0 z-0 size-[520px] rounded-full blur-[180px]"
        style={{
          background: "radial-gradient(closest-side, rgba(217,70,239,0.2), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(99,102,241,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.4) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(ellipse at center, black 25%, transparent 80%)",
        }}
      />
      <div className="relative z-10 mx-auto w-full max-w-[1180px] py-8">
        <OnboardingWizard initialStep={initialStep} initialAnswers={initialAnswers} />
      </div>
    </main>
  );
}
