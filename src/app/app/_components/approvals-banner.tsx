"use client";

/**
 * Global approval banner — sticky under the topbar, visible on EVERY tab.
 *
 * Approvals can arrive any time (exec.approval.requested, plugin.approval.
 * requested). If the user is in /app/cron when one lands, they still need
 * to see and act on it without switching tabs. Tab-specific badges (pending
 * node pairs, etc.) remain inline in their own tab.
 *
 * For M8 scaffold: render a single amber strip with the count. Drawer for
 * approve/reject interaction lives in the Nodes/Automation tabs. Clicking
 * the banner navigates to the most appropriate tab.
 */
import Link from "next/link";
import { useAppStore } from "@/lib/app/store";
import { useI18n } from "@/lib/i18n/context";

export function ApprovalsBanner() {
  const { t } = useI18n();
  // approvalsCount is added by the approvals slice extension (see store.ts).
  // Until the slice lands it may be undefined — guard both shapes.
  const count = useAppStore(
    (s) => (s as unknown as { approvalsCount?: number }).approvalsCount ?? 0,
  );
  if (!count || count === 0) return null;
  const label =
    count === 1
      ? t.app.approvals.bannerSingle
      : t.app.approvals.bannerMulti.replace("{n}", String(count));
  return (
    <Link
      href="/app/nodes"
      className="flex items-center gap-3 border-y border-amber-400/30 bg-amber-400/10 px-4 py-2 backdrop-blur-xl transition hover:bg-amber-400/15"
    >
      <span className="size-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.85)]" />
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/90">
        approval
      </span>
      <span className="flex-1 text-xs font-semibold text-amber-100/90">
        {label}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/60">
        buka &rarr;
      </span>
    </Link>
  );
}
