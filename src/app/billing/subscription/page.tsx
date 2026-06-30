import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /billing/subscription is RETIRED — the exclusive subscription checkout now
// lives at /checkout (full-page + Snap embed, all payment methods). Kept as a
// redirect so any in-flight popup, bookmark, or stale notification/email link
// still works; ?parent is forwarded so the popup postMessage settle flow holds.
export default async function SubscriptionBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parent = typeof sp.parent === "string" ? sp.parent : "";
  redirect(`/checkout${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`);
}
