import { ShopTab, type ShopSection } from "@/components/app/tabs/shop-tab";

export const dynamic = "force-dynamic";

// ?tab=langganan|energy deep-links straight to that section (e.g. the
// "Perpanjang langganan" button on the Riwayat page). Resolved here on the
// server so the right tab renders immediately — no client flash.
export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tab = (await searchParams).tab;
  const initialSection: ShopSection =
    tab === "langganan" || tab === "energy" ? tab : "market";
  return <ShopTab initialSection={initialSection} />;
}
