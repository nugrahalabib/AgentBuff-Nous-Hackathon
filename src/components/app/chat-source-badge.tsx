"use client";

/**
 * SessionSourceBadge — shows where a chat session lives (Web vs which channel),
 * so a channel-originated conversation is unmistakable in the sidebar + header.
 * Channel sessions are read-only in the web UI (see the composer lock).
 */
import { Globe, MessageCircle, Send, Hash, MessageSquare, Radio, Lock, Mail } from "lucide-react";
import { classifySessionSource } from "@/lib/app/session-utils";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Globe> = {
  web: Globe,
  whatsapp: MessageCircle,
  telegram: Send,
  discord: Hash,
  slack: MessageSquare,
  google_chat: MessageCircle,
  email: Mail,
};

const TONES: Record<string, string> = {
  web: "border-white/15 bg-white/[0.05] text-white/55",
  whatsapp: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  telegram: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  discord: "border-indigo-400/30 bg-indigo-400/10 text-indigo-200",
  slack: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  google_chat: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  email: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

export function SessionSourceBadge({
  source,
  peerLabel,
  size = "sm",
  showLabel = true,
  showLock = false,
  showPeer = false,
  className,
}: {
  source?: string | null;
  /** Channel-side peer (e.g. "+6287877974096" or Telegram user id). When set
   *  and `showPeer`, the badge appends "· <peer>" so the chief can tell which
   *  contact a channel session belongs to. */
  peerLabel?: string | null;
  size?: "xs" | "sm";
  showLabel?: boolean;
  showLock?: boolean;
  showPeer?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const o = classifySessionSource(source);
  const Icon = ICONS[o.channel] ?? Radio;
  const tone = TONES[o.channel] ?? "border-white/15 bg-white/[0.05] text-white/55";
  const iconSize = size === "xs" ? "size-2.5" : "size-3";
  const peer = showPeer && o.kind === "channel" ? (peerLabel || "").trim() : "";
  return (
    <span
      title={
        o.kind === "channel"
          ? `${t.app.chat.source.channelTooltipPrefix} ${o.label}${peer ? ` · ${peer}` : ""}${o.accountId ? ` (${o.accountId})` : ""} — ${t.app.chat.source.channelTooltipSuffix} ${o.label}`
          : t.app.chat.source.webTooltip
      }
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border font-mono font-bold uppercase tracking-[0.12em]",
        size === "xs" ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]",
        tone,
        className,
      )}
    >
      <Icon className={cn(iconSize, "shrink-0")} aria-hidden />
      {showLabel ? <span className="shrink-0">{o.label}</span> : null}
      {peer ? (
        <span className="truncate font-semibold opacity-80">· {peer}</span>
      ) : null}
      {showLock && o.locked ? <Lock className={cn(iconSize, "shrink-0")} aria-hidden /> : null}
    </span>
  );
}
