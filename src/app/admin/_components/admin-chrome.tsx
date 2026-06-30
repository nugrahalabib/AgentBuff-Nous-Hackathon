"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Store,
  Boxes,
  FileText,
  BarChart3,
  ScrollText,
  Settings,
  Megaphone,
  LifeBuoy,
  Tags,
  Terminal,
  LogOut,
  CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  adminOnly?: boolean; // hidden entirely from the support role
  danger?: boolean; // amber dot — destructive zone
};

type NavSection = { title?: string; items: NavItem[] };

// 5-section IA (Docs/admin-ux-redesign-plan.md). Ordered by daily-use frequency.
const SECTIONS: NavSection[] = [
  { items: [{ href: "/admin", label: "Dasbor", icon: LayoutDashboard }] },
  {
    title: "Operasi Harian",
    items: [
      { href: "/admin/pengguna", label: "Pengguna", icon: Users },
      { href: "/admin/dukungan", label: "Dukungan", icon: LifeBuoy },
      { href: "/admin/marketing", label: "Marketing", icon: Megaphone },
    ],
  },
  {
    title: "Uang & Paket",
    items: [
      { href: "/admin/transaksi", label: "Transaksi", icon: CreditCard },
      { href: "/admin/langganan", label: "Langganan & Trial", icon: CalendarClock },
      { href: "/admin/harga", label: "Harga & Kupon", icon: Tags, adminOnly: true },
    ],
  },
  {
    title: "Marketplace",
    items: [{ href: "/admin/marketplace", label: "Marketplace", icon: Store, adminOnly: true }],
  },
  {
    title: "Infra & Ops",
    items: [
      { href: "/admin/kontainer", label: "Kontainer", icon: Boxes, adminOnly: true },
      { href: "/admin/log", label: "Log & Monitoring", icon: ScrollText },
      { href: "/admin/analitik", label: "Analitik", icon: BarChart3 },
    ],
  },
  {
    title: "Konten & Sistem",
    items: [
      { href: "/admin/konten", label: "Konten", icon: FileText, adminOnly: true },
      { href: "/admin/pengaturan", label: "Pengaturan", icon: Settings, adminOnly: true },
      { href: "/admin/dev", label: "Dev Tools", icon: Terminal, adminOnly: true, danger: true },
    ],
  },
];

export function AdminNav({ role }: { role: string }) {
  const pathname = usePathname();
  const isAdmin = role === "admin";

  return (
    <nav className="flex flex-col gap-4">
      {SECTIONS.map((section, si) => {
        const items = section.items.filter((it) => !it.adminOnly || isAdmin);
        if (items.length === 0) return null;
        return (
          <div key={si} className="flex flex-col gap-0.5">
            {section.title && (
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">
                {section.title}
              </div>
            )}
            {items.map((item) => {
              const Icon = item.icon;
              const active =
                item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition",
                    active
                      ? "bg-cyan-500/10 font-medium text-cyan-100 ring-1 ring-cyan-500/20"
                      : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100",
                  )}
                >
                  <Icon className={cn("size-4", active ? "text-cyan-300" : "text-zinc-500")} />
                  <span className="flex-1">{item.label}</span>
                  {item.danger && <span className="size-1.5 rounded-full bg-amber-500" title="Zona berbahaya" />}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function AdminSignOut() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/" })}
      className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-100"
    >
      <LogOut className="size-3.5" />
      Keluar
    </button>
  );
}
