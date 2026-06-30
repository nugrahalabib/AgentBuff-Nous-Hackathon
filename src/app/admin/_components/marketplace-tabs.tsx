"use client";

import { useState } from "react";
import { SegmentedControl, TabIntro } from "./ui";
import { MarketplaceBrowser } from "./marketplace-browser";
import { SellersBrowser } from "./sellers-browser";
import { CommissionEditor } from "./commission-editor";
import { PayoutBrowser } from "./payout-browser";
import { CatalogManager } from "./catalog-manager";
import { SkillUninstallPanel } from "./skill-uninstall-panel";

type MarketplaceTab =
  | "catalog"
  | "listings"
  | "sellers"
  | "commission"
  | "payout"
  | "moderasi";

const TAB_OPTIONS: { value: MarketplaceTab; label: string; hint: string }[] = [
  {
    value: "catalog",
    label: "Katalog 1P",
    hint: "Etalase produk first-party (BuffHub) yang dijual di Shop.",
  },
  {
    value: "listings",
    label: "Listing",
    hint: "Moderasi semua listing marketplace lewat alur status (draft, pending, approved, published, delisted, rejected).",
  },
  {
    value: "sellers",
    label: "Seller",
    hint: "Kelola seller house + 3rd-party: komisi, suspend, rekening payout.",
  },
  {
    value: "commission",
    label: "Komisi",
    hint: "Rule potongan komisi: global, per-kategori, per-seller.",
  },
  {
    value: "payout",
    label: "Payout",
    hint: "Proses pencairan dana ke seller via Iris.",
  },
  {
    value: "moderasi",
    label: "Moderasi",
    hint: "Uninstall paksa skill dari kontainer pengguna.",
  },
];

export function MarketplaceTabs() {
  const [tab, setTab] = useState<MarketplaceTab>("catalog");

  return (
    <div className="space-y-4">
      <TabIntro
        eyebrow="OPS · MARKETPLACE"
        title="Marketplace"
        what="Pusat kendali toko: katalog first-party, moderasi listing, seller, rule komisi, dan pencairan payout. Datanya hidup di DB, ubah tanpa redeploy."
        canDo={[
          "Atur etalase produk first-party (BuffHub): judul, harga, status, tampilan.",
          "Moderasi listing marketplace lewat alur status yang sah (approve, tolak, delist).",
          "Kelola seller house + 3rd-party: komisi, suspend, rekening payout.",
          "Susun rule komisi (global, kategori, seller) dan proses payout via Iris.",
        ]}
        how="Pilih tab di bawah. Aksi yang memindahkan uang atau mengubah status produk akan minta konfirmasi terlebih dulu."
        legend={[
          { tone: "ok", label: "Aktif / published / cocok" },
          { tone: "warn", label: "Pending / menunggu review" },
          { tone: "bad", label: "Ditolak / delisted / suspended" },
          { tone: "muted", label: "Draft / belum tampil" },
        ]}
        warning="Tab Payout & Moderasi memindahkan uang dan menghapus skill milik pengguna — periksa target sebelum konfirmasi."
      />

      <SegmentedControl<MarketplaceTab>
        value={tab}
        onChange={setTab}
        options={TAB_OPTIONS}
      />

      {tab === "catalog" ? (
        <CatalogManager />
      ) : tab === "listings" ? (
        <MarketplaceBrowser />
      ) : tab === "sellers" ? (
        <SellersBrowser />
      ) : tab === "commission" ? (
        <CommissionEditor />
      ) : tab === "payout" ? (
        <PayoutBrowser />
      ) : (
        <SkillUninstallPanel />
      )}
    </div>
  );
}
