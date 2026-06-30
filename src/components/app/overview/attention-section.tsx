"use client";

/**
 * Attention Section — Zone 3.
 *
 * Conditional render: hanya muncul kalau items.length > 0. Sumber data
 * dari /api/users/me/dashboard/attention (server-side aggregate dari
 * energy + container + subscription + skill-failed + future channel state).
 *
 * Tone:
 * - critical (red): action urgent, e.g. energy habis
 * - warning (amber): cautionary, e.g. expiring subscription
 * - info (cyan): nudge, e.g. tip/upgrade
 *
 * Action kinds:
 * - "navigate": router.push(href)
 * - "popup": open billing popup (energy vault) via openEnergyVaultPopup()
 * - "external": window.open new tab
 */
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Calendar,
  type LucideIcon,
  Package,
  PauseCircle,
  Power,
  Radio,
  Zap,
} from "lucide-react";
import {
  useAttention,
  useTodayStats,
  type AttentionItemResponse,
  type AttentionSeverity,
} from "@/hooks/use-api";
import { useI18n } from "@/lib/i18n/context";
import { openEnergyVaultPopup } from "@/lib/app/errors";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  Zap,
  PauseCircle,
  AlertTriangle,
  Power,
  Calendar,
  Package,
  Radio,
};

export function AttentionSection() {
  const { t } = useI18n();
  const { data, isLoading } = useAttention();
  const stats = useTodayStats();

  // ── Client-side derived alerts ───────────────────────────
  // Channel disconnect alert: server attention aggregator sengaja gak panggil
  // gateway RPC (avoid extra WS roundtrip). Channel state real-time hanya
  // tersedia via health RPC yang already di-fetch oleh useTodayStats.
  // De-duplikasi dengan ID stable supaya gak double kalau aggregator pernah
  // tambah channel-related alert di future.
  const derivedItems = useMemo<AttentionItemResponse[]>(() => {
    const items: AttentionItemResponse[] = [];
    const ch = stats.data?.channels;
    if (ch && ch.totalConfigured > 0 && ch.active < ch.totalConfigured) {
      const downCount = ch.totalConfigured - ch.active;
      items.push({
        id: "channel:disconnected",
        severity: "warning" as AttentionSeverity,
        icon: "Radio",
        title:
          downCount === 1
            ? "1 saluran putus"
            : `${downCount} saluran putus`,
        description:
          "Cek koneksi WhatsApp/Telegram/Discord biar agent bisa bales pelanggan lagi.",
        action: { label: "Cek Saluran", kind: "navigate", href: "/app/agents" },
      });
    }
    return items;
  }, [stats.data]);

  // Merge: server-driven (DB) + client-derived (gateway state). Client items
  // selalu di-append after server items, lalu re-sort by severity.
  const SEVERITY_RANK: Record<AttentionSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  const mergedItems = useMemo(() => {
    const serverItems = data?.items ?? [];
    const all = [...serverItems, ...derivedItems];
    // Dedupe by id (server takes precedence kalau collision).
    const seen = new Set<string>();
    const dedup: AttentionItemResponse[] = [];
    for (const item of all) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      dedup.push(item);
    }
    dedup.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    return dedup;
  }, [data?.items, derivedItems]);

  // No render saat loading initial atau zero items — supaya tidak ada blank
  // section di dashboard saat aman.
  if (isLoading || mergedItems.length === 0) return null;

  return (
    <section
      aria-label={t.app.overview.attention.title}
      className="rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-500/[0.04] via-[#0B0E14]/80 to-[#0B0E14]/80 p-4 backdrop-blur-xl sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-200"
        >
          <AlertTriangle className="size-3.5" strokeWidth={2.5} />
        </span>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-amber-200/85">
          {t.app.overview.attention.title}
        </span>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-amber-100">
          {mergedItems.length} {t.app.overview.attention.countSuffix}
        </span>
      </header>

      <ul className="flex flex-col gap-2">
        {mergedItems.map((item) => (
          <AttentionRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function AttentionRow({ item }: { item: AttentionItemResponse }) {
  const router = useRouter();
  const Icon = ICONS[item.icon] ?? AlertTriangle;

  const toneClass =
    item.severity === "critical"
      ? "border-red-500/30 bg-red-500/[0.06]"
      : item.severity === "warning"
        ? "border-amber-400/30 bg-amber-400/[0.06]"
        : "border-cyan-400/30 bg-cyan-400/[0.06]";

  const iconToneClass =
    item.severity === "critical"
      ? "border-red-500/30 bg-red-500/15 text-red-200"
      : item.severity === "warning"
        ? "border-amber-400/30 bg-amber-400/15 text-amber-200"
        : "border-cyan-400/30 bg-cyan-400/15 text-cyan-200";

  const handleAction = () => {
    if (!item.action) return;
    switch (item.action.kind) {
      case "navigate":
        router.push(item.action.href);
        break;
      case "popup":
        // Energy Vault popup pattern dari errors.ts. Untuk skill purchase
        // popup nanti, akan butuh dispatch berbeda — tapi MVP hanya energy.
        if (item.action.href.includes("/billing/energy")) {
          openEnergyVaultPopup();
        } else {
          // Fallback: open same-origin popup generic.
          window.open(
            item.action.href,
            "agentbuff-billing",
            "popup=yes,width=480,height=720",
          );
        }
        break;
      case "external":
        window.open(item.action.href, "_blank", "noopener,noreferrer");
        break;
    }
  };

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-start sm:gap-3",
        toneClass,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border",
          iconToneClass,
        )}
      >
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-white/95">{item.title}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-white/60">
          {item.description}
        </div>
      </div>
      {item.action ? (
        <button
          type="button"
          onClick={handleAction}
          className={cn(
            "shrink-0 rounded-lg border px-3 py-1.5 text-xs font-bold transition active:scale-[0.97]",
            item.severity === "critical"
              ? "border-red-500/40 bg-red-500/15 text-red-100 hover:bg-red-500/25"
              : item.severity === "warning"
                ? "border-amber-400/40 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25"
                : "border-cyan-400/40 bg-cyan-400/15 text-cyan-100 hover:bg-cyan-400/25",
          )}
        >
          {item.action.label}
        </button>
      ) : null}
    </li>
  );
}
