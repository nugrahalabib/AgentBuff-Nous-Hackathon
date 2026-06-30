"use client";

import { useCallback, useEffect, useState } from "react";
import { Stethoscope, ChevronDown, AlertTriangle, AlertCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/app/store";

type Diag = { kind: string; severity: string; title: string; detail: string; count?: number };
type DiagItem = { taskId: string; title: string; status: string; diagnostics: Diag[] };

const SEV_META: Record<string, { icon: typeof Info; cls: string }> = {
  error: { icon: AlertCircle, cls: "text-red-300" },
  critical: { icon: AlertCircle, cls: "text-red-300" },
  warning: { icon: AlertTriangle, cls: "text-amber-300" },
  warn: { icon: AlertTriangle, cls: "text-amber-300" },
  info: { icon: Info, cls: "text-cyan-300" },
};

export function KanbanDiagnostics({
  board,
  onOpenTask,
  refreshKey,
}: {
  board: string;
  onOpenTask: (taskId: string) => void;
  // String fingerprint of the board's status distribution (not just task count)
  // so status-only churn — a task entering a failure loop — refreshes the panel.
  refreshKey: string | number;
}) {
  const [items, setItems] = useState<DiagItem[]>([]);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = (await getClient()?.request("kanban.diagnostics", { board })) as
        | { items?: DiagItem[] }
        | undefined;
      setItems(res?.items ?? []);
    } catch {
      // Keep the last-known diagnostics on a transient failure rather than
      // blanking them — an empty panel must mean "healthy", not "fetch failed".
    }
  }, [board]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (items.length === 0) return null;

  const totalDiags = items.reduce((n, it) => n + it.diagnostics.length, 0);

  return (
    <div className="mx-6 mt-3 overflow-hidden rounded-xl border border-amber-400/25 bg-amber-400/[0.04]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <Stethoscope className="size-4 text-amber-300" />
          <span className="text-xs font-semibold text-amber-100">
            Perlu perhatian — {totalDiags} hal
          </span>
        </div>
        <ChevronDown className={cn("size-4 text-amber-300/60 transition", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-1.5 px-3 pb-3">
          {items.map((it) => (
            <div key={it.taskId} className="rounded-lg border border-white/[0.06] bg-[#0B0E14]/40 p-2">
              <button
                type="button"
                onClick={() => onOpenTask(it.taskId)}
                className="mb-1 block text-left text-xs font-medium text-white/85 hover:text-cyan-200"
              >
                {it.title}
              </button>
              <div className="space-y-1">
                {it.diagnostics.map((d, i) => {
                  const sev = SEV_META[d.severity] ?? SEV_META.info;
                  const Icon = sev.icon;
                  return (
                    <div key={i} className="flex items-start gap-1.5">
                      <Icon className={cn("mt-0.5 size-3 shrink-0", sev.cls)} />
                      <span className="text-[11px] text-white/65">
                        <span className={cn("font-medium", sev.cls)}>{d.title}</span>
                        {d.detail ? <span className="text-white/45"> — {d.detail}</span> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
