"use client";

/**
 * TabPlaceholder — SectionHeader + "coming soon" EmptyState scaffold. All
 * 17 non-chat tabs start here so the shell has coverage day 1; each tab
 * replaces the body as its slice + RPC wiring lands.
 *
 * Design: basecamp M7 glass, full-height flex column, scrollable body.
 */
import type { LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { SectionHeader } from "./section-header";
import { EmptyState } from "./empty-state";

export function TabPlaceholder({
  eyebrow,
  title,
  subtitle,
  icon,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  icon?: LucideIcon;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          icon={icon}
          title={t.app.shared.comingSoon}
          subtitle={t.app.shared.comingSoonSubtitle}
        />
      </div>
    </div>
  );
}
