"use client";

/**
 * Category rail for /app/pengaturan — mirrors the ChatSubSidebar slot (sits
 * between the main nav and the settings content). Lets the user see every
 * settings category at a glance and jump straight to one. Active category is
 * tracked via IntersectionObserver on the page's scroll container so it stays
 * in sync as the user scrolls. Pure client / DOM — no engine call.
 */
import type { ComponentType } from "react";
import {
  BrainCircuit,
  KeyRound,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserX,
  Volume2,
} from "lucide-react";
import { SETTINGS_SECTIONS } from "@/components/app/settings/sections";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Sparkles,
  Volume2,
  BrainCircuit,
  ShieldCheck,
  Palette,
  KeyRound,
  UserX,
};

export function SettingsSubSidebar() {
  const { t } = useI18n();
  const s = t.app.settings;
  const active = useAppStore((st) => st.settingsCategory);
  const setActive = useAppStore((st) => st.setSettingsCategory);

  return (
    <aside className="flex h-full w-56 flex-col rounded-2xl border border-white/[0.06] bg-[#0B0E14]/60 p-2 backdrop-blur-xl">
      <div className="flex items-center gap-1.5 px-2 py-2">
        <SlidersHorizontal className="size-3 text-cyan-300/70" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
          {s.navTitle}
        </span>
      </div>
      <nav className="flex flex-col gap-0.5">
        {SETTINGS_SECTIONS.map((sec) => {
          const Icon = ICONS[sec.icon] ?? SlidersHorizontal;
          const isActive = active === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              onClick={() => setActive(sec.id)}
              className={cn(
                "group relative flex items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left text-sm transition",
                isActive
                  ? "bg-white/[0.06] text-white"
                  : "text-white/55 hover:bg-white/[0.03] hover:text-white/90",
              )}
            >
              <span
                className={cn(
                  "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full transition",
                  isActive
                    ? "bg-gradient-to-b from-cyan-400 to-fuchsia-500 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
                    : "bg-transparent",
                )}
                aria-hidden
              />
              <Icon
                className={cn(
                  "size-4 shrink-0 transition",
                  isActive ? "text-cyan-200" : "text-white/45 group-hover:text-white/70",
                )}
              />
              <span className="truncate">{s.sections[sec.id].title}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
