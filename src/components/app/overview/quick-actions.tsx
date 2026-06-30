"use client";

/**
 * Quick Actions — Zone 4.
 *
 * 6 shortcut button: Chat Baru / Item Shop / Rekrut Agent / Saluran / Top Up
 * Energy / Quest Otomatis. Plus 7th tier-conditional: Upgrade ke OP Buff
 * (untuk Starter user).
 *
 * Pattern: Launchpad/Control Center — kasih jalan pintas ke action utama
 * yang user mungkin sering pengen lakukan dari halaman dashboard.
 *
 * Top Up Energy → buka popup window (sama dengan EnergyHero).
 * Tier upgrade → scroll ke /#item-shop landing untuk pricing card display.
 */
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CalendarClock,
  Crown,
  MessageSquarePlus,
  Radio,
  ShoppingBag,
} from "lucide-react";
import { useAppStore } from "@/lib/app/store";
import { useSubscriptionState } from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { openBillingPopup } from "@/lib/app/billing-popup";
import { cn } from "@/lib/utils";

export function QuickActions() {
  const { t } = useI18n();
  const router = useRouter();
  const subQ = useSubscriptionState();
  const createSession = useAppStore((s) => s.createSession);

  const isStarter =
    subQ.data?.tier === "starter" || subQ.data?.status === "starter_default";

  const handleNewChat = () => {
    void createSession();
    router.push("/app/chat");
  };

  const actions: Array<{
    key: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    accent?: "highlight" | "default";
  }> = [
    {
      key: "newChat",
      label: t.app.overview.quickActions.newChat,
      icon: <MessageSquarePlus className="size-4" />,
      onClick: handleNewChat,
      accent: "highlight",
    },
    {
      key: "itemShop",
      label: t.app.overview.quickActions.itemShop,
      icon: <ShoppingBag className="size-4" />,
      onClick: () => router.push("/app/shop"),
    },
    {
      key: "recruit",
      label: t.app.overview.quickActions.recruit,
      icon: <Bot className="size-4" />,
      onClick: () => router.push("/app/agents"),
    },
    {
      key: "channels",
      label: t.app.overview.quickActions.channels,
      icon: <Radio className="size-4" />,
      onClick: () => router.push("/app/agents"),
    },
    {
      key: "quest",
      label: t.app.overview.quickActions.quest,
      icon: <CalendarClock className="size-4" />,
      onClick: () => router.push("/app/cron"),
    },
  ];

  if (isStarter) {
    actions.push({
      key: "upgrade",
      label: t.app.overview.quickActions.upgradeOpBuff,
      icon: <Crown className="size-4" />,
      onClick: () => openBillingPopup("/checkout"),
      accent: "highlight",
    });
  }

  return (
    <section aria-label={t.app.overview.quickActions.title}>
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
        {t.app.overview.quickActions.title}
      </span>

      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            className={cn(
              "group inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition active:scale-[0.97]",
              a.accent === "highlight"
                ? "border-cyan-400/30 bg-gradient-to-br from-cyan-400/10 to-fuchsia-500/10 text-white hover:border-cyan-400/50 hover:from-cyan-400/15 hover:to-fuchsia-500/15"
                : "border-white/10 bg-white/[0.04] text-white/75 hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
            )}
          >
            <span
              className={cn(
                "shrink-0",
                a.accent === "highlight" ? "text-cyan-300" : "text-white/55 group-hover:text-white/80",
              )}
            >
              {a.icon}
            </span>
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
