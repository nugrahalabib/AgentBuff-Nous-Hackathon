import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getSkill } from "@/lib/billing/skill-catalog";
import { SkillCheckoutClient } from "./skill-checkout-client";

export const dynamic = "force-dynamic";

export default async function SkillBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await params;
  const skill = await getSkill(key);
  if (!skill) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center space-y-3">
        <p className="text-sm text-white/70">
          Skill ini tidak ditemukan atau sudah tidak tersedia.
        </p>
        <a
          href="/marketplace"
          className="inline-block rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-sm text-white/80 transition hover:border-cyan-400/40 hover:text-white"
        >
          Lihat katalog lain
        </a>
      </div>
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    const sp = await searchParams;
    const parent = typeof sp.parent === "string" ? sp.parent : "";
    const next = `/billing/skill/${encodeURIComponent(key)}?parent=${encodeURIComponent(parent)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(next)}`);
  }

  return (
    <SkillCheckoutClient
      skillKey={skill.key}
      title={skill.title}
      description={skill.description}
      priceRp={skill.priceRp}
    />
  );
}
